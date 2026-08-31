import { invoke } from "@tauri-apps/api/core";

export interface ConnectOptions {
  host: string;
  port: number;
  username: string;
  password?: string;
  keyPath?: string;
  keyPassphrase?: string;
  useAgent?: boolean;
  /** Rebond par bastion : "user@host:port", plusieurs sauts séparés par des virgules. */
  jump?: string;
  trustFingerprint?: string;
  /** Empreintes acceptées pour les bastions traversés. */
  trustJump?: string[];
}

export interface HostKeyIssue {
  kind: "unknown" | "changed";
  algo: string;
  fingerprint: string;
  /** "hôte:port" concerné — permet de distinguer un bastion de la cible. */
  origin?: string;
}

export function parseHostKeyIssue(err: unknown): HostKeyIssue | null {
  const msg = String(err);
  const m = msg.match(
    /^(UNKNOWN_HOST_KEY|HOST_KEY_CHANGED)\|([^|]+)\|([^|]+)(?:\|(.+))?$/,
  );
  if (!m) return null;
  return {
    kind: m[1] === "UNKNOWN_HOST_KEY" ? "unknown" : "changed",
    algo: m[2],
    fingerprint: m[3],
    origin: m[4],
  };
}

export interface SessionInfo {
  id: string;
  homeDir: string;
}

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isLink: boolean;
  size: number;
  mtime: number | null;
  permissions: number | null;
  user: string | null;
  group: string | null;
}

export type AuthMethod = "password" | "key" | "agent";

export interface SavedConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthMethod;
  keyPath?: string;
  /** Rebond par bastion (ProxyJump). */
  jump?: string;
  /** Groupe d'appartenance dans le port d'attache. */
  group?: string;
  /** Couleur d'accent (repère visuel prod/préprod…). */
  color?: string;
  /** Commandes jouées automatiquement à la connexion. */
  profile?: string[];
}

export interface SshConfigHost {
  alias: string;
  hostName: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  proxyJump: string | null;
}

export interface TransferProgress {
  sessionId: string;
  transferId: string;
  fileName: string;
  transferred: number;
  total: number;
  direction: "upload" | "download";
  done: boolean;
  cancelled: boolean;
}

export const sshConnect = (opts: ConnectOptions) =>
  invoke<SessionInfo>("ssh_connect", { opts });

export const sshDisconnect = (id: string) => invoke<void>("ssh_disconnect", { id });

export const sftpList = (id: string, path: string) =>
  invoke<FileEntry[]>("sftp_list", { id, path });

export const sftpMkdir = (id: string, path: string) =>
  invoke<void>("sftp_mkdir", { id, path });

export const sftpRemove = (id: string, path: string, isDir: boolean) =>
  invoke<void>("sftp_remove", { id, path, isDir });

export const sftpRename = (id: string, from: string, to: string) =>
  invoke<void>("sftp_rename", { id, from, to });

export const sftpChmod = (id: string, path: string, mode: number) =>
  invoke<void>("sftp_chmod", { id, path, mode });

export const sftpDownload = (
  id: string,
  transferId: string,
  remotePath: string,
  localPath: string,
  resume = false,
) =>
  invoke<void>("sftp_download", {
    id,
    transferId,
    remotePath,
    localPath,
    resume,
  });

export const sftpUpload = (
  id: string,
  transferId: string,
  localPath: string,
  remotePath: string,
  resume = false,
) =>
  invoke<void>("sftp_upload", {
    id,
    transferId,
    localPath,
    remotePath,
    resume,
  });

export const shellOpen = (id: string, shellId: string, cols: number, rows: number) =>
  invoke<void>("shell_open", { id, shellId, cols, rows });

export const shellWrite = (id: string, shellId: string, data: string) =>
  invoke<void>("shell_write", { id, shellId, data });

export const shellResize = (id: string, shellId: string, cols: number, rows: number) =>
  invoke<void>("shell_resize", { id, shellId, cols, rows });

export const shellClose = (id: string, shellId: string) =>
  invoke<void>("shell_close", { id, shellId });

export const localOpen = (termId: string, cols: number, rows: number) =>
  invoke<void>("local_open", { termId, cols, rows });

export const localWrite = (termId: string, data: string) =>
  invoke<void>("local_write", { termId, data });

export const localResize = (termId: string, cols: number, rows: number) =>
  invoke<void>("local_resize", { termId, cols, rows });

export const localClose = (termId: string) => invoke<void>("local_close", { termId });

export type TermTarget =
  { kind: "ssh"; sessionId: string; shellId: string } | { kind: "local"; termId: string };

export const termEvents = (t: TermTarget) =>
  t.kind === "ssh"
    ? {
        data: `shell-data-${t.sessionId}-${t.shellId}`,
        closed: `shell-closed-${t.sessionId}-${t.shellId}`,
      }
    : { data: `local-data-${t.termId}`, closed: `local-closed-${t.termId}` };

export const termOpen = (t: TermTarget, cols: number, rows: number) =>
  t.kind === "ssh"
    ? shellOpen(t.sessionId, t.shellId, cols, rows)
    : localOpen(t.termId, cols, rows);

export const termWrite = (t: TermTarget, data: string) =>
  t.kind === "ssh"
    ? shellWrite(t.sessionId, t.shellId, data)
    : localWrite(t.termId, data);

export const termResize = (t: TermTarget, cols: number, rows: number) =>
  t.kind === "ssh"
    ? shellResize(t.sessionId, t.shellId, cols, rows)
    : localResize(t.termId, cols, rows);

export const termClose = (t: TermTarget) =>
  t.kind === "ssh" ? shellClose(t.sessionId, t.shellId) : localClose(t.termId);

export const transferCancel = (transferId: string) =>
  invoke<void>("transfer_cancel", { transferId });

export interface EditSync {
  sessionId: string;
  remotePath: string;
  fileName: string;
  status: "opened" | "uploaded" | "error";
  message: string | null;
}

export const editOpen = (id: string, remotePath: string, editorApp?: string) =>
  invoke<void>("edit_open", { id, remotePath, editorApp });

export const sshConfigHosts = () => invoke<SshConfigHost[]>("ssh_config_hosts");

export const shellCwd = (id: string, pid: number) =>
  invoke<string | null>("shell_cwd", { id, pid });

export interface LocalPubKey {
  path: string;
  privatePath: string | null;
  algo: string;
  comment: string;
  line: string;
}

export const localPublicKeys = () => invoke<LocalPubKey[]>("local_public_keys");

export const sftpTouch = (id: string, path: string) =>
  invoke<void>("sftp_touch", { id, path });

export const remoteDu = (id: string, path: string) =>
  invoke<string>("remote_du", { id, path });

export interface DiskUsage {
  filesystem: string;
  size: string;
  used: string;
  avail: string;
  percent: string;
  mount: string;
}

export const remoteDf = (id: string, path: string) =>
  invoke<DiskUsage | null>("remote_df", { id, path });

export interface Tunnel {
  id: string;
  sessionId: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  kind: "local" | "remote" | "socks";
  connections: number;
}

export const tunnelOpen = (
  id: string,
  localPort: number,
  remoteHost: string,
  remotePort: number,
) => invoke<Tunnel>("tunnel_open", { id, localPort, remoteHost, remotePort });

export const tunnelClose = (tunnelId: string) =>
  invoke<void>("tunnel_close", { tunnelId });

export const tunnelList = () => invoke<Tunnel[]>("tunnel_list");

/** Installe une clé publique dans authorized_keys du serveur ; "added" | "already". */
export const sshCopyId = (id: string, keyLine: string) =>
  invoke<string>("ssh_copy_id", { id, keyLine });

export const credSet = (account: string, password: string) =>
  invoke<void>("cred_set", { account, password });

export const credGet = (account: string) =>
  invoke<string | null>("cred_get", { account });

export const credDelete = (account: string) => invoke<void>("cred_delete", { account });

export function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

export function parentPath(path: string): string {
  if (path === "/" || path === "") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  const units = ["Ko", "Mo", "Go", "To"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(mtime: number | null): string {
  if (!mtime) return "—";
  const d = new Date(mtime * 1000);
  return d.toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatPermissions(perm: number | null, isDir: boolean): string {
  if (perm == null) return "—";
  const rwx = (bits: number) =>
    `${bits & 4 ? "r" : "-"}${bits & 2 ? "w" : "-"}${bits & 1 ? "x" : "-"}`;
  return `${isDir ? "d" : "-"}${rwx((perm >> 6) & 7)}${rwx((perm >> 3) & 7)}${rwx(perm & 7)}`;
}

// ─── Outils serveur ──────────────────────────────────────────────

export const remoteArchive = (
  id: string,
  dir: string,
  names: string[],
  archiveName: string,
  format: "tar.gz" | "tar.bz2" | "zip",
) => invoke<string>("remote_archive", { id, dir, names, archiveName, format });

export const remoteExtract = (id: string, archivePath: string, into?: string) =>
  invoke<void>("remote_extract", { id, archivePath, into });

export interface SearchHit {
  path: string;
  isDir: boolean;
}

export const remoteSearch = (
  id: string,
  root: string,
  pattern: string,
  contains?: string,
  maxResults?: number,
) =>
  invoke<SearchHit[]>("remote_search", {
    id,
    root,
    pattern,
    contains,
    maxResults,
  });

export const remoteSha256 = (id: string, path: string) =>
  invoke<string>("remote_sha256", { id, path });

export const localSha256 = (path: string) => invoke<string>("local_sha256", { path });

export const sftpTrash = (id: string, paths: string[]) =>
  invoke<number>("sftp_trash", { id, paths });

/** Déplace des fichiers locaux vers la corbeille macOS. */
export const localTrash = (paths: string[]) =>
  invoke<number>("local_trash", { paths });

export interface DiffEntry {
  name: string;
  status: "local" | "remote" | "differs" | "same";
  localSize: number | null;
  remoteSize: number | null;
  localMtime: number | null;
  remoteMtime: number | null;
}

export const compareDirs = (id: string, localDir: string, remoteDir: string) =>
  invoke<DiffEntry[]>("compare_dirs", { id, localDir, remoteDir });

export const serverToServer = (
  fromId: string,
  fromPath: string,
  toId: string,
  toPath: string,
  transferId: string,
) =>
  invoke<void>("server_to_server", {
    fromId,
    fromPath,
    toId,
    toPath,
    transferId,
  });

export interface ServerStats {
  uptime: string;
  load: string;
  memUsed: string;
  memTotal: string;
  cpuCount: string;
  top: string[];
  kernel: string;
}

export const remoteStats = (id: string) => invoke<ServerStats>("remote_stats", { id });

export interface ServiceItem {
  name: string;
  status: string;
  detail: string;
}

export const remoteServices = (id: string, kind: "docker" | "systemd") =>
  invoke<ServiceItem[]>("remote_services", { id, kind });

export const remoteServiceAction = (
  id: string,
  kind: "docker" | "systemd",
  name: string,
  action: "start" | "stop" | "restart",
) => invoke<string>("remote_service_action", { id, kind, name, action });

export interface Preview {
  kind: "text" | "image" | "binary";
  content: string;
  truncated: boolean;
  size: number;
}

export const remotePreview = (id: string, path: string) =>
  invoke<Preview>("remote_preview", { id, path });

export interface KnownHostLine {
  line: number;
  hosts: string;
  algo: string;
}

export const knownHostsList = () => invoke<KnownHostLine[]>("known_hosts_list");
export const knownHostsRemove = (line: number) =>
  invoke<void>("known_hosts_remove", { line });

export const tunnelOpenRemote = (
  id: string,
  remotePort: number,
  localHost: string,
  localPort: number,
) =>
  invoke<Tunnel>("tunnel_open_remote", {
    id,
    remotePort,
    localHost,
    localPort,
  });

export const tunnelOpenSocks = (id: string, localPort: number) =>
  invoke<Tunnel>("tunnel_open_socks", { id, localPort });

export const logStart = (key: string, path: string) =>
  invoke<void>("log_start", { key, path });
export const logWrite = (key: string, data: string) =>
  invoke<void>("log_write", { key, data });
export const logStop = (key: string) => invoke<void>("log_stop", { key });
export const logActive = () => invoke<string[]>("log_active");

export const configExport = (path: string, json: string) =>
  invoke<void>("config_export", { path, json });

export const configImport = (path: string) => invoke<string>("config_import", { path });

export const sftpWriteText = (id: string, path: string, content: string) =>
  invoke<void>("sftp_write_text", { id, path, content });

export const sftpReadText = (id: string, path: string) =>
  invoke<string>("sftp_read_text", { id, path });

/**
 * Exécute le client Docker sur une cible : null pour la machine locale, sinon
 * l'identifiant d'une session SSH ouverte. Rend la sortie brute, à décoder
 * avec les fonctions de `docker.ts`.
 */
export const dockerCli = (session: string | null, args: string[], timeoutSecs?: number) =>
  invoke<string>("docker_cli", { session, args, timeoutSecs });

/**
 * Suit les journaux d'un conteneur en direct. Les blocs arrivent par
 * l'évènement « docker-log-<clé> », la fin par « docker-log-end-<clé> ».
 */
export const dockerLogsFollow = (
  session: string | null,
  key: string,
  container: string,
  tail?: number,
) => invoke<void>("docker_logs_follow", { session, key, container, tail });

export const dockerLogsStop = (key: string) => invoke<void>("docker_logs_stop", { key });

/** Version du démon Docker sur la cible, ou l'explication de son absence. */
export const dockerProbe = (session: string | null) =>
  invoke<string>("docker_probe", { session });

/** Lit un fichier local en texte ; null si trop gros, binaire ou non UTF-8. */
export const localReadText = (path: string) =>
  invoke<string | null>("local_read_text", { path });

export const remoteHistory = (id: string, limit?: number) =>
  invoke<string[]>("remote_history", { id, limit });

export const followStart = (id: string, key: string, path: string, lines?: number) =>
  invoke<void>("follow_start", { id, key, path, lines });

export const followStop = (key: string) => invoke<void>("follow_stop", { key });

/** Exécute une commande sur le serveur et renvoie sa sortie brute. */
export const remoteRun = (id: string, command: string, timeoutSecs?: number) =>
  invoke<string>("remote_run", { id, command, timeoutSecs });

/**
 * Exécute le client Git dans un dossier de la cible : null pour la machine
 * locale, sinon l'identifiant d'une session SSH ouverte. Rend la sortie
 * brute, à décoder avec les fonctions de `git.ts`.
 */
export const gitCli = (
  session: string | null,
  cwd: string,
  args: string[],
  timeoutSecs?: number,
) => invoke<string>("git_cli", { session, cwd, args, timeoutSecs });
