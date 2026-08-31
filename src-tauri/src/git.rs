//! Pilotage de Git, en local comme sur un serveur distant.
//!
//! Même philosophie que le module Docker : on exécute le client `git` et on
//! rend sa sortie brute, tout le décodage se fait côté interface où il est
//! testable. En local la commande est lancée sans shell (argv) dans le dossier
//! demandé, à distance chaque argument est cité derrière un `cd`.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use tauri::State;

use crate::ssh::{exec_on_session, shell_quote, SshState};

/// Sous-commandes autorisées. La consultation, l'index, le commit et les
/// échanges avec le dépôt distant ; ni `clean`, ni `reset --hard` (le seul
/// effacement passe par `restore`, visible et ciblé), ni la configuration.
const ALLOWED: &[&str] = &[
    "status",
    "log",
    "branch",
    "diff",
    "show",
    "add",
    "restore",
    "commit",
    "pull",
    "push",
    "fetch",
    "stash",
    "rev-parse",
    "switch",
    "remote",
];

/// Emplacements où chercher le client Git quand il n'est pas dans le PATH
/// (une app packagée hérite d'un PATH minimal).
const CANDIDATES: &[&str] = &[
    "/usr/bin/git",
    "/usr/local/bin/git",
    "/opt/homebrew/bin/git",
    "/opt/local/bin/git",
];

static LOCAL_BIN: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Localise le client Git local, une fois pour toutes.
fn local_bin() -> Option<&'static PathBuf> {
    LOCAL_BIN
        .get_or_init(|| {
            if let Ok(path) = std::env::var("PATH") {
                for dir in std::env::split_paths(&path) {
                    let p = dir.join("git");
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
            for c in CANDIDATES {
                let p = PathBuf::from(c);
                if p.is_file() {
                    return Some(p);
                }
            }
            None
        })
        .as_ref()
}

fn check_args(args: &[String]) -> Result<(), String> {
    let first = args.first().ok_or("Commande git vide")?;
    if !ALLOWED.contains(&first.as_str()) {
        return Err(format!("Sous-commande git non autorisée : {first}"));
    }
    Ok(())
}

/// Rend les erreurs Git les plus courantes dans la langue de l'app.
fn translate(out: &str) -> Option<String> {
    let bas = out.to_lowercase();
    if bas.contains("not a git repository") {
        return Some("Ce dossier n'est pas un dépôt Git.".into());
    }
    if bas.contains("command not found") || bas.contains("git: not found") {
        return Some("Git n'est pas installé sur ce serveur.".into());
    }
    None
}

/// Exécute le client Git local, sans passer par un shell.
async fn run_local(cwd: &str, args: &[String], timeout: Duration) -> Result<String, String> {
    let bin = local_bin().ok_or(
        "Client Git introuvable sur cette machine (cherché dans le PATH, \
         /usr/bin, /usr/local/bin et /opt/homebrew/bin).",
    )?;
    if !PathBuf::from(cwd).is_dir() {
        return Err(format!("Dossier introuvable : {cwd}"));
    }
    let out = tokio::time::timeout(
        timeout,
        tokio::process::Command::new(bin)
            .args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            // Sortie en anglais quel que soit le poste : c'est elle qu'on
            // décode ; `translate` remet les cas courants en français.
            .env("LC_ALL", "C")
            .output(),
    )
    .await
    .map_err(|_| "Git ne répond pas (délai dépassé).".to_string())?
    .map_err(|e| format!("Exécution de git impossible : {e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout).trim_end().to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let brut = if !stderr.is_empty() { stderr } else { stdout };
    if let Some(msg) = translate(&brut) {
        return Err(msg);
    }
    Err(if brut.is_empty() {
        format!("git a échoué (code {:?})", out.status.code())
    } else {
        brut
    })
}

/// Exécute le client Git sur un serveur, chaque argument étant cité.
async fn run_remote(
    state: &State<'_, SshState>,
    id: &str,
    cwd: &str,
    args: &[String],
    timeout: Duration,
) -> Result<String, String> {
    let cmd = format!(
        "cd {} && LC_ALL=C GIT_TERMINAL_PROMPT=0 git {}",
        shell_quote(cwd),
        args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ")
    );
    let (out, code) = exec_on_session(state, id, &cmd, timeout, 2 * 1024 * 1024).await?;
    if code.unwrap_or(0) == 0 {
        return Ok(out);
    }
    if let Some(msg) = translate(&out) {
        return Err(msg);
    }
    if out.trim().is_empty() {
        return Err(format!("git a échoué sur le serveur (code {code:?})"));
    }
    Err(out)
}

/// Exécute une commande git dans un dossier de la cible choisie et rend sa
/// sortie brute. `session` vaut None pour la machine locale, sinon
/// l'identifiant d'une session SSH ouverte.
#[tauri::command]
pub async fn git_cli(
    state: State<'_, SshState>,
    session: Option<String>,
    cwd: String,
    args: Vec<String>,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    check_args(&args)?;
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(20).clamp(1, 300));
    match session {
        None => run_local(&cwd, &args, timeout).await,
        Some(id) => run_remote(&state, &id, &cwd, &args, timeout).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuse_les_sous_commandes_hors_liste() {
        for interdit in ["clean", "reset", "config", "init", "clone", "gc", ""] {
            assert!(
                check_args(&[interdit.to_string()]).is_err(),
                "« {interdit} » devrait être refusé"
            );
        }
        assert!(check_args(&[]).is_err());
    }

    #[test]
    fn accepte_la_consultation_et_le_cycle_courant() {
        for permis in [
            "status", "log", "branch", "diff", "add", "commit", "pull", "push", "switch",
        ] {
            assert!(
                check_args(&[permis.to_string()]).is_ok(),
                "« {permis} » devrait être accepté"
            );
        }
    }

    /// La commande distante doit rester un mot par argument : c'est ce qui
    /// empêche un message de commit d'être interprété par le shell.
    #[test]
    fn les_arguments_distants_sont_cites() {
        let args: Vec<String> = ["commit", "-m", "fix: l'apostrophe ; rm -rf /"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let cmd = format!(
            "cd {} && LC_ALL=C GIT_TERMINAL_PROMPT=0 git {}",
            shell_quote("/srv/mon app"),
            args.iter().map(|a| shell_quote(a)).collect::<Vec<_>>().join(" ")
        );
        assert_eq!(
            cmd,
            r"cd '/srv/mon app' && LC_ALL=C GIT_TERMINAL_PROMPT=0 git 'commit' '-m' 'fix: l'\''apostrophe ; rm -rf /'"
        );
    }

    #[test]
    fn traduit_les_erreurs_courantes() {
        assert!(translate("fatal: not a git repository (or any parent)")
            .unwrap()
            .contains("dépôt Git"));
        assert!(translate("bash: git: command not found")
            .unwrap()
            .contains("installé"));
        assert!(translate("error: pathspec inconnue").is_none());
    }

    /// Vérifie la découverte du binaire et l'exécution réelle en local.
    #[tokio::test]
    #[ignore]
    async fn execute_git_en_local() {
        let bin = local_bin().expect("client git introuvable");
        assert!(bin.is_file(), "chemin retenu invalide : {bin:?}");
        let out = run_local(
            env!("CARGO_MANIFEST_DIR"),
            &["rev-parse".into(), "--is-inside-work-tree".into()],
            Duration::from_secs(10),
        )
        .await;
        // Selon que le projet est vraiment sous git ou non, mais jamais un panic.
        match out {
            Ok(v) => assert_eq!(v, "true"),
            Err(e) => assert!(e.contains("dépôt Git"), "erreur inattendue : {e}"),
        }
    }
}
