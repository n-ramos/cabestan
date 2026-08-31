use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::Engine;
use russh::client::{self, AuthResult, Handle};
use russh::keys::known_hosts::{check_known_hosts, learn_known_hosts};
use russh::keys::{
    load_secret_key, HashAlg, PrivateKeyWithHashAlg, PublicKey, PublicKeyOrCertificate,
};
use russh::ChannelMsg;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, Mutex};

// ---------- Types ----------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectOptions {
    pub host: String,
    pub port: Option<u16>,
    pub username: String,
    pub password: Option<String>,
    pub key_path: Option<String>,
    pub key_passphrase: Option<String>,
    /// Authentification via ssh-agent (SSH_AUTH_SOCK).
    pub use_agent: Option<bool>,
    /// Rebond par bastion : "user@host:port" (ProxyJump). Plusieurs sauts séparés par des virgules.
    pub jump: Option<String>,
    /// Fingerprint ("SHA256:…") que l'utilisateur a explicitement accepté,
    /// après un avertissement clé inconnue / clé changée.
    pub trust_fingerprint: Option<String>,
    /// Empreintes acceptées pour les bastions traversés (ProxyJump).
    pub trust_jump: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub home_dir: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_link: bool,
    pub size: u64,
    pub mtime: Option<u32>,
    pub permissions: Option<u32>,
    pub user: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub session_id: String,
    pub transfer_id: String,
    pub file_name: String,
    pub transferred: u64,
    pub total: u64,
    pub direction: String, // "upload" | "download"
    pub done: bool,
    pub cancelled: bool,
}

enum ShellCmd {
    Data(Vec<u8>),
    Resize(u32, u32),
    Close,
}

struct Session {
    // Arc : les tunnels gardent une référence au porteur de la connexion.
    handle: Arc<Handle<ClientHandler>>,
    /// Table partagée avec le handler : port distant → cible locale (-R).
    remote_forwards: Arc<std::sync::Mutex<HashMap<u32, String>>>,
    // Arc so commands can clone it and release the sessions lock during
    // network operations (a long transfer must not block the shell).
    sftp: Arc<SftpSession>,
    // Un shell par panneau de terminal (splits façon tmux).
    shells: HashMap<String, mpsc::UnboundedSender<ShellCmd>>,
}

#[derive(Default)]
pub struct SshState {
    sessions: Mutex<HashMap<String, Session>>,
    transfers: Mutex<HashMap<String, Arc<AtomicBool>>>,
    edits: Mutex<std::collections::HashSet<String>>,
    tunnels: Mutex<HashMap<String, TunnelHandle>>,
    counter: AtomicU64,
}

// ---------- Vérification de la clé d'hôte (TOFU, ~/.ssh/known_hosts) ----------

pub(crate) struct ClientHandler {
    host: String,
    port: u16,
    /// Empreintes explicitement acceptées par l'utilisateur pour cet hôte.
    trusted: Vec<String>,
    // Raison du refus, relue par connect_inner quand la connexion échoue.
    rejection: Arc<std::sync::Mutex<Option<String>>>,
    /// Redirections distantes actives : port distant → cible locale "host:port".
    remote_forwards: Arc<std::sync::Mutex<HashMap<u32, String>>>,
}

fn fingerprint_of(key: &PublicKey) -> (String, String) {
    (
        key.algorithm().to_string(),
        key.fingerprint(russh::keys::ssh_key::HashAlg::Sha256).to_string(),
    )
}

fn remove_known_hosts_line(line: usize) -> std::io::Result<()> {
    let home = std::env::var("HOME")
        .map_err(|_| std::io::Error::other("HOME introuvable"))?;
    let path = PathBuf::from(home).join(".ssh").join("known_hosts");
    let content = std::fs::read_to_string(&path)?;
    let kept: String = content
        .lines()
        .enumerate()
        .filter(|(i, _)| i + 1 != line)
        .map(|(_, l)| format!("{l}\n"))
        .collect();
    std::fs::write(path, kept)
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    /// Connexion entrante sur un port distant redirigé (ssh -R) : on la
    /// raccorde au service local correspondant.
    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: russh::Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let target = {
            let map = self.remote_forwards.lock().unwrap();
            map.get(&connected_port).or_else(|| map.get(&0)).cloned()
        };
        let _ = connected_address;
        match target {
            Some(target) => {
                // Sans accept() explicite, le canal serait refusé au drop.
                reply.accept().await;
                tokio::spawn(async move {
                    match tokio::net::TcpStream::connect(&target).await {
                        Ok(mut local) => {
                            let mut stream = channel.into_stream();
                            let _ = tokio::io::copy_bidirectional(&mut local, &mut stream).await;
                        }
                        Err(_) => {
                            let _ = channel.eof().await;
                        }
                    }
                });
            }
            None => {
                reply
                    .reject(russh::ChannelOpenFailure::AdministrativelyProhibited)
                    .await;
            }
        }
        Ok(())
    }

    async fn check_server_key(
        &mut self,
        server_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let key: PublicKey = match server_key {
            PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            PublicKeyOrCertificate::Certificate(cert) => {
                PublicKey::new(cert.public_key().clone(), "")
            }
        };
        let (algo, fp) = fingerprint_of(&key);
        let trusted = self.trusted.iter().any(|t| t == &fp);
        // L'hôte est cité pour que l'interface sache de quel maillon il s'agit.
        let origin = format!("{}:{}", self.host, self.port);

        match check_known_hosts(&self.host, self.port, &key) {
            Ok(true) => Ok(true),
            Err(russh::keys::Error::KeyChanged { line }) => {
                if trusted {
                    let _ = remove_known_hosts_line(line);
                    let _ = learn_known_hosts(&self.host, self.port, &key);
                    Ok(true)
                } else {
                    *self.rejection.lock().unwrap() =
                        Some(format!("HOST_KEY_CHANGED|{algo}|{fp}|{origin}"));
                    Ok(false)
                }
            }
            // Ok(false) = hôte inconnu ; toute autre erreur de lecture du fichier
            // est traitée pareil : on exige une confirmation explicite.
            _ => {
                if trusted {
                    let _ = learn_known_hosts(&self.host, self.port, &key);
                    Ok(true)
                } else {
                    *self.rejection.lock().unwrap() =
                        Some(format!("UNKNOWN_HOST_KEY|{algo}|{fp}|{origin}"));
                    Ok(false)
                }
            }
        }
    }
}

// ---------- Rebond par bastion (ProxyJump) ----------

#[derive(Debug, Clone)]
struct Hop {
    user: Option<String>,
    host: String,
    port: u16,
}

/// Parse "user@host:port" ; l'utilisateur et le port sont facultatifs.
fn parse_hop(spec: &str) -> Option<Hop> {
    let spec = spec.trim();
    if spec.is_empty() {
        return None;
    }
    let (user, rest) = match spec.rsplit_once('@') {
        Some((u, r)) => (Some(u.to_string()), r),
        None => (None, spec),
    };
    // Adresse IPv6 entre crochets : [::1]:22
    let (host, port) = if let Some(stripped) = rest.strip_prefix('[') {
        match stripped.split_once(']') {
            Some((h, tail)) => (
                h.to_string(),
                tail.strip_prefix(':').and_then(|p| p.parse().ok()).unwrap_or(22),
            ),
            None => return None,
        }
    } else {
        match rest.rsplit_once(':') {
            Some((h, p)) if p.chars().all(|c| c.is_ascii_digit()) && !p.is_empty() => {
                (h.to_string(), p.parse().unwrap_or(22))
            }
            _ => (rest.to_string(), 22),
        }
    };
    if host.is_empty() {
        return None;
    }
    Some(Hop { user, host, port })
}

// ---------- Helpers ----------

fn ssh_config() -> Arc<client::Config> {
    Arc::new(client::Config {
        // Ping toutes les 15 s ; 3 pings sans réponse → connexion déclarée morte,
        // les canaux se ferment et l'UI propose de se reconnecter.
        keepalive_interval: Some(Duration::from_secs(15)),
        keepalive_max: 3,
        ..Default::default()
    })
}

/// Traverse la chaîne de bastions et renvoie un flux TCP tunnelé jusqu'à la
/// cible. Chaque bastion est authentifié par agent ou par clé.
async fn open_through_jumps(
    jumps: &[Hop],
    target_host: &str,
    target_port: u16,
    opts: &ConnectOptions,
) -> anyhow::Result<russh::ChannelStream<client::Msg>> {
    let mut current: Option<Handle<ClientHandler>> = None;
    for (i, hop) in jumps.iter().enumerate() {
        let rejection = Arc::new(std::sync::Mutex::new(None));
        let handler = ClientHandler {
            host: hop.host.clone(),
            port: hop.port,
            // Le bastion accepte les empreintes que l'utilisateur a validées ;
            // sinon son empreinte est remontée telle quelle à l'interface.
            trusted: opts.trust_jump.clone().unwrap_or_default(),
            rejection: rejection.clone(),
            remote_forwards: Arc::new(std::sync::Mutex::new(HashMap::new())),
        };
        let mut handle = match &current {
            None => client::connect(ssh_config(), (hop.host.as_str(), hop.port), handler)
                .await
                .map_err(|e| match rejection.lock().unwrap().take() {
                    // Le marqueur est transmis intact : l'interface affiche le
                    // panneau d'empreinte, en nommant le bastion concerné.
                    Some(r) => anyhow::anyhow!(r),
                    None => anyhow::anyhow!("Bastion {} : {e}", hop.host),
                })?,
            Some(prev) => {
                let channel = prev
                    .channel_open_direct_tcpip(hop.host.clone(), hop.port as u32, "127.0.0.1", 0)
                    .await
                    .map_err(|e| anyhow::anyhow!("Rebond vers {} : {e}", hop.host))?;
                client::connect_stream(ssh_config(), channel.into_stream(), handler)
                    .await
                    .map_err(|e| match rejection.lock().unwrap().take() {
                        Some(r) => anyhow::anyhow!(r),
                        None => anyhow::anyhow!("Bastion {} : {e}", hop.host),
                    })?
            }
        };

        // Authentification du bastion : agent d'abord, puis la clé fournie.
        let user = hop
            .user
            .clone()
            .unwrap_or_else(|| opts.username.clone());
        let mut ok = false;
        if let Ok(mut agent) = russh::keys::agent::client::AgentClient::connect_env().await {
            if let Ok(ids) = agent.request_identities().await {
                let best: Option<HashAlg> = handle.best_supported_rsa_hash().await?.flatten();
                for identity in ids {
                    let key = identity.public_key().into_owned();
                    let hash = if key.algorithm().is_rsa() { best } else { None };
                    if let Ok(AuthResult::Success) = handle
                        .authenticate_publickey_with(user.clone(), key, hash, &mut agent)
                        .await
                    {
                        ok = true;
                        break;
                    }
                }
            }
        }
        if !ok {
            if let Some(key_path) = opts.key_path.as_deref().filter(|p| !p.is_empty()) {
                let key = load_secret_key(
                    expand_tilde(key_path),
                    opts.key_passphrase.as_deref().filter(|p| !p.is_empty()),
                )?;
                let best: Option<HashAlg> = handle.best_supported_rsa_hash().await?.flatten();
                if handle
                    .authenticate_publickey(
                        user.clone(),
                        PrivateKeyWithHashAlg::new(Arc::new(key), best),
                    )
                    .await?
                    .success()
                {
                    ok = true;
                }
            }
        }
        if !ok {
            anyhow::bail!(
                "Authentification refusée par le bastion {} (agent SSH ou clé requis)",
                hop.host
            );
        }

        let _ = i;
        current = Some(handle);
    }

    let last = current.expect("au moins un bastion");
    let channel = last
        .channel_open_direct_tcpip(target_host.to_string(), target_port as u32, "127.0.0.1", 0)
        .await
        .map_err(|e| anyhow::anyhow!("Ouverture vers {target_host}:{target_port} : {e}"))?;
    // Le Handle du dernier bastion doit vivre aussi longtemps que le flux :
    // on le confie au canal en le laissant fuir volontairement.
    std::mem::forget(last);
    Ok(channel.into_stream())
}

type ConnectResult = (
    Handle<ClientHandler>,
    Arc<std::sync::Mutex<HashMap<u32, String>>>,
);

async fn connect_inner(opts: &ConnectOptions) -> anyhow::Result<ConnectResult> {
    let config = ssh_config();
    let port = opts.port.unwrap_or(22);
    let rejection = Arc::new(std::sync::Mutex::new(None));
    let remote_forwards = Arc::new(std::sync::Mutex::new(HashMap::new()));
    let handler = ClientHandler {
        host: opts.host.clone(),
        port,
        trusted: opts.trust_fingerprint.clone().into_iter().collect(),
        rejection: rejection.clone(),
        remote_forwards: remote_forwards.clone(),
    };

    let jumps: Vec<Hop> = opts
        .jump
        .as_deref()
        .unwrap_or("")
        .split(',')
        .filter_map(parse_hop)
        .collect();

    let mut handle = if jumps.is_empty() {
        match client::connect(config, (opts.host.as_str(), port), handler).await {
            Ok(h) => h,
            Err(e) => {
                if let Some(reason) = rejection.lock().unwrap().take() {
                    anyhow::bail!(reason);
                }
                return Err(e.into());
            }
        }
    } else {
        let stream = open_through_jumps(&jumps, &opts.host, port, opts).await?;
        match client::connect_stream(config, stream, handler).await {
            Ok(h) => h,
            Err(e) => {
                if let Some(reason) = rejection.lock().unwrap().take() {
                    anyhow::bail!(reason);
                }
                return Err(e.into());
            }
        }
    };

    let auth = if opts.use_agent.unwrap_or(false) {
        let mut agent = russh::keys::agent::client::AgentClient::connect_env()
            .await
            .map_err(|e| anyhow::anyhow!("Agent SSH injoignable (SSH_AUTH_SOCK) : {e}"))?;
        let identities = agent
            .request_identities()
            .await
            .map_err(|e| anyhow::anyhow!("Lecture des clés de l'agent : {e}"))?;
        if identities.is_empty() {
            anyhow::bail!("L'agent SSH ne contient aucune clé (ajoutez-en une avec ssh-add)");
        }
        let best: Option<HashAlg> = handle.best_supported_rsa_hash().await?.flatten();
        let mut result = AuthResult::Failure {
            remaining_methods: russh::MethodSet::empty(),
            partial_success: false,
        };
        for identity in identities {
            let key = identity.public_key().into_owned();
            let hash = if key.algorithm().is_rsa() { best } else { None };
            match handle
                .authenticate_publickey_with(opts.username.clone(), key, hash, &mut agent)
                .await
            {
                Ok(AuthResult::Success) => {
                    result = AuthResult::Success;
                    break;
                }
                Ok(f @ AuthResult::Failure { .. }) => result = f,
                Err(e) => {
                    anyhow::bail!("Signature via l'agent : {e}");
                }
            }
        }
        result
    } else if let Some(key_path) = opts.key_path.as_deref().filter(|p| !p.is_empty()) {
        let key = load_secret_key(
            expand_tilde(key_path),
            opts.key_passphrase.as_deref().filter(|p| !p.is_empty()),
        )?;
        let best: Option<HashAlg> = handle.best_supported_rsa_hash().await?.flatten();
        handle
            .authenticate_publickey(
                opts.username.clone(),
                PrivateKeyWithHashAlg::new(Arc::new(key), best),
            )
            .await?
    } else if let Some(password) = opts.password.as_deref() {
        handle
            .authenticate_password(opts.username.clone(), password)
            .await?
    } else {
        anyhow::bail!("Aucune méthode d'authentification fournie (mot de passe ou clé)");
    };

    match auth {
        AuthResult::Success => Ok((handle, remote_forwards)),
        AuthResult::Failure { .. } => anyhow::bail!("Authentification refusée par le serveur"),
    }
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Ok(home) = std::env::var("HOME") {
            return format!("{}/{}", home, rest);
        }
    }
    path.to_string()
}

async fn open_sftp(handle: &Handle<ClientHandler>) -> anyhow::Result<SftpSession> {
    let channel = handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    Ok(SftpSession::new(channel.into_stream()).await?)
}

fn join_path(dir: &str, name: &str) -> String {
    if dir.ends_with('/') {
        format!("{}{}", dir, name)
    } else {
        format!("{}/{}", dir, name)
    }
}

async fn get_sftp(state: &State<'_, SshState>, id: &str) -> Result<Arc<SftpSession>, String> {
    let sessions = state.sessions.lock().await;
    Ok(sessions.get(id).ok_or("Session inconnue")?.sftp.clone())
}

/// Parcourt un dossier distant : (fichiers avec taille, dossiers racine comprise).
/// Les liens symboliques sont ignorés pour éviter les boucles.
async fn walk_remote(
    sftp: &SftpSession,
    root: &str,
) -> Result<(Vec<(String, u64)>, Vec<String>), String> {
    let mut files: Vec<(String, u64)> = Vec::new();
    let mut dirs: Vec<String> = vec![root.to_string()];
    let mut stack: Vec<String> = vec![root.to_string()];
    while let Some(dir) = stack.pop() {
        let entries = sftp.read_dir(dir.clone()).await.map_err(|e| e.to_string())?;
        for entry in entries {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let meta = entry.metadata();
            let p = join_path(&dir, &name);
            if meta.is_symlink() {
                continue;
            }
            if meta.is_dir() {
                dirs.push(p.clone());
                stack.push(p);
            } else {
                files.push((p, meta.size.unwrap_or(0)));
            }
        }
    }
    Ok((files, dirs))
}

fn walk_local(root: &Path) -> std::io::Result<(Vec<(PathBuf, u64)>, Vec<PathBuf>)> {
    let mut files = Vec::new();
    let mut dirs = vec![root.to_path_buf()];
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir)? {
            let entry = entry?;
            let ft = entry.file_type()?;
            let p = entry.path();
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                dirs.push(p.clone());
                stack.push(p);
            } else if ft.is_file() {
                files.push((p, entry.metadata()?.len()));
            }
        }
    }
    Ok((files, dirs))
}

async fn remove_remote_recursive(sftp: &SftpSession, root: &str) -> Result<(), String> {
    let (files, mut dirs) = walk_remote(sftp, root).await?;
    for (f, _) in files {
        sftp.remove_file(f).await.map_err(|e| e.to_string())?;
    }
    // Les liens symboliques (ignorés par walk_remote) restent : on les retire
    // dossier par dossier, du plus profond au moins profond.
    dirs.sort_by_key(|d| std::cmp::Reverse(d.matches('/').count()));
    for d in dirs {
        if let Ok(entries) = sftp.read_dir(d.clone()).await {
            for entry in entries {
                let name = entry.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let _ = sftp.remove_file(join_path(&d, &name)).await;
            }
        }
        sftp.remove_dir(d).await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

// ---------- Contexte de transfert (progression + annulation) ----------

const CHUNK: usize = 64 * 1024;
const EMIT_EVERY: Duration = Duration::from_millis(60);

enum Outcome {
    Done,
    Cancelled,
}

struct TransferCtx<R: tauri::Runtime> {
    app: AppHandle<R>,
    session_id: String,
    transfer_id: String,
    direction: &'static str,
    total: u64,
    transferred: u64,
    cancel: Arc<AtomicBool>,
    last_emit: Instant,
    resume: bool,
    /// Octets déjà présents avant reprise (pour l'affichage).
    resumed_from: u64,
}

impl<R: tauri::Runtime> TransferCtx<R> {
    fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    fn emit(&mut self, file_name: &str, done: bool, cancelled: bool) {
        if !done && !cancelled && self.last_emit.elapsed() < EMIT_EVERY {
            return;
        }
        self.last_emit = Instant::now();
        let _ = self.app.emit(
            "transfer-progress",
            TransferProgress {
                session_id: self.session_id.clone(),
                transfer_id: self.transfer_id.clone(),
                file_name: file_name.to_string(),
                transferred: self.transferred,
                total: self.total,
                direction: self.direction.into(),
                done,
                cancelled,
            },
        );
    }
}

async fn download_one<R: tauri::Runtime>(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    label: &str,
    ctx: &mut TransferCtx<R>,
) -> Result<Outcome, String> {
    use tokio::io::{AsyncSeekExt, SeekFrom};
    let mut src = sftp.open(remote.to_string()).await.map_err(|e| e.to_string())?;

    // Reprise : si un fichier local partiel existe et que la reprise est
    // demandée, on repart de son offset au lieu de tout retélécharger.
    let already = if ctx.resume {
        tokio::fs::metadata(local).await.map(|m| m.len()).unwrap_or(0)
    } else {
        0
    };
    let mut dst = if already > 0 {
        src.seek(SeekFrom::Start(already))
            .await
            .map_err(|e| e.to_string())?;
        ctx.transferred += already;
        ctx.resumed_from += already;
        tokio::fs::OpenOptions::new()
            .append(true)
            .open(local)
            .await
            .map_err(|e| e.to_string())?
    } else {
        tokio::fs::File::create(local).await.map_err(|e| e.to_string())?
    };
    let mut buf = vec![0u8; CHUNK];
    loop {
        if ctx.cancelled() {
            drop(dst);
            // Le fichier partiel est conservé : il sert de point de reprise.
            return Ok(Outcome::Cancelled);
        }
        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        ctx.transferred += n as u64;
        ctx.emit(label, false, false);
    }
    dst.flush().await.map_err(|e| e.to_string())?;
    Ok(Outcome::Done)
}

async fn upload_one<R: tauri::Runtime>(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    label: &str,
    ctx: &mut TransferCtx<R>,
) -> Result<Outcome, String> {
    use russh_sftp::protocol::OpenFlags;
    use tokio::io::{AsyncSeekExt, SeekFrom};
    let mut src = tokio::fs::File::open(local).await.map_err(|e| e.to_string())?;

    // Reprise : on reprend après ce que le serveur a déjà reçu.
    let already = if ctx.resume {
        sftp.metadata(remote.to_string())
            .await
            .ok()
            .and_then(|m| m.size)
            .unwrap_or(0)
    } else {
        0
    };
    let mut dst = if already > 0 {
        src.seek(SeekFrom::Start(already))
            .await
            .map_err(|e| e.to_string())?;
        ctx.transferred += already;
        ctx.resumed_from += already;
        let mut f = sftp
            .open_with_flags(remote.to_string(), OpenFlags::WRITE | OpenFlags::APPEND)
            .await
            .map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(already)).await.map_err(|e| e.to_string())?;
        f
    } else {
        sftp.create(remote.to_string()).await.map_err(|e| e.to_string())?
    };
    let mut buf = vec![0u8; CHUNK];
    loop {
        if ctx.cancelled() {
            let _ = dst.flush().await;
            let _ = dst.shutdown().await;
            // Le fichier distant partiel est conservé pour la reprise.
            return Ok(Outcome::Cancelled);
        }
        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        ctx.transferred += n as u64;
        ctx.emit(label, false, false);
    }
    dst.flush().await.map_err(|e| e.to_string())?;
    dst.shutdown().await.map_err(|e| e.to_string())?;
    Ok(Outcome::Done)
}

fn base_name(path: &str) -> String {
    path.trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or(path)
        .to_string()
}

// ---------- Commandes : session ----------

#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, SshState>,
    opts: ConnectOptions,
) -> Result<SessionInfo, String> {
    let (handle, remote_forwards) = connect_inner(&opts).await.map_err(|e| e.to_string())?;
    let sftp = open_sftp(&handle).await.map_err(|e| e.to_string())?;
    let home_dir = sftp
        .canonicalize(".")
        .await
        .unwrap_or_else(|_| "/".to_string());

    let n = state.counter.fetch_add(1, Ordering::SeqCst);
    let id = format!("s{}", n);

    state.sessions.lock().await.insert(
        id.clone(),
        Session {
            handle: Arc::new(handle),
            remote_forwards,
            sftp: Arc::new(sftp),
            shells: HashMap::new(),
        },
    );

    Ok(SessionInfo { id, home_dir })
}

#[tauri::command]
pub async fn ssh_disconnect(state: State<'_, SshState>, id: String) -> Result<(), String> {
    if let Some(session) = state.sessions.lock().await.remove(&id) {
        for tx in session.shells.values() {
            let _ = tx.send(ShellCmd::Close);
        }
        let _ = session.sftp.close().await;
        let _ = session
            .handle
            .disconnect(russh::Disconnect::ByApplication, "", "")
            .await;
    }
    Ok(())
}

// ---------- Commandes : SFTP ----------

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, SshState>,
    id: String,
    path: String,
) -> Result<Vec<FileEntry>, String> {
    let sftp = get_sftp(&state, &id).await?;
    let entries = sftp
        .read_dir(path.clone())
        .await
        .map_err(|e| e.to_string())?;

    let mut out: Vec<FileEntry> = Vec::new();
    for entry in entries {
        let name = entry.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = entry.metadata();
        out.push(FileEntry {
            path: join_path(&path, &name),
            is_dir: meta.is_dir(),
            is_link: meta.is_symlink(),
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime,
            permissions: meta.permissions,
            user: meta.user.clone(),
            group: meta.group.clone(),
            name,
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, SshState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let sftp = get_sftp(&state, &id).await?;
    sftp.create_dir(path).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, SshState>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let sftp = get_sftp(&state, &id).await?;
    if is_dir {
        remove_remote_recursive(&sftp, &path).await
    } else {
        sftp.remove_file(path).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub async fn sftp_chmod(
    state: State<'_, SshState>,
    id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let sftp = get_sftp(&state, &id).await?;
    let mut attrs = russh_sftp::protocol::FileAttributes::empty();
    attrs.permissions = Some(mode & 0o7777);
    sftp.set_metadata(path, attrs).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, SshState>,
    id: String,
    from: String,
    to: String,
) -> Result<(), String> {
    let sftp = get_sftp(&state, &id).await?;
    sftp.rename(from, to).await.map_err(|e| e.to_string())
}

// ---------- Commandes : transferts ----------

#[tauri::command]
pub async fn transfer_cancel(state: State<'_, SshState>, transfer_id: String) -> Result<(), String> {
    if let Some(flag) = state.transfers.lock().await.get(&transfer_id) {
        flag.store(true, Ordering::Relaxed);
    }
    Ok(())
}

async fn register_cancel(state: &State<'_, SshState>, transfer_id: &str) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    state
        .transfers
        .lock()
        .await
        .insert(transfer_id.to_string(), flag.clone());
    flag
}

async fn unregister_cancel(state: &State<'_, SshState>, transfer_id: &str) {
    state.transfers.lock().await.remove(transfer_id);
}

#[tauri::command]
pub async fn sftp_download(
    app: AppHandle,
    state: State<'_, SshState>,
    id: String,
    transfer_id: String,
    remote_path: String,
    local_path: String,
    resume: Option<bool>,
) -> Result<(), String> {
    let sftp = get_sftp(&state, &id).await?;
    let cancel = register_cancel(&state, &transfer_id).await;
    let result = download_inner(
        &app, &sftp, &id, &transfer_id, &remote_path, &local_path, cancel,
        resume.unwrap_or(false),
    )
    .await;
    unregister_cancel(&state, &transfer_id).await;
    result
}

async fn download_inner<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sftp: &SftpSession,
    id: &str,
    transfer_id: &str,
    remote_path: &str,
    local_path: &str,
    cancel: Arc<AtomicBool>,
    resume: bool,
) -> Result<(), String> {
    let label = base_name(remote_path);
    let meta = sftp
        .metadata(remote_path.to_string())
        .await
        .map_err(|e| e.to_string())?;

    let mut ctx = TransferCtx {
        app: app.clone(),
        session_id: id.to_string(),
        transfer_id: transfer_id.to_string(),
        direction: "download",
        total: 0,
        transferred: 0,
        cancel,
        last_emit: Instant::now(),
        resume,
        resumed_from: 0,
    };

    let outcome = if meta.is_dir() {
        let (files, dirs) = walk_remote(sftp, remote_path).await?;
        ctx.total = files.iter().map(|(_, s)| s).sum();
        let root = remote_path.trim_end_matches('/');
        for d in &dirs {
            let rel = d.strip_prefix(root).unwrap_or("").trim_start_matches('/');
            let target = Path::new(local_path).join(rel);
            tokio::fs::create_dir_all(&target)
                .await
                .map_err(|e| e.to_string())?;
        }
        let mut outcome = Outcome::Done;
        for (f, _) in &files {
            let rel = f.strip_prefix(root).unwrap_or(f).trim_start_matches('/');
            let target = Path::new(local_path).join(rel);
            match download_one(sftp, f, &target, &base_name(f), &mut ctx).await? {
                Outcome::Cancelled => {
                    outcome = Outcome::Cancelled;
                    break;
                }
                Outcome::Done => {}
            }
        }
        outcome
    } else {
        ctx.total = meta.size.unwrap_or(0);
        download_one(sftp, remote_path, Path::new(local_path), &label, &mut ctx).await?
    };

    match outcome {
        Outcome::Done => ctx.emit(&label, true, false),
        Outcome::Cancelled => ctx.emit(&label, true, true),
    }
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    app: AppHandle,
    state: State<'_, SshState>,
    id: String,
    transfer_id: String,
    local_path: String,
    remote_path: String,
    resume: Option<bool>,
) -> Result<(), String> {
    let sftp = get_sftp(&state, &id).await?;
    let cancel = register_cancel(&state, &transfer_id).await;
    let result = upload_inner(
        &app, &sftp, &id, &transfer_id, &local_path, &remote_path, cancel,
        resume.unwrap_or(false),
    )
    .await;
    unregister_cancel(&state, &transfer_id).await;
    result
}

async fn upload_inner<R: tauri::Runtime>(
    app: &AppHandle<R>,
    sftp: &SftpSession,
    id: &str,
    transfer_id: &str,
    local_path: &str,
    remote_path: &str,
    cancel: Arc<AtomicBool>,
    resume: bool,
) -> Result<(), String> {
    let label = base_name(remote_path);
    let local = Path::new(local_path);
    let meta = tokio::fs::metadata(local).await.map_err(|e| e.to_string())?;

    let mut ctx = TransferCtx {
        app: app.clone(),
        session_id: id.to_string(),
        transfer_id: transfer_id.to_string(),
        direction: "upload",
        total: 0,
        transferred: 0,
        cancel,
        last_emit: Instant::now(),
        resume,
        resumed_from: 0,
    };

    let outcome = if meta.is_dir() {
        let root = local.to_path_buf();
        let (files, dirs) = walk_local(&root).map_err(|e| e.to_string())?;
        ctx.total = files.iter().map(|(_, s)| s).sum();
        let remote_root = remote_path.trim_end_matches('/');
        for d in &dirs {
            let rel = d
                .strip_prefix(&root)
                .unwrap_or(Path::new(""))
                .to_string_lossy()
                .replace('\\', "/");
            let target = if rel.is_empty() {
                remote_root.to_string()
            } else {
                format!("{}/{}", remote_root, rel)
            };
            // Ignoré si le dossier existe déjà ; une vraie erreur ressortira
            // à la création des fichiers.
            let _ = sftp.create_dir(target).await;
        }
        let mut outcome = Outcome::Done;
        for (f, _) in &files {
            let rel = f
                .strip_prefix(&root)
                .unwrap_or(f)
                .to_string_lossy()
                .replace('\\', "/");
            let target = format!("{}/{}", remote_root, rel);
            let name = base_name(&target);
            match upload_one(sftp, f, &target, &name, &mut ctx).await? {
                Outcome::Cancelled => {
                    outcome = Outcome::Cancelled;
                    break;
                }
                Outcome::Done => {}
            }
        }
        outcome
    } else {
        ctx.total = meta.len();
        upload_one(sftp, local, remote_path, &label, &mut ctx).await?
    };

    match outcome {
        Outcome::Done => ctx.emit(&label, true, false),
        Outcome::Cancelled => ctx.emit(&label, true, true),
    }
    Ok(())
}

// ---------- Commandes : shell ----------

const SHELL_WRAPPER: &str =
    r#"printf '\033]777;cabestan-pid=%d\007' "$$"; exec "${SHELL:-/bin/sh}" -il"#;

/// Dossier courant du shell distant, via /proc (Linux) ou lsof (macOS/BSD).
async fn query_remote_cwd(
    handle: &Handle<ClientHandler>,
    pid: u32,
) -> Result<Option<String>, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    let cmd = format!(
        "readlink /proc/{pid}/cwd 2>/dev/null || lsof -a -p {pid} -d cwd -Fn 2>/dev/null | sed -n 's/^n//p'"
    );
    channel.exec(false, cmd).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(4);
    loop {
        match tokio::time::timeout_at(deadline, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => out.extend_from_slice(&data),
            Ok(Some(ChannelMsg::Eof)) | Ok(Some(ChannelMsg::Close)) | Ok(None) | Err(_) => break,
            Ok(Some(_)) => {}
        }
    }
    let cwd = String::from_utf8_lossy(&out);
    let cwd = cwd.lines().next().unwrap_or("").trim();
    Ok(if cwd.starts_with('/') {
        Some(cwd.to_string())
    } else {
        None
    })
}

#[tauri::command]
pub async fn shell_cwd(
    state: State<'_, SshState>,
    id: String,
    pid: u32,
) -> Result<Option<String>, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    query_remote_cwd(&session.handle, pid).await
}

#[tauri::command]
pub async fn shell_open(
    app: AppHandle,
    state: State<'_, SshState>,
    id: String,
    shell_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("Session inconnue")?;

    let mut channel = session
        .handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel
        .request_pty(false, "xterm-256color", cols, rows, 0, 0, &[])
        .await
        .map_err(|e| e.to_string())?;
    // Au lieu d'un simple shell : un exec qui annonce d'abord le PID du shell
    // via une séquence OSC 777 (invisible dans le terminal), puis se remplace
    // par le shell interactif. Le PID permet de suivre le dossier courant.
    channel
        .exec(false, SHELL_WRAPPER)
        .await
        .map_err(|e| e.to_string())?;

    let (tx, mut rx) = mpsc::unbounded_channel::<ShellCmd>();
    session.shells.insert(shell_id.clone(), tx);

    let session_id = id.clone();
    let b64 = base64::engine::general_purpose::STANDARD;
    tokio::spawn(async move {
        let data_evt = format!("shell-data-{}-{}", session_id, shell_id);
        loop {
            tokio::select! {
                msg = channel.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => {
                            let _ = app.emit(&data_evt, b64.encode(&data[..]));
                        }
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            let _ = app.emit(&data_evt, b64.encode(&data[..]));
                        }
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => {
                            let _ = app.emit(
                                &format!("shell-closed-{}-{}", session_id, shell_id),
                                (),
                            );
                            break;
                        }
                        _ => {}
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(ShellCmd::Data(bytes)) => {
                            if channel.data(&bytes[..]).await.is_err() {
                                break;
                            }
                        }
                        Some(ShellCmd::Resize(c, r)) => {
                            let _ = channel.window_change(c, r, 0, 0).await;
                        }
                        Some(ShellCmd::Close) | None => {
                            let _ = channel.eof().await;
                            break;
                        }
                    }
                }
            }
        }
        use tauri::Manager;
        let st = app.state::<SshState>();
        let mut sessions = st.sessions.lock().await;
        if let Some(session) = sessions.get_mut(&session_id) {
            session.shells.remove(&shell_id);
        }
    });

    Ok(())
}

fn shell_tx_of(
    session: &Session,
    shell_id: &str,
) -> Result<mpsc::UnboundedSender<ShellCmd>, String> {
    session
        .shells
        .get(shell_id)
        .cloned()
        .ok_or_else(|| "Shell non ouvert".to_string())
}

#[tauri::command]
pub async fn shell_write(
    state: State<'_, SshState>,
    id: String,
    shell_id: String,
    data: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    shell_tx_of(session, &shell_id)?
        .send(ShellCmd::Data(data.into_bytes()))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn shell_resize(
    state: State<'_, SshState>,
    id: String,
    shell_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    shell_tx_of(session, &shell_id)?
        .send(ShellCmd::Resize(cols, rows))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn shell_close(
    state: State<'_, SshState>,
    id: String,
    shell_id: String,
) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    shell_tx_of(session, &shell_id)?
        .send(ShellCmd::Close)
        .map_err(|e| e.to_string())
}

// ---------- Commandes : édition rapide ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditSync {
    pub session_id: String,
    pub remote_path: String,
    pub file_name: String,
    pub status: String, // "opened" | "uploaded" | "error"
    pub message: Option<String>,
}

async fn upload_edit(sftp: &SftpSession, local: &Path, remote: &str) -> Result<(), String> {
    let data = tokio::fs::read(local).await.map_err(|e| e.to_string())?;
    let mut f = sftp
        .create(remote.to_string())
        .await
        .map_err(|e| e.to_string())?;
    f.write_all(&data).await.map_err(|e| e.to_string())?;
    f.shutdown().await.map_err(|e| e.to_string())?;
    Ok(())
}

/// Télécharge le fichier dans un dossier temporaire, l'ouvre dans l'app par
/// défaut, puis surveille le fichier local (sondage 1 s) et re-téléverse à
/// chaque sauvegarde stabilisée.
#[tauri::command]
pub async fn edit_open(
    app: AppHandle,
    state: State<'_, SshState>,
    id: String,
    remote_path: String,
    // editor_app : application choisie dans les réglages ; vide = celle du système.
    editor_app: Option<String>,
) -> Result<(), String> {
    use std::hash::{Hash, Hasher};
    use tauri_plugin_opener::OpenerExt;

    let sftp = get_sftp(&state, &id).await?;
    let file_name = base_name(&remote_path);

    let mut h = std::collections::hash_map::DefaultHasher::new();
    (id.as_str(), remote_path.as_str()).hash(&mut h);
    let dir = std::env::temp_dir()
        .join("cabestan-edit")
        .join(format!("{:016x}", h.finish()));
    let local = dir.join(&file_name);
    let watch_key = format!("{}|{}", id, remote_path);

    let first_open = state.edits.lock().await.insert(watch_key.clone());
    if first_open {
        tokio::fs::create_dir_all(&dir).await.map_err(|e| e.to_string())?;
        let data = sftp
            .read(remote_path.clone())
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::write(&local, data).await.map_err(|e| e.to_string())?;
    }

    let local_str = local.to_string_lossy().to_string();
    match editor_app.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
        // Éditeur choisi : on passe par `open -a`, qui accepte un nom
        // d'application comme un chemin de bundle .app.
        Some(editor) => {
            let status = std::process::Command::new("open")
                .arg("-a")
                .arg(editor)
                .arg(&local_str)
                .status()
                .map_err(|e| e.to_string())?;
            if !status.success() {
                return Err(format!(
                    "Ouverture impossible avec « {editor} » — vérifiez le réglage « Application d'édition »."
                ));
            }
        }
        None => app
            .opener()
            .open_path(local_str, None::<String>)
            .map_err(|e| e.to_string())?,
    }

    if !first_open {
        // Déjà surveillé : on a juste ré-ouvert le fichier local existant
        // (préserve d'éventuelles modifications non téléversées).
        return Ok(());
    }

    let _ = app.emit(
        "edit-sync",
        EditSync {
            session_id: id.clone(),
            remote_path: remote_path.clone(),
            file_name: file_name.clone(),
            status: "opened".into(),
            message: None,
        },
    );

    let session_id = id.clone();
    tokio::spawn(async move {
        use tauri::Manager;
        type Sig = (std::time::SystemTime, u64);
        let mut last: Option<Sig> = None;
        let mut pending: Option<Sig> = None;
        let mut failures = 0u32;
        loop {
            tokio::time::sleep(Duration::from_millis(1000)).await;
            // Fichier local supprimé → fin de la surveillance.
            let Ok(meta) = tokio::fs::metadata(&local).await else {
                break;
            };
            let sig: Sig = (
                meta.modified()
                    .unwrap_or(std::time::SystemTime::UNIX_EPOCH),
                meta.len(),
            );
            if last.is_none() {
                last = Some(sig);
                continue;
            }
            if Some(sig) == last {
                pending = None;
                continue;
            }
            if pending != Some(sig) {
                // Changement détecté : on attend un tick de stabilité
                // (certains éditeurs écrivent en plusieurs temps).
                pending = Some(sig);
                continue;
            }
            let (status, message) = match upload_edit(&sftp, &local, &remote_path).await {
                Ok(()) => {
                    last = Some(sig);
                    pending = None;
                    failures = 0;
                    ("uploaded".to_string(), None)
                }
                Err(e) => {
                    failures += 1;
                    ("error".to_string(), Some(e))
                }
            };
            let _ = app.emit(
                "edit-sync",
                EditSync {
                    session_id: session_id.clone(),
                    remote_path: remote_path.clone(),
                    file_name: file_name.clone(),
                    status,
                    message,
                },
            );
            if failures >= 3 {
                break;
            }
        }
        let st = app.state::<SshState>();
        st.edits.lock().await.remove(&watch_key);
    });

    Ok(())
}

// ---------- Commandes : lecture de ~/.ssh/config ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConfigHost {
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    /// Chaîne de bastions (ProxyJump), telle qu'écrite dans le fichier.
    pub proxy_jump: Option<String>,
}

/// Parse minimal de ~/.ssh/config : blocs Host avec HostName / User / Port /
/// IdentityFile. Les motifs génériques (* ?) et les blocs Match sont ignorés.
#[tauri::command]
pub fn ssh_config_hosts() -> Result<Vec<SshConfigHost>, String> {
    let Ok(home) = std::env::var("HOME") else {
        return Ok(vec![]);
    };
    let path = PathBuf::from(home).join(".ssh").join("config");
    let Ok(content) = std::fs::read_to_string(path) else {
        return Ok(vec![]);
    };
    Ok(parse_ssh_config(&content))
}

fn parse_ssh_config(content: &str) -> Vec<SshConfigHost> {
    let mut hosts: Vec<SshConfigHost> = Vec::new();
    let mut current: Vec<usize> = Vec::new(); // indices dans `hosts` du bloc en cours
    let mut in_match = false;

    for raw in content.lines() {
        let line = raw.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        let (key, value) = match line.split_once(|c: char| c.is_whitespace() || c == '=') {
            Some((k, v)) => (k.to_ascii_lowercase(), v.trim().trim_matches('"')),
            None => continue,
        };
        match key.as_str() {
            "host" => {
                in_match = false;
                current.clear();
                for alias in value.split_whitespace() {
                    if alias.contains('*') || alias.contains('?') || alias.starts_with('!') {
                        continue;
                    }
                    hosts.push(SshConfigHost {
                        alias: alias.to_string(),
                        host_name: None,
                        user: None,
                        port: None,
                        identity_file: None,
                        proxy_jump: None,
                    });
                    current.push(hosts.len() - 1);
                }
            }
            "match" => {
                in_match = true;
                current.clear();
            }
            _ if in_match || current.is_empty() => {}
            "hostname" => {
                for &i in &current {
                    hosts[i].host_name.get_or_insert_with(|| value.to_string());
                }
            }
            "user" => {
                for &i in &current {
                    hosts[i].user.get_or_insert_with(|| value.to_string());
                }
            }
            "port" => {
                if let Ok(p) = value.parse::<u16>() {
                    for &i in &current {
                        hosts[i].port.get_or_insert(p);
                    }
                }
            }
            "identityfile" => {
                for &i in &current {
                    hosts[i]
                        .identity_file
                        .get_or_insert_with(|| value.to_string());
                }
            }
            "proxyjump" => {
                for &i in &current {
                    hosts[i].proxy_jump.get_or_insert_with(|| value.to_string());
                }
            }
            _ => {}
        }
    }

    hosts.sort_by(|a, b| a.alias.to_lowercase().cmp(&b.alias.to_lowercase()));
    hosts
}

// ---------- Commandes : Trousseau macOS ----------

const KEYCHAIN_SERVICE: &str = "Cabestan";

#[tauri::command]
pub fn cred_set(account: String, password: String) -> Result<(), String> {
    keyring::Entry::new(KEYCHAIN_SERVICE, &account)
        .and_then(|e| e.set_password(&password))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn cred_get(account: String) -> Result<Option<String>, String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, &account).and_then(|e| e.get_password()) {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn cred_delete(account: String) -> Result<(), String> {
    match keyring::Entry::new(KEYCHAIN_SERVICE, &account).and_then(|e| e.delete_credential()) {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Retire d'un known_hosts local les entrées d'un hôte donné (test uniquement).
    fn forget_known_host(prefix: &str) {
        let Ok(home) = std::env::var("HOME") else {
            return;
        };
        let path = PathBuf::from(home).join(".ssh").join("known_hosts");
        let Ok(content) = std::fs::read_to_string(&path) else {
            return;
        };
        let kept: String = content
            .lines()
            .filter(|l| !l.starts_with(prefix))
            .map(|l| format!("{l}\n"))
            .collect();
        if kept != content {
            let _ = std::fs::write(&path, kept);
        }
    }

    /// Retire uniquement la clé de test d'authorized_keys (les autres survivent).
    async fn strip_test_key(sftp: &SftpSession, ak: &str) {
        let Ok(bytes) = sftp.read(ak).await else {
            return;
        };
        let text = String::from_utf8_lossy(&bytes).to_string();
        let kept: String = text
            .lines()
            .filter(|l| !l.contains("TESTCABESTAN"))
            .map(|l| format!("{l}\n"))
            .collect();
        if kept != text {
            let mut f = sftp.create(ak).await.expect("réécriture authorized_keys");
            f.write_all(kept.as_bytes()).await.expect("écriture");
            f.shutdown().await.expect("fermeture");
        }
    }

    fn test_opts() -> ConnectOptions {
        ConnectOptions {
            host: "127.0.0.1".into(),
            port: Some(2222),
            username: "marin".into(),
            password: Some("escale".into()),
            key_path: None,
            key_passphrase: None,
            use_agent: None,
            jump: None,
            trust_fingerprint: None,
            trust_jump: None,
        }
    }

    #[test]
    fn authorized_key_validation() {
        assert!(is_valid_authorized_key(
            "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIabc123+/= marin@mac"
        ));
        assert!(is_valid_authorized_key(
            "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTI= sans-commentaire"
        ));
        // Sans commentaire
        assert!(is_valid_authorized_key("ssh-rsa AAAAB3NzaC1yc2E="));
        // Injections / formats refusés
        assert!(!is_valid_authorized_key(
            "ssh-ed25519 AAAA' ; rm -rf ~ ; echo '"
        ));
        assert!(!is_valid_authorized_key("ssh-ed25519 AAAA\nssh-rsa BBBB"));
        assert!(!is_valid_authorized_key("pas-une-cle AAAA"));
        assert!(!is_valid_authorized_key("ssh-ed25519"));
        assert!(!is_valid_authorized_key(""));
    }

    // Installe une clé de test puis vérifie l'idempotence.
    #[tokio::test]
    #[ignore]
    async fn copy_id_local_docker() {
        let handle = connect_trusting(test_opts()).await;
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITESTCABESTAN cabestan-test";

        let sftp = open_sftp(&handle).await.expect("SFTP");
        let home = sftp.canonicalize(".").await.expect("home");
        let ak = format!("{home}/.ssh/authorized_keys");

        // Retire seulement notre clé de test : les autres clés autorisées
        // (dont celle de l'agent) doivent survivre au test.
        strip_test_key(&sftp, &ak).await;
        let before = sftp.read(&ak).await.unwrap_or_default().len();

        assert_eq!(
            copy_id_inner(&handle, key).await.expect("1re installation"),
            "added"
        );
        assert_eq!(
            copy_id_inner(&handle, key).await.expect("2e installation"),
            "already"
        );

        let content = String::from_utf8(sftp.read(&ak).await.expect("lecture")).unwrap();
        assert_eq!(
            content.lines().filter(|l| l.contains("TESTCABESTAN")).count(),
            1,
            "la clé ne doit apparaître qu'une fois"
        );

        // Une clé invalide ne doit pas atteindre le serveur.
        assert!(!is_valid_authorized_key("ssh-ed25519 AAAA'; touch /tmp/pwned; '"));

        // Nettoyage : on rend le fichier à son état initial.
        strip_test_key(&sftp, &ak).await;
        assert_eq!(
            sftp.read(&ak).await.unwrap_or_default().len(),
            before,
            "authorized_keys doit retrouver son contenu d'origine"
        );
    }

    // du / df / touch / tunnel sur le serveur de test.
    #[tokio::test]
    #[ignore]
    async fn tools_and_tunnel_local_docker() {
        let handle = connect_trusting(test_opts()).await;
        let sftp = open_sftp(&handle).await.expect("SFTP");
        let home = sftp.canonicalize(".").await.expect("home");

        // du -sh sur un dossier connu
        let du = run_command(
            &handle,
            &format!("du -sh {} 2>/dev/null | cut -f1", shell_quote(&home)),
            Duration::from_secs(30),
        )
        .await
        .expect("du");
        assert!(!du.is_empty(), "du doit renvoyer une taille, reçu vide");

        // df -hP : 6 colonnes attendues
        let df = run_command(
            &handle,
            &format!("df -hP {} 2>/dev/null | tail -n 1", shell_quote(&home)),
            Duration::from_secs(15),
        )
        .await
        .expect("df");
        assert!(
            df.split_whitespace().count() >= 6,
            "df inattendu : {df}"
        );

        // shell_quote résiste aux quotes dans les noms
        let tricky = format!("{home}/l'apostrophe");
        let echoed = run_command(
            &handle,
            &format!("printf '%s' {}", shell_quote(&tricky)),
            Duration::from_secs(10),
        )
        .await
        .expect("echo");
        assert_eq!(echoed, tricky);

        // Tunnel : on redirige un port local vers le port SSH du serveur
        // lui-même ; la bannière SSH prouve que le trafic passe.
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind local");
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
            .await
            .expect("rebind");
        let h2 = Arc::new(handle);
        let h_task = h2.clone();
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = listener.accept().await {
                if let Ok(channel) = h_task
                    .channel_open_direct_tcpip("127.0.0.1", 2222, "127.0.0.1", 0)
                    .await
                {
                    let mut stream = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                }
            }
        });

        let mut client = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connexion au tunnel");
        let mut buf = [0u8; 32];
        let n = tokio::time::timeout(Duration::from_secs(10), client.read(&mut buf))
            .await
            .expect("délai bannière")
            .expect("lecture bannière");
        let banner = String::from_utf8_lossy(&buf[..n]);
        assert!(
            banner.starts_with("SSH-"),
            "le tunnel doit transporter la bannière SSH, reçu : {banner:?}"
        );
    }

    #[test]
    fn shell_quote_escapes() {
        assert_eq!(shell_quote("/tmp/simple"), "'/tmp/simple'");
        assert_eq!(shell_quote("l'apostrophe"), r"'l'\''apostrophe'");
        assert_eq!(shell_quote("a b; rm -rf /"), "'a b; rm -rf /'");
    }

    /// Lecture locale en texte : les cas non comparables renvoient None plutôt
    /// qu'une erreur, pour que l'envoi puisse continuer sans diff.
    #[tokio::test]
    async fn local_read_text_filters_uncomparable_files() {
        let dir = std::env::temp_dir().join("cabestan-lecture-locale");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dossier de test");

        let texte = dir.join("conf.txt");
        std::fs::write(&texte, "server {\n  listen 80;\n}\n").expect("écriture");
        assert_eq!(
            local_read_text(texte.to_string_lossy().into_owned()).await.unwrap(),
            Some("server {\n  listen 80;\n}\n".to_string())
        );

        let accents = dir.join("accents.txt");
        std::fs::write(&accents, "été à l'œuvre").expect("écriture");
        assert_eq!(
            local_read_text(accents.to_string_lossy().into_owned()).await.unwrap(),
            Some("été à l'œuvre".to_string())
        );

        // Octet nul dans les premiers 8 Kio : considéré binaire.
        let binaire = dir.join("image.bin");
        std::fs::write(&binaire, [0x89, 0x50, 0x00, 0x0d]).expect("écriture");
        assert_eq!(
            local_read_text(binaire.to_string_lossy().into_owned()).await.unwrap(),
            None
        );

        // Texte non UTF-8 (latin-1) : pas d'erreur, simplement pas comparable.
        let latin = dir.join("latin1.txt");
        std::fs::write(&latin, [0x63, 0x61, 0x66, 0xe9]).expect("écriture");
        assert_eq!(
            local_read_text(latin.to_string_lossy().into_owned()).await.unwrap(),
            None
        );

        // Au-delà de 4 Mio on ne lit pas.
        let gros = dir.join("gros.log");
        std::fs::write(&gros, vec![b'a'; 4 * 1024 * 1024 + 1]).expect("écriture");
        assert_eq!(
            local_read_text(gros.to_string_lossy().into_owned()).await.unwrap(),
            None
        );

        // Fichier absent : erreur, l'appelant retombe sur l'envoi direct.
        assert!(
            local_read_text(dir.join("absent").to_string_lossy().into_owned())
                .await
                .is_err()
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn hop_parsing() {
        let h = parse_hop("bastion.exemple.fr").unwrap();
        assert_eq!((h.user.as_deref(), h.host.as_str(), h.port), (None, "bastion.exemple.fr", 22));
        let h = parse_hop("jump@bastion:2202").unwrap();
        assert_eq!((h.user.as_deref(), h.host.as_str(), h.port), (Some("jump"), "bastion", 2202));
        let h = parse_hop("[::1]:2222").unwrap();
        assert_eq!((h.host.as_str(), h.port), ("::1", 2222));
        let h = parse_hop("user@[fe80::1]").unwrap();
        assert_eq!((h.user.as_deref(), h.host.as_str(), h.port), (Some("user"), "fe80::1", 22));
        assert!(parse_hop("").is_none());
        assert!(parse_hop("   ").is_none());
    }

    #[test]
    fn proxyjump_in_config() {
        let hosts = parse_ssh_config(
            "Host derriere\n  HostName 10.0.0.5\n  ProxyJump jump@bastion:2202\n",
        );
        assert_eq!(hosts.len(), 1);
        assert_eq!(hosts[0].proxy_jump.as_deref(), Some("jump@bastion:2202"));
    }

    // Archives, recherche, empreintes, corbeille, comparaison, supervision.
    #[tokio::test]
    #[ignore]
    async fn server_tools_local_docker() {
        let handle = Arc::new(connect_trusting(test_opts()).await);
        let sftp = open_sftp(&handle).await.expect("SFTP");
        let home = sftp.canonicalize(".").await.expect("home");

        let dir = format!("{home}/cabestan-outils");
        let _ = remove_remote_recursive(&sftp, &dir).await;
        sftp.create_dir(&dir).await.expect("mkdir");
        for (name, body) in [("un.txt", "aiguille dans la botte"), ("deux.txt", "rien")] {
            let mut f = sftp.create(format!("{dir}/{name}")).await.expect("create");
            f.write_all(body.as_bytes()).await.expect("write");
            f.shutdown().await.expect("close");
        }

        // Archive puis extraction dans un sous-dossier
        let cmd_ar = format!(
            "cd {} && tar czf {} -- un.txt deux.txt && echo CABESTAN_OK",
            shell_quote(&dir),
            shell_quote("paquet.tar.gz")
        );
        let out = run_command(&handle, &cmd_ar, Duration::from_secs(60)).await.expect("tar");
        assert!(out.contains("CABESTAN_OK"), "archivage : {out}");
        assert!(sftp.try_exists(format!("{dir}/paquet.tar.gz")).await.unwrap_or(false));

        let sub = format!("{dir}/extrait");
        sftp.create_dir(&sub).await.expect("mkdir extrait");
        let out = run_command(
            &handle,
            &format!(
                "tar xzf {} -C {} && echo CABESTAN_OK",
                shell_quote(&format!("{dir}/paquet.tar.gz")),
                shell_quote(&sub)
            ),
            Duration::from_secs(60),
        )
        .await
        .expect("untar");
        assert!(out.contains("CABESTAN_OK"), "extraction : {out}");
        assert_eq!(
            sftp.read(format!("{sub}/un.txt")).await.expect("relecture"),
            b"aiguille dans la botte"
        );

        // Recherche par nom et par contenu
        let by_name = run_command(
            &handle,
            &format!("find {} -iname {} 2>/dev/null | head -n 50", shell_quote(&dir), shell_quote("*un*")),
            Duration::from_secs(30),
        )
        .await
        .expect("find");
        assert!(by_name.lines().any(|l| l.ends_with("/un.txt")), "find : {by_name}");

        let by_content = run_command(
            &handle,
            &format!("grep -rIl -e {} {} 2>/dev/null", shell_quote("aiguille"), shell_quote(&dir)),
            Duration::from_secs(30),
        )
        .await
        .expect("grep");
        assert!(by_content.contains("un.txt"), "grep : {by_content}");

        // Empreinte distante vs locale sur le même contenu
        let remote_hash = run_command(
            &handle,
            &format!(
                "sha256sum {p} 2>/dev/null || shasum -a 256 {p} 2>/dev/null",
                p = shell_quote(&format!("{dir}/un.txt"))
            ),
            Duration::from_secs(30),
        )
        .await
        .expect("sha distant");
        let remote_hash = remote_hash.split_whitespace().next().unwrap_or("").to_string();
        assert_eq!(remote_hash.len(), 64, "empreinte distante : {remote_hash}");
        let tmp = std::env::temp_dir().join("cabestan-sha.txt");
        std::fs::write(&tmp, b"aiguille dans la botte").expect("écriture locale");
        let local_hash = local_sha256(tmp.to_string_lossy().to_string())
            .await
            .expect("sha local");
        assert_eq!(local_hash, remote_hash, "les empreintes doivent concorder");
        let _ = std::fs::remove_file(&tmp);

        // Corbeille : le fichier quitte le dossier mais existe encore
        let out = run_command(
            &handle,
            &format!(
                "d=$HOME/.cabestan-corbeille/test && mkdir -p \"$d\" && mv -- {} \"$d\"/ && echo CABESTAN_OK",
                shell_quote(&format!("{dir}/deux.txt"))
            ),
            Duration::from_secs(30),
        )
        .await
        .expect("corbeille");
        assert!(out.contains("CABESTAN_OK"), "corbeille : {out}");
        assert!(!sftp.try_exists(format!("{dir}/deux.txt")).await.unwrap_or(true));
        assert!(sftp
            .try_exists(format!("{home}/.cabestan-corbeille/test/deux.txt"))
            .await
            .unwrap_or(false));

        // Supervision : le relevé doit remonter au moins uptime et noyau
        let stats = run_command(
            &handle,
            "echo \"UPTIME:$(uptime -p 2>/dev/null || uptime)\"; echo \"KERNEL:$(uname -sr)\"",
            Duration::from_secs(20),
        )
        .await
        .expect("stats");
        assert!(stats.contains("KERNEL:Linux"), "stats : {stats}");

        // Nettoyage
        let _ = remove_remote_recursive(&sftp, &dir).await;
        let _ = run_command(
            &handle,
            "rm -rf $HOME/.cabestan-corbeille/test",
            Duration::from_secs(20),
        )
        .await;
    }

    // Proxy SOCKS5 : la poignée de main puis le trafic doivent passer.
    #[tokio::test]
    #[ignore]
    async fn socks_proxy_local_docker() {
        let handle = Arc::new(connect_trusting(test_opts()).await);
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind");
        let port = listener.local_addr().unwrap().port();
        let h = handle.clone();
        tokio::spawn(async move {
            if let Ok((socket, _)) = listener.accept().await {
                let _ = socks5_serve(socket, h).await;
            }
        });

        let mut c = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .expect("connexion proxy");
        // Négociation : version 5, une méthode (sans auth)
        c.write_all(&[0x05, 0x01, 0x00]).await.expect("hello");
        let mut resp = [0u8; 2];
        c.read_exact(&mut resp).await.expect("réponse hello");
        assert_eq!(resp, [0x05, 0x00], "le proxy doit accepter « sans auth »");

        // CONNECT 127.0.0.1:2222 (le sshd du conteneur, vu de l'intérieur)
        let mut req = vec![0x05, 0x01, 0x00, 0x01];
        req.extend_from_slice(&[127, 0, 0, 1]);
        req.extend_from_slice(&2222u16.to_be_bytes());
        c.write_all(&req).await.expect("connect");
        let mut reply = [0u8; 10];
        c.read_exact(&mut reply).await.expect("réponse connect");
        assert_eq!(reply[1], 0x00, "CONNECT doit réussir, code {}", reply[1]);

        // Le trafic traverse : on doit lire la bannière SSH du serveur.
        let mut buf = [0u8; 32];
        let n = tokio::time::timeout(Duration::from_secs(10), c.read(&mut buf))
            .await
            .expect("délai bannière")
            .expect("lecture");
        assert!(
            String::from_utf8_lossy(&buf[..n]).starts_with("SSH-"),
            "le proxy doit transporter la bannière"
        );
    }

    // Redirection distante (-R) : le serveur écoute et renvoie chez nous.
    #[tokio::test]
    #[ignore]
    async fn remote_forward_local_docker() {
        let mut opts = test_opts();
        opts.trust_fingerprint = None;
        let (handle, forwards) = match connect_inner(&opts).await {
            Ok(v) => v,
            Err(e) => {
                let msg = e.to_string();
                let fp = msg.split('|').nth(2).unwrap_or("").to_string();
                opts.trust_fingerprint = Some(fp);
                connect_inner(&opts).await.expect("connexion")
            }
        };

        // Service local que le serveur devra atteindre.
        let local = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .expect("bind local");
        let local_port = local.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut s, _)) = local.accept().await {
                let _ = s.write_all(b"BONJOUR-CABESTAN").await;
                let _ = s.flush().await;
            }
        });

        let remote_port = 15432u16;
        forwards
            .lock()
            .unwrap()
            .insert(remote_port as u32, format!("127.0.0.1:{local_port}"));
        handle
            .tcpip_forward("", remote_port as u32)
            .await
            .expect("le serveur doit accepter d'écouter");

        // Depuis le serveur, on se connecte au port redirigé : la réponse doit
        // venir de notre service local.
        let out = run_command(
            &handle,
            &format!(
                "(command -v nc >/dev/null && nc -w 3 127.0.0.1 {remote_port}) ||                  (exec 3<>/dev/tcp/127.0.0.1/{remote_port} && head -c 16 <&3)"
            ),
            Duration::from_secs(20),
        )
        .await
        .expect("commande distante");
        assert!(
            out.contains("BONJOUR-CABESTAN"),
            "le serveur doit joindre notre service local, reçu : {out:?}"
        );
    }

    // Rebond réel : le conteneur sert de bastion vers lui-même. L'alias
    // "localhost" est absent de known_hosts, ce qui exerce le TOFU du bastion.
    #[tokio::test]
    #[ignore]
    async fn proxyjump_local_docker() {
        // Le test doit repartir d'un bastion inconnu : on retire l'entrée que
        // les exécutions précédentes ont pu apprendre.
        forget_known_host("[localhost]:2222");

        let mut opts = test_opts();
        opts.password = None;
        opts.use_agent = Some(true);
        opts.jump = Some("marin@localhost:2222".into());

        // 1) Le bastion inconnu doit être signalé, avec son empreinte et son nom.
        let err = connect_inner(&opts)
            .await
            .err()
            .expect("un bastion inconnu doit être refusé")
            .to_string();
        assert!(
            err.starts_with("UNKNOWN_HOST_KEY|") || err.starts_with("HOST_KEY_CHANGED|"),
            "marqueur d'empreinte attendu, reçu : {err}"
        );
        let parts: Vec<&str> = err.split('|').collect();
        assert_eq!(parts.len(), 4, "l'hôte doit être cité : {err}");
        assert_eq!(parts[3], "localhost:2222", "le bastion doit être nommé");
        let jump_fp = parts[2].to_string();

        // 2) Empreinte acceptée : la traversée aboutit.
        opts.trust_jump = Some(vec![jump_fp]);
        let (handle, _) = match connect_inner(&opts).await {
            Ok(v) => v,
            Err(e) => {
                // La cible peut à son tour demander confirmation.
                let msg = e.to_string();
                assert!(msg.starts_with("UNKNOWN_HOST_KEY|"), "inattendu : {msg}");
                opts.trust_fingerprint = Some(msg.split('|').nth(2).unwrap().to_string());
                connect_inner(&opts).await.expect("connexion via bastion")
            }
        };

        // 3) La session traversée est pleinement utilisable.
        let sftp = open_sftp(&handle).await.expect("SFTP via bastion");
        let home = sftp.canonicalize(".").await.expect("home via bastion");
        assert!(home.starts_with('/'), "home inattendu : {home}");
        let out = run_command(&handle, "echo VIA_BASTION", Duration::from_secs(15))
            .await
            .expect("commande via bastion");
        assert!(out.contains("VIA_BASTION"), "sortie : {out}");
    }

    // La vue structurée exécute une commande libre : la sortie doit être
    // exploitable en colonnes.
    #[tokio::test]
    #[ignore]
    async fn remote_run_local_docker() {
        let handle = connect_trusting(test_opts()).await;

        // Commande reconnue : df réécrit en colonnes tabulées.
        let out = run_command(
            &handle,
            "df -hP | tail -n +2 | awk '{printf \"%s\\t%s\\t%s\\t%s\\t%s\\n\", $1, $2, $3, $4, $5}'",
            Duration::from_secs(20),
        )
        .await
        .expect("df tabulé");
        let first = out.lines().next().unwrap_or("");
        assert_eq!(
            first.split('\t').count(),
            5,
            "5 colonnes tabulées attendues, reçu : {first:?}"
        );

        // Commande libre quelconque.
        let out = run_command(&handle, "printf 'a\\tb\\nc\\td\\n'", Duration::from_secs(10))
            .await
            .expect("commande libre");
        assert_eq!(out.lines().count(), 2);

        // Sortie vide : pas d'erreur, juste rien.
        let empty = run_command(&handle, "true", Duration::from_secs(10))
            .await
            .expect("commande sans sortie");
        assert!(empty.trim().is_empty());
    }

    // Édition intégrée, historique du shell, suivi de fichier en continu.
    #[tokio::test]
    #[ignore]
    async fn editor_history_follow_local_docker() {
        let handle = Arc::new(connect_trusting(test_opts()).await);
        let sftp = open_sftp(&handle).await.expect("SFTP");
        let home = sftp.canonicalize(".").await.expect("home");

        // --- Éditeur : écriture puis relecture fidèle, accents compris
        let path = format!("{home}/cabestan-edit.conf");
        let contenu = "server {\n  listen 80;  # accentué : é à ü\n}\n";
        {
            let mut f = sftp.create(&path).await.expect("création");
            f.write_all(contenu.as_bytes()).await.expect("écriture");
            f.shutdown().await.expect("fermeture");
        }
        let relu = String::from_utf8(sftp.read(&path).await.expect("relecture")).unwrap();
        assert_eq!(relu, contenu, "l'aller-retour doit être fidèle");

        // Le binaire doit être refusé par la lecture texte.
        let bin = format!("{home}/cabestan-bin.dat");
        {
            let mut f = sftp.create(&bin).await.expect("création binaire");
            f.write_all(&[0u8, 1, 2, 3, 0]).await.expect("écriture binaire");
            f.shutdown().await.expect("fermeture");
        }
        let data = sftp.read(&bin).await.expect("lecture binaire");
        assert!(
            data.iter().take(8192).any(|b| *b == 0),
            "le fichier de test doit bien contenir des octets nuls"
        );

        // --- Historique : on maîtrise les deux fichiers pour un test stable
        // (sans quoi un .bash_history résiduel changerait l'ordre attendu).
        let hist = format!("{home}/.zsh_history");
        let bash_hist = format!("{home}/.bash_history");
        {
            let mut f = sftp.create(&bash_hist).await.expect("vidage bash_history");
            f.shutdown().await.expect("fermeture");
        }
        {
            let mut f = sftp.create(&hist).await.expect("création historique");
            f.write_all(b": 1700000000:0;docker ps\n: 1700000001:0;df -h\n: 1700000002:0;docker ps\n")
                .await
                .expect("écriture historique");
            f.shutdown().await.expect("fermeture");
        }
        let out = run_command(
            &handle,
            "cat ~/.zsh_history ~/.bash_history 2>/dev/null | tail -n 4000",
            Duration::from_secs(20),
        )
        .await
        .expect("lecture historique");
        let mut seen = std::collections::HashSet::new();
        let mut cmds: Vec<String> = Vec::new();
        for raw in out.lines().rev() {
            let cleaned = raw
                .strip_prefix(':')
                .and_then(|r| r.split_once(';'))
                .map(|(_, c)| c)
                .unwrap_or(raw)
                .trim();
            if !cleaned.is_empty() && seen.insert(cleaned.to_string()) {
                cmds.push(cleaned.to_string());
            }
        }
        assert!(cmds.contains(&"docker ps".to_string()), "commandes : {cmds:?}");
        assert!(cmds.contains(&"df -h".to_string()), "commandes : {cmds:?}");
        assert_eq!(
            cmds.iter().filter(|c| *c == "docker ps").count(),
            1,
            "les doublons doivent être écartés"
        );
        assert_eq!(cmds[0], "docker ps", "le plus récent doit venir en tête");

        // --- Suivi : tail -F doit remonter les lignes ajoutées après coup
        let suivi = format!("{home}/cabestan-suivi.log");
        {
            let mut f = sftp.create(&suivi).await.expect("création log");
            f.write_all(b"ligne initiale\n").await.expect("écriture log");
            f.shutdown().await.expect("fermeture");
        }
        let mut channel = handle.channel_open_session().await.expect("canal");
        channel
            .exec(false, format!("tail -n 5 -F {} 2>&1", shell_quote(&suivi)))
            .await
            .expect("tail");

        // Ajout d'une ligne pendant le suivi.
        let h2 = handle.clone();
        let suivi2 = suivi.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(700)).await;
            let _ = run_command(
                &h2,
                &format!("printf 'nouvelle ligne\\n' >> {}", shell_quote(&suivi2)),
                Duration::from_secs(10),
            )
            .await;
        });

        let mut recu = String::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
        while !recu.contains("nouvelle ligne") {
            match tokio::time::timeout_at(deadline, channel.wait()).await {
                Ok(Some(ChannelMsg::Data { data })) => {
                    recu.push_str(&String::from_utf8_lossy(&data))
                }
                Ok(Some(_)) => {}
                Ok(None) | Err(_) => break,
            }
        }
        let _ = channel.eof().await;
        assert!(recu.contains("ligne initiale"), "début manquant : {recu:?}");
        assert!(
            recu.contains("nouvelle ligne"),
            "le suivi doit remonter les ajouts : {recu:?}"
        );

        // Nettoyage
        for p in [&path, &bin, &suivi, &hist, &bash_hist] {
            let _ = sftp.remove_file(p).await;
        }
    }

    #[test]
    fn parse_ssh_config_basics() {
        let conf = r#"
# commentaire
Host prod
    HostName prod.exemple.fr
    User deploy
    Port 2200
    IdentityFile ~/.ssh/id_prod

Host nas backup
    HostName 192.168.1.50

Host *
    User fallback

Match user root
    HostName ignore.moi
"#;
        let hosts = parse_ssh_config(conf);
        assert_eq!(hosts.len(), 3);
        let prod = hosts.iter().find(|h| h.alias == "prod").unwrap();
        assert_eq!(prod.host_name.as_deref(), Some("prod.exemple.fr"));
        assert_eq!(prod.user.as_deref(), Some("deploy"));
        assert_eq!(prod.port, Some(2200));
        assert_eq!(prod.identity_file.as_deref(), Some("~/.ssh/id_prod"));
        let nas = hosts.iter().find(|h| h.alias == "nas").unwrap();
        assert_eq!(nas.host_name.as_deref(), Some("192.168.1.50"));
        let backup = hosts.iter().find(|h| h.alias == "backup").unwrap();
        assert_eq!(backup.host_name.as_deref(), Some("192.168.1.50"));
        // le motif * et le bloc Match sont ignorés
        assert!(hosts.iter().all(|h| h.alias != "*"));
        assert!(hosts.iter().all(|h| h.host_name.as_deref() != Some("ignore.moi")));
    }

    async fn connect_trusting(mut opts: ConnectOptions) -> Handle<ClientHandler> {
        match connect_inner(&opts).await.map(|(h, _)| h) {
            Ok(h) => h,
            Err(e) => {
                let msg = e.to_string();
                assert!(
                    msg.starts_with("UNKNOWN_HOST_KEY|") || msg.starts_with("HOST_KEY_CHANGED|"),
                    "erreur inattendue : {msg}"
                );
                let fp = msg.split('|').nth(2).unwrap().to_string();
                opts.trust_fingerprint = Some(fp);
                connect_inner(&opts)
                    .await
                    .map(|(h, _)| h)
                    .expect("connexion avec confiance")
            }
        }
    }

    // Requiert le serveur de test avec la clé de l'agent autorisée (PUBLIC_KEY)
    // et un ssh-agent contenant cette clé (SSH_AUTH_SOCK).
    #[tokio::test]
    #[ignore]
    async fn agent_auth_local_docker() {
        let mut opts = test_opts();
        opts.password = None;
        opts.use_agent = Some(true);
        let handle = connect_trusting(opts).await;
        let sftp = open_sftp(&handle).await.expect("SFTP via agent");
        assert!(sftp.canonicalize(".").await.is_ok());
    }

    // Vérifie le wrapper de shell (marqueur PID OSC 777) et le suivi du
    // dossier courant via /proc.
    #[tokio::test]
    #[ignore]
    async fn cwd_tracking_local_docker() {
        let handle = connect_trusting(test_opts()).await;
        let mut channel = handle.channel_open_session().await.expect("canal");
        channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .expect("pty");
        channel.exec(false, SHELL_WRAPPER).await.expect("exec");

        // Récupère le PID annoncé par le marqueur OSC 777.
        let mut out = Vec::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        let pid: u32 = loop {
            let msg = tokio::time::timeout_at(deadline, channel.wait())
                .await
                .expect("délai marqueur")
                .expect("canal fermé");
            if let ChannelMsg::Data { data } = msg {
                out.extend_from_slice(&data);
            }
            let s = String::from_utf8_lossy(&out);
            if let Some(idx) = s.find("]777;cabestan-pid=") {
                let rest = &s[idx + "]777;cabestan-pid=".len()..];
                if let Some(end) = rest.find('\u{7}') {
                    break rest[..end].parse().expect("pid numérique");
                }
            }
        };

        channel.data(&b"cd /tmp\n"[..]).await.expect("cd");
        tokio::time::sleep(std::time::Duration::from_millis(800)).await;
        let cwd = query_remote_cwd(&handle, pid)
            .await
            .expect("requête cwd")
            .expect("cwd présent");
        assert_eq!(cwd, "/tmp");
    }

    // Requiert le serveur de test jetable :
    // docker run -d -p 2222:2222 -e PASSWORD_ACCESS=true \
    //   -e USER_NAME=marin -e USER_PASSWORD=escale lscr.io/linuxserver/openssh-server
    #[tokio::test]
    #[ignore]
    async fn end_to_end_local_docker() {
        // Premier essai sans confiance : la clé doit être inconnue ou déjà connue.
        let first = connect_inner(&test_opts()).await.map(|(h, _)| h);
        let handle = match first {
            Ok(h) => h,
            Err(e) => {
                let msg = e.to_string();
                assert!(
                    msg.starts_with("UNKNOWN_HOST_KEY|") || msg.starts_with("HOST_KEY_CHANGED|"),
                    "erreur inattendue : {msg}"
                );
                let fp = msg.split('|').nth(2).unwrap().to_string();
                let mut opts = test_opts();
                opts.trust_fingerprint = Some(fp);
                connect_inner(&opts)
                    .await
                    .map(|(h, _)| h)
                    .expect("connexion avec confiance")
            }
        };
        // Une fois apprise, la clé doit passer sans confiance explicite.
        let handle2 = connect_inner(&test_opts())
            .await
            .map(|(h, _)| h)
            .expect("clé apprise");
        drop(handle2);

        let sftp = open_sftp(&handle).await.expect("session SFTP");
        let home = sftp.canonicalize(".").await.expect("home");

        // Fichier simple
        let test_file = format!("{}/cabestan-test.txt", home);
        {
            let mut f = sftp.create(&test_file).await.expect("création");
            f.write_all(b"bonjour").await.expect("écriture");
            f.shutdown().await.expect("fermeture");
        }
        let data = sftp.read(&test_file).await.expect("lecture");
        assert_eq!(data, b"bonjour");

        // chmod 600 comme le fait la commande sftp_chmod
        let mut attrs = russh_sftp::protocol::FileAttributes::empty();
        attrs.permissions = Some(0o600);
        sftp.set_metadata(&test_file, attrs).await.expect("chmod");
        let meta = sftp.metadata(&test_file).await.expect("stat après chmod");
        assert_eq!(meta.permissions.unwrap_or(0) & 0o777, 0o600);

        sftp.remove_file(&test_file).await.expect("suppression");

        // Arborescence récursive : walk + suppression récursive
        let root = format!("{}/cabestan-tree", home);
        sftp.create_dir(&root).await.expect("mkdir racine");
        sftp.create_dir(format!("{}/sous", root)).await.expect("mkdir sous");
        for p in [format!("{}/a.txt", root), format!("{}/sous/b.txt", root)] {
            let mut f = sftp.create(&p).await.expect("création fichier arbre");
            f.write_all(b"x").await.expect("écriture arbre");
            f.shutdown().await.expect("fermeture arbre");
        }
        let (files, dirs) = walk_remote(&sftp, &root).await.expect("walk");
        assert_eq!(files.len(), 2);
        assert_eq!(dirs.len(), 2);
        remove_remote_recursive(&sftp, &root)
            .await
            .expect("suppression récursive");
        assert!(!sftp.try_exists(&root).await.unwrap_or(true));

        // Transferts récursifs via les mêmes fonctions que les commandes
        {
            use tauri::Manager;
            let mock = tauri::test::mock_app();
            let app = mock.handle().clone();
            let _ = &app; // AppHandle factice : les événements partent dans le vide

            let local_root = std::env::temp_dir().join("cabestan-up-src");
            let _ = std::fs::remove_dir_all(&local_root);
            std::fs::create_dir_all(local_root.join("sous")).expect("mkdir local");
            std::fs::write(local_root.join("un.txt"), b"premier").expect("write local");
            std::fs::write(local_root.join("sous/deux.txt"), b"second").expect("write local 2");

            let remote_root = format!("{}/cabestan-up", home);
            upload_inner(
                &app,
                &sftp,
                "s-test",
                "t-up",
                local_root.to_str().unwrap(),
                &remote_root,
                Arc::new(AtomicBool::new(false)),
                false,
            )
            .await
            .expect("upload récursif");
            assert_eq!(
                sftp.read(format!("{}/sous/deux.txt", remote_root))
                    .await
                    .expect("lecture après upload"),
                b"second"
            );

            let local_dest = std::env::temp_dir().join("cabestan-down-dst");
            let _ = std::fs::remove_dir_all(&local_dest);
            download_inner(
                &app,
                &sftp,
                "s-test",
                "t-down",
                &remote_root,
                local_dest.to_str().unwrap(),
                Arc::new(AtomicBool::new(false)),
                false,
            )
            .await
            .expect("download récursif");
            assert_eq!(
                std::fs::read(local_dest.join("un.txt")).expect("lecture après download"),
                b"premier"
            );
            assert_eq!(
                std::fs::read(local_dest.join("sous/deux.txt")).expect("lecture 2"),
                b"second"
            );

            remove_remote_recursive(&sftp, &remote_root)
                .await
                .expect("nettoyage distant");
            let _ = std::fs::remove_dir_all(&local_root);
            let _ = std::fs::remove_dir_all(&local_dest);
        }

        // Shell interactif
        let mut channel = handle.channel_open_session().await.expect("canal");
        channel
            .request_pty(false, "xterm-256color", 80, 24, 0, 0, &[])
            .await
            .expect("pty");
        channel.request_shell(false).await.expect("shell");
        channel
            .data(&b"echo CAP_$((40+2))\n"[..])
            .await
            .expect("envoi");

        let mut out = Vec::new();
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let msg = tokio::time::timeout_at(deadline, channel.wait())
                .await
                .expect("délai dépassé en attendant la sortie du shell")
                .expect("canal fermé");
            if let ChannelMsg::Data { data } = msg {
                out.extend_from_slice(&data);
            }
            if String::from_utf8_lossy(&out).contains("CAP_42") {
                break;
            }
        }
    }
}

// ---------- Commandes : clés publiques locales et ssh-copy-id ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPubKey {
    /// Chemin du fichier .pub
    pub path: String,
    /// Chemin de la clé privée correspondante, si elle existe à côté
    pub private_path: Option<String>,
    pub algo: String,
    pub comment: String,
    /// Ligne complète, telle qu'elle doit finir dans authorized_keys
    pub line: String,
}

fn is_valid_authorized_key(line: &str) -> bool {
    if line.contains('\n') || line.contains('\r') || line.contains('\'') {
        return false;
    }
    let mut parts = line.split_whitespace();
    let Some(algo) = parts.next() else {
        return false;
    };
    let known = matches!(
        algo,
        "ssh-ed25519" | "ssh-rsa" | "ssh-dss" | "ssh-ed448"
    ) || algo.starts_with("ecdsa-sha2-")
        || algo.starts_with("sk-ssh-")
        || algo.starts_with("sk-ecdsa-");
    if !known {
        return false;
    }
    let Some(b64) = parts.next() else {
        return false;
    };
    !b64.is_empty()
        && b64
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/' || b == b'=')
}

/// Clés publiques présentes dans ~/.ssh, candidates à l'installation distante.
#[tauri::command]
pub fn local_public_keys() -> Result<Vec<LocalPubKey>, String> {
    let Ok(home) = std::env::var("HOME") else {
        return Ok(vec![]);
    };
    let dir = PathBuf::from(&home).join(".ssh");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return Ok(vec![]);
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("pub") {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let line = content.lines().next().unwrap_or("").trim().to_string();
        if !is_valid_authorized_key(&line) {
            continue;
        }
        let mut parts = line.split_whitespace();
        let algo = parts.next().unwrap_or("").to_string();
        let _b64 = parts.next();
        let comment = parts.collect::<Vec<_>>().join(" ");
        let private_path = path.with_extension("");
        out.push(LocalPubKey {
            path: path.to_string_lossy().to_string(),
            private_path: private_path
                .exists()
                .then(|| private_path.to_string_lossy().to_string()),
            algo,
            comment,
            line,
        });
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(out)
}

/// Installe une clé publique dans ~/.ssh/authorized_keys du serveur, à la
/// manière de ssh-copy-id (idempotent, permissions corrigées).
/// Renvoie "added" ou "already" selon que la clé était déjà présente.
#[tauri::command]
pub async fn ssh_copy_id(
    state: State<'_, SshState>,
    id: String,
    key_line: String,
) -> Result<String, String> {
    let key_line = key_line.trim().to_string();
    if !is_valid_authorized_key(&key_line) {
        return Err("Clé publique invalide ou inattendue".into());
    }

    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    copy_id_inner(&session.handle, &key_line).await
}

async fn copy_id_inner(
    handle: &Handle<ClientHandler>,
    key_line: &str,
) -> Result<String, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;

    // umask 077 : ~/.ssh et authorized_keys créés avec des droits restreints.
    let script = format!(
        "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && \
         if grep -qxF '{key}' ~/.ssh/authorized_keys; then echo CABESTAN_ALREADY; \
         else printf '%s\\n' '{key}' >> ~/.ssh/authorized_keys && echo CABESTAN_ADDED; fi; \
         chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys",
        key = key_line
    );
    channel
        .exec(false, script)
        .await
        .map_err(|e| e.to_string())?;

    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    loop {
        match tokio::time::timeout_at(deadline, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => out.extend_from_slice(&data),
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => out.extend_from_slice(&data),
            Ok(Some(ChannelMsg::Eof)) | Ok(Some(ChannelMsg::Close)) | Ok(None) | Err(_) => break,
            Ok(Some(_)) => {}
        }
    }
    let text = String::from_utf8_lossy(&out);
    if text.contains("CABESTAN_ADDED") {
        Ok("added".into())
    } else if text.contains("CABESTAN_ALREADY") {
        Ok("already".into())
    } else {
        Err(format!(
            "Installation de la clé échouée : {}",
            text.trim().lines().last().unwrap_or("erreur inconnue")
        ))
    }
}

// ---------- Exécution d'une commande simple sur la session ----------

/// Exécute une commande et renvoie sa sortie (stdout+stderr), tronquée.
/// Rend le porteur de connexion d'une session ouverte.
///
/// Nécessaire au module Docker pour ouvrir son propre canal de suivi, sans
/// exposer la structure `Session` elle-même.
pub(crate) async fn session_handle(
    state: &State<'_, SshState>,
    id: &str,
) -> Result<Arc<Handle<ClientHandler>>, String> {
    let sessions = state.sessions.lock().await;
    Ok(sessions.get(id).ok_or("Session inconnue")?.handle.clone())
}

/// Exécute une commande sur une session ouverte et rend (sortie, code de sortie).
///
/// C'est la seule porte d'entrée des autres modules vers une session SSH : la
/// structure `Session` et sa table restent privées ici.
pub(crate) async fn exec_on_session(
    state: &State<'_, SshState>,
    id: &str,
    cmd: &str,
    timeout: Duration,
    max_bytes: usize,
) -> Result<(String, Option<u32>), String> {
    let handle = {
        let sessions = state.sessions.lock().await;
        sessions.get(id).ok_or("Session inconnue")?.handle.clone()
    };
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel.exec(false, cmd).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut code = None;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match tokio::time::timeout_at(deadline, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => out.extend_from_slice(&data),
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => out.extend_from_slice(&data),
            Ok(Some(ChannelMsg::ExitStatus { exit_status })) => code = Some(exit_status),
            Ok(Some(ChannelMsg::Eof)) | Ok(Some(ChannelMsg::Close)) | Ok(None) | Err(_) => break,
            Ok(Some(_)) => {}
        }
        if out.len() > max_bytes {
            break;
        }
    }
    Ok((String::from_utf8_lossy(&out).trim_end().to_string(), code))
}

async fn run_command(
    handle: &Handle<ClientHandler>,
    cmd: &str,
    timeout: Duration,
) -> Result<String, String> {
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    channel.exec(false, cmd).await.map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        match tokio::time::timeout_at(deadline, channel.wait()).await {
            Ok(Some(ChannelMsg::Data { data })) => out.extend_from_slice(&data),
            Ok(Some(ChannelMsg::ExtendedData { data, .. })) => out.extend_from_slice(&data),
            Ok(Some(ChannelMsg::Eof)) | Ok(Some(ChannelMsg::Close)) | Ok(None) | Err(_) => break,
            Ok(Some(_)) => {}
        }
        if out.len() > 64 * 1024 {
            break;
        }
    }
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

/// Échappe un chemin pour l'insérer entre quotes simples dans un shell.
pub(crate) fn shell_quote(path: &str) -> String {
    format!("'{}'", path.replace('\'', r"'\''"))
}

/// Crée un fichier vide (échoue si le chemin existe déjà).
#[tauri::command]
pub async fn sftp_touch(
    state: State<'_, SshState>,
    id: String,
    path: String,
) -> Result<(), String> {
    let sftp = get_sftp(&state, &id).await?;
    if sftp.try_exists(path.clone()).await.unwrap_or(false) {
        return Err("Un élément de ce nom existe déjà".into());
    }
    let mut f = sftp.create(path).await.map_err(|e| e.to_string())?;
    f.shutdown().await.map_err(|e| e.to_string())
}

/// Taille occupée par un dossier distant (`du -sh`).
#[tauri::command]
pub async fn remote_du(
    state: State<'_, SshState>,
    id: String,
    path: String,
) -> Result<String, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    let out = run_command(
        &session.handle,
        &format!("du -sh {} 2>/dev/null | cut -f1", shell_quote(&path)),
        Duration::from_secs(60),
    )
    .await?;
    let size = out.lines().next().unwrap_or("").trim().to_string();
    if size.is_empty() {
        Err("Taille indisponible (du absent ou accès refusé)".into())
    } else {
        Ok(size)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub filesystem: String,
    pub size: String,
    pub used: String,
    pub avail: String,
    pub percent: String,
    pub mount: String,
}

/// Espace disque du système de fichiers contenant `path` (`df -h`).
#[tauri::command]
pub async fn remote_df(
    state: State<'_, SshState>,
    id: String,
    path: String,
) -> Result<Option<DiskUsage>, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    let out = run_command(
        &session.handle,
        &format!("df -hP {} 2>/dev/null | tail -n 1", shell_quote(&path)),
        Duration::from_secs(15),
    )
    .await?;
    let f: Vec<&str> = out.split_whitespace().collect();
    if f.len() < 6 {
        return Ok(None);
    }
    Ok(Some(DiskUsage {
        filesystem: f[0].to_string(),
        size: f[1].to_string(),
        used: f[2].to_string(),
        avail: f[3].to_string(),
        percent: f[4].to_string(),
        mount: f[5..].join(" "),
    }))
}

// ---------- Redirection de port locale (équivalent ssh -L) ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tunnel {
    pub id: String,
    pub session_id: String,
    pub local_port: u16,
    pub remote_host: String,
    pub remote_port: u16,
    /// "local" (-L), "remote" (-R) ou "socks" (-D).
    pub kind: String,
    /// Nombre de connexions transitées depuis l'ouverture.
    pub connections: u32,
}

pub struct TunnelHandle {
    pub info: Tunnel,
    stop: tokio::sync::watch::Sender<bool>,
    counter: Arc<std::sync::atomic::AtomicU32>,
}

/// Ouvre un tunnel : tout ce qui arrive sur 127.0.0.1:local_port est
/// transporté par la connexion SSH jusqu'à remote_host:remote_port.
#[tauri::command]
pub async fn tunnel_open(
    app: AppHandle,
    state: State<'_, SshState>,
    id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> Result<Tunnel, String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| format!("Port local {local_port} indisponible : {e}"))?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let tunnel_id = format!("t{}", state.counter.fetch_add(1, Ordering::SeqCst));
    let info = Tunnel {
        id: tunnel_id.clone(),
        session_id: id.clone(),
        local_port,
        remote_host: remote_host.clone(),
        remote_port,
        kind: "local".into(),
        connections: 0,
    };

    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));

    state.tunnels.lock().await.insert(
        tunnel_id.clone(),
        TunnelHandle {
            info: info.clone(),
            stop: stop_tx,
            counter: counter.clone(),
        },
    );

    let session_id = id.clone();
    let counter_task = counter.clone();
    tokio::spawn(async move {
        use tauri::Manager;
        loop {
            let accepted = tokio::select! {
                r = listener.accept() => r,
                _ = stop_rx.changed() => break,
            };
            let Ok((mut socket, _)) = accepted else { break };

            // Le canal SSH est ouvert par connexion entrante.
            let st = app.state::<SshState>();
            let handle = {
                let sessions = st.sessions.lock().await;
                match sessions.get(&session_id) {
                    Some(s) => s.handle.clone(),
                    None => break, // session fermée : le tunnel n'a plus de porteur
                }
            };
            let host = remote_host.clone();
            counter_task.fetch_add(1, Ordering::Relaxed);
            tokio::spawn(async move {
                match handle
                    .channel_open_direct_tcpip(host, remote_port as u32, "127.0.0.1", 0)
                    .await
                {
                    Ok(channel) => {
                        let mut stream = channel.into_stream();
                        let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
                    }
                    Err(_) => {
                        let _ = socket.shutdown().await;
                    }
                }
            });
        }
    });

    Ok(info)
}

#[tauri::command]
pub async fn tunnel_close(state: State<'_, SshState>, tunnel_id: String) -> Result<(), String> {
    if let Some(t) = state.tunnels.lock().await.remove(&tunnel_id) {
        let _ = t.stop.send(true);
    }
    Ok(())
}

#[tauri::command]
pub async fn tunnel_list(state: State<'_, SshState>) -> Result<Vec<Tunnel>, String> {
    let tunnels = state.tunnels.lock().await;
    Ok(tunnels
        .values()
        .map(|t| Tunnel {
            connections: t.counter.load(Ordering::Relaxed),
            ..t.info.clone()
        })
        .collect())
}

// ---------- Outils serveur : archives, recherche, empreintes, corbeille ----------

/// Compresse un ou plusieurs éléments d'un dossier distant en une archive.
/// `format` : "tar.gz" | "tar.bz2" | "zip".
#[tauri::command]
pub async fn remote_archive(
    state: State<'_, SshState>,
    id: String,
    dir: String,
    names: Vec<String>,
    archive_name: String,
    format: String,
) -> Result<String, String> {
    if names.is_empty() {
        return Err("Rien à archiver".into());
    }
    if archive_name.contains('/') || archive_name.trim().is_empty() {
        return Err("Nom d'archive invalide".into());
    }
    let quoted: Vec<String> = names.iter().map(|n| shell_quote(n)).collect();
    let list = quoted.join(" ");
    let target = shell_quote(&archive_name);
    let cd = shell_quote(&dir);
    let cmd = match format.as_str() {
        "tar.gz" => format!("cd {cd} && tar czf {target} -- {list} && echo CABESTAN_OK"),
        "tar.bz2" => format!("cd {cd} && tar cjf {target} -- {list} && echo CABESTAN_OK"),
        "zip" => format!("cd {cd} && zip -rq {target} -- {list} && echo CABESTAN_OK"),
        _ => return Err("Format inconnu".into()),
    };
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    let out = run_command(&session.handle, &cmd, Duration::from_secs(600)).await?;
    if out.contains("CABESTAN_OK") {
        Ok(joinpath_str(&dir, &archive_name))
    } else {
        Err(format!(
            "Archivage échoué : {}",
            out.lines().last().unwrap_or("erreur inconnue")
        ))
    }
}

fn joinpath_str(dir: &str, name: &str) -> String {
    join_path(dir, name)
}

/// Extrait une archive distante dans son dossier (ou dans `into`).
#[tauri::command]
pub async fn remote_extract(
    state: State<'_, SshState>,
    id: String,
    archive_path: String,
    into: Option<String>,
) -> Result<(), String> {
    let dir = into.unwrap_or_else(|| {
        let p = archive_path.trim_end_matches('/');
        match p.rsplit_once('/') {
            Some((d, _)) if !d.is_empty() => d.to_string(),
            _ => "/".to_string(),
        }
    });
    let a = shell_quote(&archive_path);
    let d = shell_quote(&dir);
    let lower = archive_path.to_lowercase();
    let cmd = if lower.ends_with(".zip") {
        format!("unzip -oq {a} -d {d} && echo CABESTAN_OK")
    } else if lower.ends_with(".tar.gz") || lower.ends_with(".tgz") {
        format!("tar xzf {a} -C {d} && echo CABESTAN_OK")
    } else if lower.ends_with(".tar.bz2") || lower.ends_with(".tbz2") {
        format!("tar xjf {a} -C {d} && echo CABESTAN_OK")
    } else if lower.ends_with(".tar.xz") {
        format!("tar xJf {a} -C {d} && echo CABESTAN_OK")
    } else if lower.ends_with(".tar") {
        format!("tar xf {a} -C {d} && echo CABESTAN_OK")
    } else if lower.ends_with(".gz") {
        format!("gunzip -kf {a} && echo CABESTAN_OK")
    } else {
        return Err("Format d'archive non reconnu".into());
    };
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    let out = run_command(&session.handle, &cmd, Duration::from_secs(600)).await?;
    if out.contains("CABESTAN_OK") {
        Ok(())
    } else {
        Err(format!(
            "Extraction échouée : {}",
            out.lines().last().unwrap_or("erreur inconnue")
        ))
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub is_dir: bool,
}

/// Recherche par nom (et éventuellement par contenu) sous un dossier distant.
#[tauri::command]
pub async fn remote_search(
    state: State<'_, SshState>,
    id: String,
    root: String,
    pattern: String,
    contains: Option<String>,
    max_results: Option<u32>,
) -> Result<Vec<SearchHit>, String> {
    if pattern.trim().is_empty() && contains.as_deref().unwrap_or("").trim().is_empty() {
        return Err("Indiquez un nom ou un contenu à chercher".into());
    }
    let limit = max_results.unwrap_or(300).min(2000);
    let r = shell_quote(&root);
    let cmd = match contains.as_deref().filter(|c| !c.trim().is_empty()) {
        // Recherche de contenu : grep récursif, chemins seuls.
        Some(text) => format!(
            "grep -rIl --exclude-dir=.git -e {} {r} 2>/dev/null | head -n {limit}",
            shell_quote(text)
        ),
        None => format!(
            "find {r} -iname {} 2>/dev/null | head -n {limit}",
            shell_quote(&format!("*{}*", pattern.trim()))
        ),
    };
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    let out = run_command(&session.handle, &cmd, Duration::from_secs(120)).await?;
    drop(sessions);

    let sftp = get_sftp(&state, &id).await?;
    let mut hits = Vec::new();
    for line in out.lines().filter(|l| l.starts_with('/')) {
        let is_dir = sftp
            .metadata(line.to_string())
            .await
            .map(|m| m.is_dir())
            .unwrap_or(false);
        hits.push(SearchHit {
            path: line.to_string(),
            is_dir,
        });
    }
    Ok(hits)
}

/// Empreinte SHA-256 d'un fichier distant.
#[tauri::command]
pub async fn remote_sha256(
    state: State<'_, SshState>,
    id: String,
    path: String,
) -> Result<String, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    let out = run_command(
        &session.handle,
        &format!(
            "sha256sum {p} 2>/dev/null || shasum -a 256 {p} 2>/dev/null",
            p = shell_quote(&path)
        ),
        Duration::from_secs(300),
    )
    .await?;
    out.split_whitespace()
        .next()
        .filter(|h| h.len() == 64)
        .map(|h| h.to_string())
        .ok_or_else(|| "Empreinte indisponible (sha256sum absent ?)".to_string())
}

/// Empreinte SHA-256 d'un fichier local, pour comparaison après transfert.
#[tauri::command]
pub async fn local_sha256(path: String) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = tokio::fs::File::open(&path).await.map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    // sha2 0.11 renvoie un Array : on met en hexadécimal à la main.
    Ok(hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>())
}

/// Déplace des fichiers locaux vers la corbeille macOS (~/.Trash) au lieu de
/// les supprimer : le miroir « serveur → local » doit rester rattrapable.
#[tauri::command]
pub async fn local_trash(paths: Vec<String>) -> Result<u32, String> {
    let home = std::env::var("HOME").map_err(|_| "HOME introuvable".to_string())?;
    let trash = std::path::PathBuf::from(home).join(".Trash");
    let mut moved = 0;
    for p in &paths {
        let src = std::path::PathBuf::from(p);
        let name = src
            .file_name()
            .ok_or_else(|| format!("Chemin invalide : {p}"))?
            .to_string_lossy()
            .to_string();
        let mut dest = trash.join(&name);
        // Un homonyme attend déjà dans la corbeille : on suffixe, comme le Finder.
        let mut n = 1;
        while dest.exists() {
            dest = trash.join(format!("{name} {n}"));
            n += 1;
        }
        tokio::fs::rename(&src, &dest)
            .await
            .map_err(|e| format!("Mise à la corbeille échouée pour {p} : {e}"))?;
        moved += 1;
    }
    Ok(moved)
}

/// Déplace vers la corbeille de l'app (~/.cabestan-corbeille) au lieu de supprimer.
#[tauri::command]
pub async fn sftp_trash(
    state: State<'_, SshState>,
    id: String,
    paths: Vec<String>,
) -> Result<u32, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    let mut moved = 0;
    for p in &paths {
        let out = run_command(
            &session.handle,
            &format!(
                "d=$HOME/.cabestan-corbeille/$(date +%Y%m%d-%H%M%S) && mkdir -p \"$d\" && \
                 mv -- {p} \"$d\"/ && echo CABESTAN_OK",
                p = shell_quote(p)
            ),
            Duration::from_secs(60),
        )
        .await?;
        if out.contains("CABESTAN_OK") {
            moved += 1;
        } else {
            return Err(format!(
                "Mise à la corbeille échouée pour {p} : {}",
                out.lines().last().unwrap_or("erreur inconnue")
            ));
        }
    }
    Ok(moved)
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffEntry {
    pub name: String,
    pub status: String, // "local" | "remote" | "differs" | "same"
    pub local_size: Option<u64>,
    pub remote_size: Option<u64>,
    pub local_mtime: Option<u64>,
    pub remote_mtime: Option<u64>,
}

/// Compare un dossier local et un dossier distant (noms, tailles, dates).
#[tauri::command]
pub async fn compare_dirs(
    state: State<'_, SshState>,
    id: String,
    local_dir: String,
    remote_dir: String,
) -> Result<Vec<DiffEntry>, String> {
    let sftp = get_sftp(&state, &id).await?;
    let remote = sftp
        .read_dir(remote_dir.clone())
        .await
        .map_err(|e| e.to_string())?;
    let mut rmap: HashMap<String, (u64, Option<u64>)> = HashMap::new();
    for e in remote {
        let name = e.file_name();
        if name == "." || name == ".." {
            continue;
        }
        let meta = e.metadata();
        if !meta.is_dir() {
            rmap.insert(
                name,
                (meta.size.unwrap_or(0), meta.mtime.map(|t| t as u64)),
            );
        }
    }

    let mut lmap: HashMap<String, (u64, Option<u64>)> = HashMap::new();
    let mut dir = tokio::fs::read_dir(&local_dir).await.map_err(|e| e.to_string())?;
    while let Some(entry) = dir.next_entry().await.map_err(|e| e.to_string())? {
        if entry.file_type().await.map(|t| t.is_file()).unwrap_or(false) {
            let meta = entry.metadata().await.ok();
            let len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime = meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs());
            lmap.insert(entry.file_name().to_string_lossy().to_string(), (len, mtime));
        }
    }

    let mut names: Vec<String> = lmap.keys().chain(rmap.keys()).cloned().collect();
    names.sort();
    names.dedup();

    Ok(names
        .into_iter()
        .map(|name| {
            let l = lmap.get(&name).copied();
            let r = rmap.get(&name).copied();
            let status = match (l, r) {
                (Some((a, _)), Some((b, _))) if a == b => "same",
                (Some(_), Some(_)) => "differs",
                (Some(_), None) => "local",
                (None, Some(_)) => "remote",
                (None, None) => "same",
            };
            DiffEntry {
                name,
                status: status.to_string(),
                local_size: l.map(|(s, _)| s),
                remote_size: r.map(|(s, _)| s),
                local_mtime: l.and_then(|(_, t)| t),
                remote_mtime: r.and_then(|(_, t)| t),
            }
        })
        .collect())
}

/// Copie un fichier d'un serveur vers un autre, en passant par l'app.
#[tauri::command]
pub async fn server_to_server(
    app: AppHandle,
    state: State<'_, SshState>,
    from_id: String,
    from_path: String,
    to_id: String,
    to_path: String,
    transfer_id: String,
) -> Result<(), String> {
    let src_sftp = get_sftp(&state, &from_id).await?;
    let dst_sftp = get_sftp(&state, &to_id).await?;
    let cancel = register_cancel(&state, &transfer_id).await;

    let meta = src_sftp
        .metadata(from_path.clone())
        .await
        .map_err(|e| e.to_string())?;
    if meta.is_dir() {
        unregister_cancel(&state, &transfer_id).await;
        return Err("Copie serveur à serveur : fichiers uniquement pour l'instant".into());
    }
    let total = meta.size.unwrap_or(0);
    let label = base_name(&from_path);

    let mut src = src_sftp
        .open(from_path.clone())
        .await
        .map_err(|e| e.to_string())?;
    let mut dst = dst_sftp
        .create(to_path.clone())
        .await
        .map_err(|e| e.to_string())?;

    let mut ctx = TransferCtx {
        app: app.clone(),
        session_id: to_id.clone(),
        transfer_id: transfer_id.clone(),
        direction: "upload",
        total,
        transferred: 0,
        cancel,
        last_emit: Instant::now(),
        resume: false,
        resumed_from: 0,
    };

    let mut buf = vec![0u8; CHUNK];
    let mut cancelled = false;
    loop {
        if ctx.cancelled() {
            cancelled = true;
            break;
        }
        let n = src.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        ctx.transferred += n as u64;
        ctx.emit(&label, false, false);
    }
    let _ = dst.flush().await;
    let _ = dst.shutdown().await;
    ctx.emit(&label, true, cancelled);
    unregister_cancel(&state, &transfer_id).await;
    Ok(())
}

// ---------- Supervision ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerStats {
    pub uptime: String,
    pub load: String,
    pub mem_used: String,
    pub mem_total: String,
    pub cpu_count: String,
    pub top: Vec<String>,
    pub kernel: String,
}

/// Relevé rapide de l'état du serveur (une seule commande, un seul canal).
#[tauri::command]
pub async fn remote_stats(
    state: State<'_, SshState>,
    id: String,
) -> Result<ServerStats, String> {
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    let script = r#"
echo "UPTIME:$(uptime -p 2>/dev/null || uptime)"
echo "LOAD:$(cat /proc/loadavg 2>/dev/null | cut -d' ' -f1-3 || sysctl -n vm.loadavg 2>/dev/null)"
echo "CPUS:$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)"
echo "KERNEL:$(uname -sr)"
free -m 2>/dev/null | awk '/^Mem:/ {print "MEM:"$3"Mi/"$2"Mi"}'
ps -eo pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -6 | tail -5 | awk '{print "TOP:"$1"% cpu "$2"% mem "$3}'
"#;
    let out = run_command(&session.handle, script, Duration::from_secs(20)).await?;

    let get = |k: &str| -> String {
        out.lines()
            .find(|l| l.starts_with(k))
            .map(|l| l[k.len()..].trim().to_string())
            .unwrap_or_default()
    };
    let mem = get("MEM:");
    let (used, total) = mem.split_once('/').unwrap_or(("", ""));
    Ok(ServerStats {
        uptime: get("UPTIME:"),
        load: get("LOAD:"),
        mem_used: used.to_string(),
        mem_total: total.to_string(),
        cpu_count: get("CPUS:"),
        kernel: get("KERNEL:"),
        top: out
            .lines()
            .filter(|l| l.starts_with("TOP:"))
            .map(|l| l[4..].trim().to_string())
            .collect(),
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceItem {
    pub name: String,
    pub status: String,
    pub detail: String,
}

/// Liste les conteneurs Docker ou les services systemd du serveur.
#[tauri::command]
pub async fn remote_services(
    state: State<'_, SshState>,
    id: String,
    kind: String, // "docker" | "systemd"
) -> Result<Vec<ServiceItem>, String> {
    let cmd = match kind.as_str() {
        "docker" => {
            "docker ps -a --format '{{.Names}}\\t{{.State}}\\t{{.Status}} — {{.Image}}' 2>&1 | head -n 60"
        }
        "systemd" => {
            "systemctl list-units --type=service --all --no-legend --no-pager 2>&1 | awk '{name=$1; active=$3; $1=$2=$3=$4=\"\"; sub(/^ +/,\"\"); print name\"\\t\"active\"\\t\"$0}' | head -n 80"
        }
        _ => return Err("Type inconnu".into()),
    };
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    let out = run_command(&session.handle, cmd, Duration::from_secs(30)).await?;
    if out.contains("command not found") || out.contains("not found") && out.lines().count() <= 1 {
        return Err(format!("{kind} indisponible sur ce serveur"));
    }
    if out.to_lowercase().contains("permission denied") {
        return Err(format!("Accès refusé à {kind} (droits insuffisants)"));
    }
    Ok(out
        .lines()
        .filter(|l| l.contains('\t'))
        .map(|l| {
            let mut parts = l.splitn(3, '\t');
            ServiceItem {
                name: parts.next().unwrap_or("").to_string(),
                status: parts.next().unwrap_or("").to_string(),
                detail: parts.next().unwrap_or("").to_string(),
            }
        })
        .collect())
}

/// Action sur un service / conteneur : "start" | "stop" | "restart".
#[tauri::command]
pub async fn remote_service_action(
    state: State<'_, SshState>,
    id: String,
    kind: String,
    name: String,
    action: String,
) -> Result<String, String> {
    if !matches!(action.as_str(), "start" | "stop" | "restart") {
        return Err("Action non autorisée".into());
    }
    let n = shell_quote(&name);
    let cmd = match kind.as_str() {
        "docker" => format!("docker {action} {n} 2>&1"),
        "systemd" => format!("systemctl {action} {n} 2>&1 || sudo -n systemctl {action} {n} 2>&1"),
        _ => return Err("Type inconnu".into()),
    };
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    let out = run_command(&session.handle, &cmd, Duration::from_secs(60)).await?;
    Ok(out)
}

/// Aperçu d'un fichier distant : texte tronqué, ou image en base64.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub kind: String, // "text" | "image" | "binary"
    pub content: String,
    pub truncated: bool,
    pub size: u64,
}

#[tauri::command]
pub async fn remote_preview(
    state: State<'_, SshState>,
    id: String,
    path: String,
) -> Result<Preview, String> {
    const MAX: u64 = 512 * 1024;
    let sftp = get_sftp(&state, &id).await?;
    let meta = sftp
        .metadata(path.clone())
        .await
        .map_err(|e| e.to_string())?;
    let size = meta.size.unwrap_or(0);

    let lower = path.to_lowercase();
    let is_image = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]
        .iter()
        .any(|e| lower.ends_with(e));
    if size > MAX && !is_image {
        // On ne lit que le début pour les gros fichiers texte.
        let mut f = sftp.open(path.clone()).await.map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; MAX as usize];
        let n = f.read(&mut buf).await.map_err(|e| e.to_string())?;
        buf.truncate(n);
        return Ok(Preview {
            kind: "text".into(),
            content: String::from_utf8_lossy(&buf).to_string(),
            truncated: true,
            size,
        });
    }
    if size > 8 * 1024 * 1024 {
        return Err("Fichier trop volumineux pour l'aperçu (> 8 Mo)".into());
    }
    let data = sftp.read(path.clone()).await.map_err(|e| e.to_string())?;
    if is_image {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&data);
        return Ok(Preview {
            kind: "image".into(),
            content: b64,
            truncated: false,
            size,
        });
    }
    // Détection sommaire de binaire : présence d'octets nuls.
    if data.iter().take(8192).any(|b| *b == 0) {
        return Ok(Preview {
            kind: "binary".into(),
            content: String::new(),
            truncated: false,
            size,
        });
    }
    Ok(Preview {
        kind: "text".into(),
        content: String::from_utf8_lossy(&data).to_string(),
        truncated: false,
        size,
    })
}

// ---------- Gestion de ~/.ssh/known_hosts ----------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnownHostLine {
    pub line: usize,
    pub hosts: String,
    pub algo: String,
}

#[tauri::command]
pub fn known_hosts_list() -> Result<Vec<KnownHostLine>, String> {
    let Ok(home) = std::env::var("HOME") else {
        return Ok(vec![]);
    };
    let path = PathBuf::from(home).join(".ssh").join("known_hosts");
    let Ok(content) = std::fs::read_to_string(path) else {
        return Ok(vec![]);
    };
    Ok(content
        .lines()
        .enumerate()
        .filter(|(_, l)| !l.trim().is_empty() && !l.starts_with('#'))
        .map(|(i, l)| {
            let mut parts = l.split_whitespace();
            KnownHostLine {
                line: i + 1,
                hosts: parts.next().unwrap_or("").to_string(),
                algo: parts.next().unwrap_or("").to_string(),
            }
        })
        .collect())
}

#[tauri::command]
pub fn known_hosts_remove(line: usize) -> Result<(), String> {
    remove_known_hosts_line(line).map_err(|e| e.to_string())
}

// ---------- Tunnels : redirection distante (-R) et proxy SOCKS (-D) ----------

/// Redirection distante : le serveur écoute sur `remote_port` et renvoie tout
/// vers `local_host:local_port` sur cette machine (équivalent ssh -R).
#[tauri::command]
pub async fn tunnel_open_remote(
    state: State<'_, SshState>,
    id: String,
    remote_port: u16,
    local_host: String,
    local_port: u16,
) -> Result<Tunnel, String> {
    let (handle, forwards) = {
        let sessions = state.sessions.lock().await;
        let session = sessions.get(&id).ok_or("Session inconnue")?;
        (session.handle.clone(), session.remote_forwards.clone())
    };

    // La cible locale est enregistrée avant la demande : le serveur peut
    // ouvrir un canal dès l'acceptation.
    let target = format!("{}:{}", local_host.trim(), local_port);
    forwards
        .lock()
        .unwrap()
        .insert(remote_port as u32, target.clone());

    let bound = handle
        .tcpip_forward("", remote_port as u32)
        .await
        .map_err(|e| {
            forwards.lock().unwrap().remove(&(remote_port as u32));
            format!(
                "Le serveur a refusé d'écouter sur le port {remote_port} : {e} \
                 (AllowTcpForwarding / GatewayPorts)"
            )
        })?;
    // Port 0 : le serveur choisit ; on réenregistre sous le port réel.
    let effective = if remote_port == 0 { bound as u16 } else { remote_port };
    if effective != remote_port {
        let mut map = forwards.lock().unwrap();
        map.remove(&(remote_port as u32));
        map.insert(effective as u32, target);
    }

    let tunnel_id = format!("t{}", state.counter.fetch_add(1, Ordering::SeqCst));
    let info = Tunnel {
        id: tunnel_id.clone(),
        session_id: id.clone(),
        local_port,
        remote_host: local_host,
        remote_port: effective,
        kind: "remote".into(),
        connections: 0,
    };
    let (stop_tx, _rx) = tokio::sync::watch::channel(false);
    state.tunnels.lock().await.insert(
        tunnel_id,
        TunnelHandle {
            info: info.clone(),
            stop: stop_tx,
            counter: Arc::new(std::sync::atomic::AtomicU32::new(0)),
        },
    );
    Ok(info)
}

/// Proxy SOCKS5 local : chaque requête est ouverte depuis le serveur
/// (équivalent ssh -D). Sans authentification, commande CONNECT seulement.
#[tauri::command]
pub async fn tunnel_open_socks(
    app: AppHandle,
    state: State<'_, SshState>,
    id: String,
    local_port: u16,
) -> Result<Tunnel, String> {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", local_port))
        .await
        .map_err(|e| format!("Port local {local_port} indisponible : {e}"))?;
    let local_port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let tunnel_id = format!("t{}", state.counter.fetch_add(1, Ordering::SeqCst));
    let info = Tunnel {
        id: tunnel_id.clone(),
        session_id: id.clone(),
        local_port,
        remote_host: "*".into(),
        remote_port: 0,
        kind: "socks".into(),
        connections: 0,
    };
    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let counter = Arc::new(std::sync::atomic::AtomicU32::new(0));
    state.tunnels.lock().await.insert(
        tunnel_id.clone(),
        TunnelHandle {
            info: info.clone(),
            stop: stop_tx,
            counter: counter.clone(),
        },
    );

    let session_id = id.clone();
    tokio::spawn(async move {
        use tauri::Manager;
        loop {
            let accepted = tokio::select! {
                r = listener.accept() => r,
                _ = stop_rx.changed() => break,
            };
            let Ok((socket, _)) = accepted else { break };

            let st = app.state::<SshState>();
            let handle = {
                let sessions = st.sessions.lock().await;
                match sessions.get(&session_id) {
                    Some(s) => s.handle.clone(),
                    None => break,
                }
            };
            counter.fetch_add(1, Ordering::Relaxed);
            tokio::spawn(async move {
                let _ = socks5_serve(socket, handle).await;
            });
        }
    });

    Ok(info)
}

/// Poignée de main SOCKS5 puis raccordement au canal SSH.
async fn socks5_serve(
    mut socket: tokio::net::TcpStream,
    handle: Arc<Handle<ClientHandler>>,
) -> Result<(), std::io::Error> {
    // Négociation : version + méthodes proposées.
    let mut head = [0u8; 2];
    socket.read_exact(&mut head).await?;
    if head[0] != 0x05 {
        return Ok(());
    }
    let mut methods = vec![0u8; head[1] as usize];
    socket.read_exact(&mut methods).await?;
    // 0x00 : pas d'authentification.
    socket.write_all(&[0x05, 0x00]).await?;

    // Requête : VER CMD RSV ATYP ...
    let mut req = [0u8; 4];
    socket.read_exact(&mut req).await?;
    if req[1] != 0x01 {
        // Commande non gérée (BIND / UDP).
        socket
            .write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
            .await?;
        return Ok(());
    }
    let host = match req[3] {
        0x01 => {
            let mut a = [0u8; 4];
            socket.read_exact(&mut a).await?;
            std::net::Ipv4Addr::from(a).to_string()
        }
        0x03 => {
            let mut len = [0u8; 1];
            socket.read_exact(&mut len).await?;
            let mut name = vec![0u8; len[0] as usize];
            socket.read_exact(&mut name).await?;
            String::from_utf8_lossy(&name).to_string()
        }
        0x04 => {
            let mut a = [0u8; 16];
            socket.read_exact(&mut a).await?;
            std::net::Ipv6Addr::from(a).to_string()
        }
        _ => {
            socket
                .write_all(&[0x05, 0x08, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await?;
            return Ok(());
        }
    };
    let mut port_bytes = [0u8; 2];
    socket.read_exact(&mut port_bytes).await?;
    let port = u16::from_be_bytes(port_bytes);

    match handle
        .channel_open_direct_tcpip(host, port as u32, "127.0.0.1", 0)
        .await
    {
        Ok(channel) => {
            // Succès : BND.ADDR/PORT à zéro, accepté par les clients courants.
            socket
                .write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await?;
            let mut stream = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut socket, &mut stream).await;
        }
        Err(_) => {
            socket
                .write_all(&[0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0])
                .await?;
        }
    }
    Ok(())
}

// ---------- Journalisation de session ----------

#[derive(Default)]
pub struct LogState {
    /// shell "session|pane" → fichier ouvert en écriture.
    files: Mutex<HashMap<String, Arc<Mutex<tokio::fs::File>>>>,
}

/// Démarre l'enregistrement de la sortie d'un panneau dans un fichier.
#[tauri::command]
pub async fn log_start(
    state: State<'_, LogState>,
    key: String,
    path: String,
) -> Result<(), String> {
    let file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .await
        .map_err(|e| e.to_string())?;
    state
        .files
        .lock()
        .await
        .insert(key, Arc::new(Mutex::new(file)));
    Ok(())
}

#[tauri::command]
pub async fn log_write(
    state: State<'_, LogState>,
    key: String,
    data: String,
) -> Result<(), String> {
    let file = {
        let files = state.files.lock().await;
        files.get(&key).cloned()
    };
    if let Some(file) = file {
        let mut f = file.lock().await;
        f.write_all(data.as_bytes()).await.map_err(|e| e.to_string())?;
        f.flush().await.map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn log_stop(state: State<'_, LogState>, key: String) -> Result<(), String> {
    if let Some(file) = state.files.lock().await.remove(&key) {
        let mut f = file.lock().await;
        let _ = f.flush().await;
    }
    Ok(())
}

#[tauri::command]
pub async fn log_active(state: State<'_, LogState>) -> Result<Vec<String>, String> {
    Ok(state.files.lock().await.keys().cloned().collect())
}


// ---------- Export / import de la configuration ----------

/// Écrit la configuration (JSON fourni par l'interface) dans un fichier.
#[tauri::command]
pub async fn config_export(path: String, json: String) -> Result<(), String> {
    tokio::fs::write(&path, json.as_bytes())
        .await
        .map_err(|e| format!("Écriture impossible : {e}"))
}

/// Relit un fichier de configuration exporté.
#[tauri::command]
pub async fn config_import(path: String) -> Result<String, String> {
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Lecture impossible : {e}"))?;
    // Garde-fou : un fichier de config reste petit.
    if bytes.len() > 4 * 1024 * 1024 {
        return Err("Fichier trop volumineux pour une configuration".into());
    }
    String::from_utf8(bytes).map_err(|_| "Fichier illisible (UTF-8 attendu)".to_string())
}

// ---------- Exécution libre pour la vue structurée ----------

/// Exécute une commande fournie par l'utilisateur et renvoie sa sortie brute.
/// Utilisée par la vue structurée : le canal d'exec évite le bruit du prompt
/// et des séquences ANSI d'un shell interactif.
#[tauri::command]
pub async fn remote_run(
    state: State<'_, SshState>,
    id: String,
    command: String,
    timeout_secs: Option<u64>,
) -> Result<String, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("Commande vide".into());
    }
    if command.len() > 4096 {
        return Err("Commande trop longue".into());
    }
    let timeout = Duration::from_secs(timeout_secs.unwrap_or(30).clamp(1, 120));
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    run_command(&session.handle, command, timeout).await
}

// ---------- Édition intégrée, historique, suivi de log ----------

/// Écrit un contenu texte dans un fichier distant (éditeur intégré).
#[tauri::command]
pub async fn sftp_write_text(
    state: State<'_, SshState>,
    id: String,
    path: String,
    content: String,
) -> Result<(), String> {
    let sftp = get_sftp(&state, &id).await?;
    let mut f = sftp.create(path).await.map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).await.map_err(|e| e.to_string())?;
    f.flush().await.map_err(|e| e.to_string())?;
    f.shutdown().await.map_err(|e| e.to_string())
}

/// Lit un fichier distant en texte (éditeur intégré). Refuse le binaire.
#[tauri::command]
pub async fn sftp_read_text(
    state: State<'_, SshState>,
    id: String,
    path: String,
) -> Result<String, String> {
    const MAX: u64 = 4 * 1024 * 1024;
    let sftp = get_sftp(&state, &id).await?;
    let meta = sftp.metadata(path.clone()).await.map_err(|e| e.to_string())?;
    if meta.size.unwrap_or(0) > MAX {
        return Err("Fichier trop volumineux pour l'éditeur (> 4 Mo)".into());
    }
    let data = sftp.read(path).await.map_err(|e| e.to_string())?;
    if data.iter().take(8192).any(|b| *b == 0) {
        return Err("Fichier binaire : édition impossible".into());
    }
    String::from_utf8(data).map_err(|_| "Fichier non UTF-8 : édition impossible".to_string())
}

/// Lit un fichier local en texte, avec les mêmes garde-fous que la lecture
/// distante : c'est ce qui permet de comparer un fichier avant de l'envoyer.
/// Renvoie None (plutôt qu'une erreur) quand le fichier n'est pas comparable :
/// l'appelant se contente alors de la confirmation d'écrasement habituelle.
#[tauri::command]
pub async fn local_read_text(path: String) -> Result<Option<String>, String> {
    const MAX: u64 = 4 * 1024 * 1024;
    let meta = tokio::fs::metadata(&path).await.map_err(|e| e.to_string())?;
    if meta.len() > MAX {
        return Ok(None);
    }
    let data = tokio::fs::read(&path).await.map_err(|e| e.to_string())?;
    if data.iter().take(8192).any(|b| *b == 0) {
        return Ok(None);
    }
    Ok(String::from_utf8(data).ok())
}

/// Historique du shell distant, du plus récent au plus ancien, dédoublonné.
#[tauri::command]
pub async fn remote_history(
    state: State<'_, SshState>,
    id: String,
    limit: Option<u32>,
) -> Result<Vec<String>, String> {
    let limit = limit.unwrap_or(400).min(2000);
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("Session inconnue")?;
    // On concatène les historiques trouvés ; zsh préfixe ses lignes de
    // métadonnées « : horodatage:durée; », que l'on retire.
    let out = run_command(
        &session.handle,
        "cat ~/.zsh_history ~/.bash_history 2>/dev/null | tail -n 4000",
        Duration::from_secs(20),
    )
    .await?;

    let mut seen = std::collections::HashSet::new();
    let mut lines: Vec<String> = Vec::new();
    for raw in out.lines().rev() {
        let cleaned = raw
            .strip_prefix(':')
            .and_then(|r| r.split_once(';'))
            .map(|(_, cmd)| cmd)
            .unwrap_or(raw)
            .trim();
        if cleaned.is_empty() || cleaned.len() > 500 {
            continue;
        }
        if seen.insert(cleaned.to_string()) {
            lines.push(cleaned.to_string());
            if lines.len() as u32 >= limit {
                break;
            }
        }
    }
    Ok(lines)
}

#[derive(Default)]
pub struct FollowState {
    /// clé → interrupteur d'arrêt du suivi.
    follows: Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>,
}

impl FollowState {
    /// Enregistre un suivi et rend son signal d'arrêt.
    ///
    /// Réutilisé par le module Docker : les journaux d'un conteneur se suivent
    /// exactement comme un fichier, et partagent donc le même registre.
    pub(crate) async fn register(&self, key: String) -> tokio::sync::watch::Receiver<bool> {
        let (tx, rx) = tokio::sync::watch::channel(false);
        // Un suivi déjà en place sous la même clé est remplacé, pas dupliqué.
        if let Some(ancien) = self.follows.lock().await.insert(key, tx) {
            let _ = ancien.send(true);
        }
        rx
    }

    /// Retire un suivi du registre (sans l'arrêter : il vient de se terminer).
    pub(crate) async fn forget(&self, key: &str) {
        self.follows.lock().await.remove(key);
    }
}

/// Suit un fichier distant en continu (`tail -F`) et émet chaque bloc reçu
/// sous l'évènement « follow-<clé> ».
#[tauri::command]
pub async fn follow_start(
    app: AppHandle,
    ssh: State<'_, SshState>,
    state: State<'_, FollowState>,
    id: String,
    key: String,
    path: String,
    lines: Option<u32>,
) -> Result<(), String> {
    let handle = {
        let sessions = ssh.sessions.lock().await;
        sessions.get(&id).ok_or("Session inconnue")?.handle.clone()
    };
    let mut channel = handle
        .channel_open_session()
        .await
        .map_err(|e| e.to_string())?;
    let cmd = format!(
        "tail -n {} -F {} 2>&1",
        lines.unwrap_or(200).min(5000),
        shell_quote(&path)
    );
    channel.exec(false, cmd).await.map_err(|e| e.to_string())?;

    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    state.follows.lock().await.insert(key.clone(), stop_tx);

    let evt = format!("follow-{key}");
    let end_evt = format!("follow-end-{key}");
    tokio::spawn(async move {
        use tauri::Manager;
        loop {
            tokio::select! {
                msg = channel.wait() => match msg {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = app.emit(&evt, String::from_utf8_lossy(&data).to_string());
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                    Some(_) => {}
                },
                _ = stop_rx.changed() => break,
            }
        }
        let _ = channel.eof().await;
        let _ = app.emit(&end_evt, ());
        let st = app.state::<FollowState>();
        st.follows.lock().await.remove(&key);
    });
    Ok(())
}

#[tauri::command]
pub async fn follow_stop(state: State<'_, FollowState>, key: String) -> Result<(), String> {
    if let Some(tx) = state.follows.lock().await.remove(&key) {
        let _ = tx.send(true);
    }
    Ok(())
}
