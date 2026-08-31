//! Pilotage de Docker, en local comme sur un serveur distant.
//!
//! Le module se contente d'exécuter le client `docker` et de rendre sa sortie
//! brute : tout le décodage se fait côté interface, où il est testable et
//! tolérant aux écarts entre versions de Docker.
//!
//! En local la commande est lancée sans shell (argv), à distance chaque
//! argument est cité. Dans les deux cas seule une liste fermée de
//! sous-commandes est acceptée.

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use tauri::State;

use crate::ssh::{exec_on_session, session_handle, shell_quote, FollowState, SshState};

/// Sous-commandes autorisées. Volontairement restreint à la consultation et au
/// cycle de vie des conteneurs : ni `run`, ni `build`, ni `exec`, qui ont leur
/// place dans un terminal où l'utilisateur voit ce qui se passe.
const ALLOWED: &[&str] = &[
    "ps", "images", "volume", "network", "stats", "logs", "inspect", "start", "stop", "restart",
    "pause", "unpause", "kill", "rm", "rmi", "top", "port", "version", "info", "compose", "system",
];

/// Emplacements où chercher le client Docker quand il n'est pas dans le PATH.
///
/// Une app packagée hérite d'un PATH minimal : sans cette recherche, Docker
/// serait « introuvable » alors qu'il fonctionne parfaitement dans un terminal.
const CANDIDATES: &[&str] = &[
    "/usr/local/bin/docker",
    "/opt/homebrew/bin/docker",
    "/usr/bin/docker",
    "/opt/local/bin/docker",
];

/// Chemins relatifs au dossier personnel (OrbStack, Docker Desktop récent).
const HOME_CANDIDATES: &[&str] = &[".docker/bin/docker", ".orbstack/bin/docker", ".rd/bin/docker"];

static LOCAL_BIN: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Localise le client Docker local, une fois pour toutes.
fn local_bin() -> Option<&'static PathBuf> {
    LOCAL_BIN
        .get_or_init(|| {
            if let Ok(path) = std::env::var("PATH") {
                for dir in std::env::split_paths(&path) {
                    let p = dir.join("docker");
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
            if let Some(home) = std::env::var_os("HOME") {
                for c in HOME_CANDIDATES {
                    let p = PathBuf::from(&home).join(c);
                    if p.is_file() {
                        return Some(p);
                    }
                }
            }
            None
        })
        .as_ref()
}

fn check_args(args: &[String]) -> Result<(), String> {
    let first = args.first().ok_or("Commande docker vide")?;
    if !ALLOWED.contains(&first.as_str()) {
        return Err(format!("Sous-commande docker non autorisée : {first}"));
    }
    Ok(())
}

/// Exécute le client Docker local, sans passer par un shell.
async fn run_local(args: &[String], timeout: Duration) -> Result<String, String> {
    let bin = local_bin().ok_or(
        "Client Docker introuvable sur cette machine (cherché dans le PATH, \
         /usr/local/bin, /opt/homebrew/bin, ~/.docker/bin et ~/.orbstack/bin).",
    )?;
    let out = tokio::time::timeout(
        timeout,
        tokio::process::Command::new(bin).args(args).output(),
    )
    .await
    .map_err(|_| "Docker ne répond pas (délai dépassé).".to_string())?
    .map_err(|e| format!("Exécution de docker impossible : {e}"))?;

    let stdout = String::from_utf8_lossy(&out.stdout).trim_end().to_string();
    if out.status.success() {
        return Ok(stdout);
    }
    // Un code de sortie non nul est toujours une erreur, même quand docker a
    // écrit quelque chose : `docker inspect` d'un conteneur absent imprime
    // « [] » sur stdout tout en sortant en erreur, et rendre ce « [] » ferait
    // passer une absence pour un résultat.
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("docker a échoué (code {:?})", out.status.code())
    })
}

/// Exécute le client Docker sur un serveur, chaque argument étant cité.
async fn run_remote(
    state: &State<'_, SshState>,
    id: &str,
    args: &[String],
    timeout: Duration,
    max_bytes: usize,
) -> Result<String, String> {
    let cmd = std::iter::once("docker".to_string())
        .chain(args.iter().map(|a| shell_quote(a)))
        .collect::<Vec<_>>()
        .join(" ");
    let (out, code) = exec_on_session(state, id, &cmd, timeout, max_bytes).await?;
    if code.unwrap_or(0) == 0 {
        return Ok(out);
    }
    let bas = out.to_lowercase();
    if bas.contains("command not found") || bas.contains("docker: not found") {
        return Err("Docker n'est pas installé sur ce serveur.".into());
    }
    if bas.contains("permission denied") || bas.contains("dial unix") {
        return Err(
            "Accès au démon Docker refusé : l'utilisateur n'est pas dans le groupe docker.".into(),
        );
    }
    if out.trim().is_empty() {
        return Err(format!("docker a échoué sur le serveur (code {code:?})"));
    }
    Err(out)
}

/// Exécute une commande docker sur la cible choisie et rend sa sortie brute.
///
/// `session` vaut None pour la machine locale, sinon l'identifiant d'une
/// session SSH ouverte.
#[tauri::command]
pub async fn docker_cli(
    state: State<'_, SshState>,
    session: Option<String>,
    args: Vec<String>,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    check_args(&args)?;
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(20).clamp(1, 120));
    match session {
        None => run_local(&args, timeout).await,
        Some(id) => run_remote(&state, &id, &args, timeout, 2 * 1024 * 1024).await,
    }
}

/// Docker répond-il sur cette cible ? Rend la version du démon.
#[tauri::command]
pub async fn docker_probe(
    state: State<'_, SshState>,
    session: Option<String>,
) -> Result<String, String> {
    let args = vec![
        "version".to_string(),
        "--format".to_string(),
        "{{.Server.Version}}".to_string(),
    ];
    let out = match session {
        None => run_local(&args, Duration::from_secs(10)).await?,
        Some(id) => run_remote(&state, &id, &args, Duration::from_secs(15), 8192).await?,
    };
    let v = out.trim();
    if v.is_empty() {
        return Err("Le démon Docker ne répond pas.".into());
    }
    Ok(v.to_string())
}

/// Suit les journaux d'un conteneur en direct.
///
/// Chaque bloc reçu part sous l'évènement « docker-log-<clé> », la fin sous
/// « docker-log-end-<clé> ». Le suivi s'arrête par `docker_logs_stop`, ou tout
/// seul si le conteneur s'éteint.
#[tauri::command]
pub async fn docker_logs_follow(
    app: tauri::AppHandle,
    ssh: State<'_, SshState>,
    follows: State<'_, FollowState>,
    session: Option<String>,
    key: String,
    container: String,
    tail: Option<u32>,
) -> Result<(), String> {
    let tail = tail.unwrap_or(200).min(5000);
    let args: Vec<String> = vec![
        "logs".into(),
        "--follow".into(),
        "--timestamps".into(),
        "--tail".into(),
        tail.to_string(),
        container,
    ];
    check_args(&args)?;

    let evt = format!("docker-log-{key}");
    let fin = format!("docker-log-end-{key}");
    let stop_rx = follows.register(key.clone()).await;

    match session {
        None => follow_local(app, args, evt, fin, key, stop_rx).await,
        Some(id) => follow_remote(app, &ssh, &id, &args, evt, fin, key, stop_rx).await,
    }
}

/// Arrête un suivi de journaux lancé par `docker_logs_follow`.
#[tauri::command]
pub async fn docker_logs_stop(
    follows: State<'_, FollowState>,
    key: String,
) -> Result<(), String> {
    crate::ssh::follow_stop(follows, key).await
}

/// Lance le client Docker en gardant ses sorties ouvertes, pour un flux continu.
///
/// Isolé de l'émission des évènements : c'est la partie qui dépend réellement
/// du système, et donc celle qu'un test peut exercer sans Tauri.
fn spawn_streaming(
    args: &[String],
) -> Result<
    (
        tokio::process::Child,
        tokio::process::ChildStdout,
        tokio::process::ChildStderr,
    ),
    String,
> {
    use std::process::Stdio;
    let bin = local_bin().ok_or("Client Docker introuvable sur cette machine.")?;
    let mut child = tokio::process::Command::new(bin)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Exécution de docker impossible : {e}"))?;
    // docker logs écrit sur stdout et stderr selon le flux du conteneur : les
    // deux comptent, on les fusionne dans l'ordre où ils arrivent.
    let out = child.stdout.take().ok_or("sortie standard indisponible")?;
    let err = child.stderr.take().ok_or("sortie d'erreur indisponible")?;
    Ok((child, out, err))
}

async fn follow_local(
    app: tauri::AppHandle,
    args: Vec<String>,
    evt: String,
    fin: String,
    key: String,
    mut stop_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    use tokio::io::AsyncReadExt;

    let (mut child, mut out, mut err) = spawn_streaming(&args)?;

    tokio::spawn(async move {
        let mut buf_out = [0u8; 8192];
        let mut buf_err = [0u8; 8192];
        loop {
            tokio::select! {
                n = out.read(&mut buf_out) => match n {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let _ = app.emit(&evt, String::from_utf8_lossy(&buf_out[..n]).to_string());
                    }
                },
                n = err.read(&mut buf_err) => match n {
                    Ok(0) | Err(_) => {}
                    Ok(n) => {
                        let _ = app.emit(&evt, String::from_utf8_lossy(&buf_err[..n]).to_string());
                    }
                },
                _ = stop_rx.changed() => break,
            }
        }
        let _ = child.kill().await;
        let _ = app.emit(&fin, ());
        app.state::<FollowState>().forget(&key).await;
    });
    Ok(())
}

async fn follow_remote(
    app: tauri::AppHandle,
    ssh: &State<'_, SshState>,
    id: &str,
    args: &[String],
    evt: String,
    fin: String,
    key: String,
    mut stop_rx: tokio::sync::watch::Receiver<bool>,
) -> Result<(), String> {
    use russh::ChannelMsg;
    use tauri::{Emitter, Manager};

    let handle = session_handle(ssh, id).await?;
    let cmd = std::iter::once("docker".to_string())
        .chain(args.iter().map(|a| shell_quote(a)))
        .collect::<Vec<_>>()
        .join(" ");
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel.exec(false, cmd).await.map_err(|e| e.to_string())?;

    tokio::spawn(async move {
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data })
                    | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = app.emit(&evt, String::from_utf8_lossy(&data).to_string());
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                },
                _ = stop_rx.changed() => break,
            }
        }
        let _ = channel.eof().await;
        let _ = app.emit(&fin, ());
        app.state::<FollowState>().forget(&key).await;
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuse_les_sous_commandes_hors_liste() {
        for interdit in ["run", "build", "exec", "cp", "login", "push", ""] {
            assert!(
                check_args(&[interdit.to_string()]).is_err(),
                "« {interdit} » devrait être refusé"
            );
        }
        assert!(check_args(&[]).is_err());
    }

    #[test]
    fn accepte_la_consultation_et_le_cycle_de_vie() {
        for permis in [
            "ps", "images", "logs", "inspect", "start", "stop", "rm", "stats",
        ] {
            assert!(
                check_args(&[permis.to_string()]).is_ok(),
                "« {permis} » devrait être accepté"
            );
        }
    }

    /// Vérifie la découverte du binaire et l'exécution réelle en local.
    /// Demande un Docker en marche sur la machine.
    #[tokio::test]
    #[ignore]
    async fn execute_docker_en_local() {
        let bin = local_bin().expect("client docker introuvable");
        assert!(bin.is_file(), "chemin retenu invalide : {bin:?}");

        let version = run_local(
            &[
                "version".into(),
                "--format".into(),
                "{{.Server.Version}}".into(),
            ],
            Duration::from_secs(10),
        )
        .await
        .expect("version du démon");
        assert!(
            version.chars().next().is_some_and(|c| c.is_ascii_digit()),
            "version inattendue : {version:?}"
        );

        let ps = run_local(
            &["ps".into(), "--format".into(), "{{json .}}".into()],
            Duration::from_secs(20),
        )
        .await
        .expect("liste des conteneurs");
        for ligne in ps.lines().filter(|l| !l.trim().is_empty()) {
            assert!(ligne.starts_with('{'), "ligne non JSON : {ligne}");
            assert!(ligne.contains("\"State\""), "champ State absent : {ligne}");
        }

        // Un conteneur inexistant doit remonter une erreur, pas une sortie vide.
        let err = run_local(
            &["inspect".into(), "cabestan-inexistant-xyz".into()],
            Duration::from_secs(10),
        )
        .await;
        assert!(err.is_err(), "l'inspection d'un conteneur absent doit échouer");
    }

    /// Le suivi en direct : le flux arrive bien au fil de l'eau et s'arrête
    /// quand on tue le processus. Demande un Docker en marche et le conteneur
    /// de test `cabestan-test-ssh`.
    #[tokio::test]
    #[ignore]
    async fn suit_les_journaux_en_direct() {
        use tokio::io::AsyncReadExt;

        let args: Vec<String> = [
            "logs",
            "--follow",
            "--timestamps",
            "--tail",
            "5",
            "cabestan-test-ssh",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        check_args(&args).expect("commande autorisée");

        let (mut child, mut out, mut err) = spawn_streaming(&args).expect("lancement");

        // L'historique demandé doit arriver sans qu'on ait à attendre la
        // prochaine ligne écrite par le conteneur.
        // Deux tampons : les deux sorties sont lues en parallèle.
        let mut buf_out = [0u8; 8192];
        let mut buf_err = [0u8; 8192];
        let mut recu = String::new();
        for _ in 0..3 {
            let lu = tokio::time::timeout(Duration::from_secs(5), async {
                tokio::select! {
                    n = out.read(&mut buf_out) => n.map(|n| (n, true)),
                    n = err.read(&mut buf_err) => n.map(|n| (n, false)),
                }
            })
            .await;
            match lu {
                Ok(Ok((0, _))) | Err(_) => break,
                Ok(Ok((n, sur_stdout))) => {
                    let src = if sur_stdout { &buf_out[..n] } else { &buf_err[..n] };
                    recu.push_str(&String::from_utf8_lossy(src));
                    if !recu.trim().is_empty() {
                        break;
                    }
                }
                Ok(Err(e)) => panic!("lecture impossible : {e}"),
            }
        }
        assert!(
            !recu.trim().is_empty(),
            "aucune ligne reçue du flux de journaux"
        );

        // Le processus tourne toujours : c'est bien un suivi, pas un one-shot.
        assert!(
            child.try_wait().expect("état du processus").is_none(),
            "docker logs --follow ne devrait pas s'être terminé"
        );

        // Et il se laisse arrêter.
        child.kill().await.expect("arrêt du suivi");
        let statut = tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .expect("le processus doit se terminer après kill");
        assert!(statut.is_ok());
    }

    /// La commande distante doit rester un mot par argument, quoi qu'on lui
    /// passe : c'est ce qui empêche un nom de conteneur d'être interprété.
    #[test]
    fn les_arguments_distants_sont_cites() {
        let args: Vec<String> = ["logs", "--tail", "100", "a b; rm -rf /", "l'apostrophe"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let cmd = std::iter::once("docker".to_string())
            .chain(args.iter().map(|a| shell_quote(a)))
            .collect::<Vec<_>>()
            .join(" ");
        assert_eq!(
            cmd,
            r"docker 'logs' '--tail' '100' 'a b; rm -rf /' 'l'\''apostrophe'"
        );
    }
}
