import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  Boxes,
  ArrowDown,
  ArrowUp,
  Check,
  FolderSync,
  FolderTree,
  Pencil,
  Activity,
  Radio,
  Maximize2,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Cable,
  Copy,
  GitBranch,
  HardDrive,
  KeyRound,
  ListOrdered,
  Loader,
  Lock,
  LockOpen,
  ScrollText,
  Sparkles,
  Zap,
  Settings as SettingsIcon,
  SquareTerminal,
  TriangleAlert,
  X,
} from "lucide-react";
import {
  ConnectOptions,
  EditSync,
  FileEntry,
  HostKeyIssue,
  SavedConnection,
  SshConfigHost,
  TransferProgress,
  credDelete,
  credGet,
  credSet,
  formatSize,
  localClose,
  localTrash,
  parseHostKeyIssue,
  remoteDf,
  remoteHistory,
  serverToServer,
  sshCopyId,
  shellCwd,
  shellWrite,
  localWrite,
  sshConfigHosts,
  sshConnect,
  sshDisconnect,
  sftpTrash,
  termClose,
  termWrite,
  transferCancel,
} from "./api";
import { PaneNode, leaf, leavesOf, removePane, setRatio, splitPane } from "./panes";
import { DiskUsage } from "./api";
import { Settings, loadSettings, saveSettings } from "./settings";
import {
  Snippet,
  loadSnippets,
  placeholdersOf,
  saveSnippets,
} from "./snippets";
import { useTransferQueue } from "./hooks/useTransferQueue";
import { useAppMenu } from "./hooks/useAppMenu";
import { Workspace, loadWorkspaces, saveWorkspaces } from "./workspaces";
import { setShortcuts } from "./shortcuts";
import { isSensitive } from "./guards";
import ConnectModal, { ConnectMeta } from "./components/ConnectModal";
import FileBrowser from "./components/FileBrowser";
import PaneTree from "./components/PaneTree";
import SettingsModal from "./components/SettingsModal";
import TunnelsModal from "./components/TunnelsModal";
import CommandPalette, { PaletteItem } from "./components/CommandPalette";
import DashboardModal from "./components/DashboardModal";
import CompareModal from "./components/CompareModal";
import KnownHostsModal from "./components/KnownHostsModal";
import StyledViewModal from "./components/StyledViewModal";
import DockerModal, { DockerTarget } from "./components/DockerModal";
import GitModal, { GitTarget } from "./components/GitModal";
import SnippetVarsModal from "./components/SnippetVarsModal";
import EditorModal from "./components/EditorModal";
import LogViewModal from "./components/LogViewModal";
import ErrorLogModal, { LoggedError } from "./components/ErrorLogModal";
import HistoryPalette from "./components/HistoryPalette";
import QueuePanel from "./components/QueuePanel";
import TerminalPane from "./components/TerminalPane";
import "./App.css";

interface Session {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  homeDir: string;
  // Gardé en mémoire (jamais persisté) pour permettre la reconnexion en un clic.
  opts: ConnectOptions;
}

type Tab =
  { kind: "ssh"; session: Session } | { kind: "local"; id: string; name: string };

const tabId = (t: Tab) => (t.kind === "ssh" ? t.session.id : t.id);
const tabName = (t: Tab) => (t.kind === "ssh" ? t.session.name : t.name);

interface TermState {
  tree: PaneNode | null; // null = tous les panneaux fermés (session terminée)
  focused: string;
}

const STORE_KEY = "cabestan.connections";

/** Demande un dossier local (pour la comparaison). */
async function openDirDialog(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({
    directory: true,
    title: "Dossier local à comparer",
  });
  return typeof picked === "string" ? picked : null;
}

function loadSaved(): SavedConnection[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]");
  } catch {
    return [];
  }
}

// ─── Vue session SSH ─────────────────────────────────────────────

function SessionView({
  session,
  visible,
  showFiles,
  sync,
  settings,
  term,
  focusedPid,
  onReconnect,
  onRatio,
  onFocusPane,
  onPaneClosed,
  onShellPid,
  onDisk,
  zone,
  onZone,
  autoReconnect,
  onCompare,
  onNotify,
  otherSessions,
  onCopyToServer,
  onEnqueue,
  zoomed,
  broadcast,
  onSplitPane,
  onZoomPane,
  onRequestClosePane,
  onStyledView,
  readOnly,
  sensitive,
  connName,
  onEditFile,
  onFollowFile,
  onRunStyled,
}: {
  session: Session;
  visible: boolean;
  showFiles: boolean;
  sync: boolean;
  settings: Settings;
  term: TermState;
  focusedPid: number | null;
  onReconnect: (session: Session) => Promise<void>;
  onRatio: (path: string, ratio: number) => void;
  onFocusPane: (paneId: string) => void;
  onPaneClosed: (paneId: string) => void;
  onShellPid: (paneId: string, pid: number) => void;
  onDisk: (d: DiskUsage | null) => void;
  zone: "files" | "term";
  onZone: (z: "files" | "term") => void;
  autoReconnect: boolean;
  onCompare: (remoteDir: string) => void;
  onNotify: (kind: "ok" | "err", text: string) => void;
  otherSessions: Array<{ id: string; name: string; homeDir: string }>;
  onCopyToServer: (entry: FileEntry, targetId: string, targetDir: string) => void;
  onEnqueue: (kind: "upload" | "download", localPath: string, remotePath: string) => void;
  /** Panneau agrandi temporairement (zoom façon tmux). */
  zoomed: string | null;
  /** Diffusion de la saisie à tous les panneaux. */
  broadcast: boolean;
  onSplitPane: (paneId: string, dir: "row" | "col") => void;
  onZoomPane: () => void;
  onRequestClosePane: (paneId: string) => void;
  onStyledView: (cmd: string, output?: string) => void;
  /** Session en lecture seule : les écritures sont bloquées. */
  readOnly: boolean;
  /** Connexion marquée sensible (prod). */
  sensitive: boolean;
  connName: string;
  onEditFile: (path: string) => void;
  onFollowFile: (path: string) => void;
  onRunStyled: (cmd: string) => void;
}) {
  const [split, setSplit] = useState(0.55);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectError, setReconnectError] = useState<string | null>(null);
  const [syncPath, setSyncPath] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  const dead = term.tree === null;

  // Espace disque du dossier personnel, rafraîchi de loin en loin.
  useEffect(() => {
    if (!visible || dead) return;
    let stop = false;
    const tick = () =>
      remoteDf(session.id, session.homeDir)
        .then((d) => {
          if (!stop) onDisk(d);
        })
        .catch(() => {});
    tick();
    const t = setInterval(tick, 60000);
    return () => {
      stop = true;
      clearInterval(t);
    };
    // onDisk est stable (useCallback côté App)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, dead, session.id, session.homeDir]);

  // Sondage du dossier courant du shell du panneau actif.
  useEffect(() => {
    if (!sync || !focusedPid || !visible || dead) return;
    let stop = false;
    const tick = async () => {
      try {
        const cwd = await shellCwd(session.id, focusedPid);
        if (!stop && cwd) setSyncPath(cwd);
      } catch {
        // session fermée ou serveur sans /proc : on réessaiera au tick suivant
      }
    };
    tick();
    const t = setInterval(tick, 1500);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [sync, focusedPid, visible, dead, session.id]);

  // Navigation utilisateur dans l'explorateur → cd dans le panneau actif.
  const focusedRef = useRef(term.focused);
  focusedRef.current = term.focused;
  const onUserNavigate = useCallback(
    (path: string) => {
      if (!syncRef.current) return;
      const quoted = `'${path.replace(/'/g, `'\\''`)}'`;
      // \x15 (ctrl-U) efface une éventuelle saisie en cours avant le cd.
      shellWrite(session.id, focusedRef.current, `\x15cd ${quoted}\n`).catch(() => {});
    },
    [session.id],
  );

  const onCdHere = useCallback(
    (p: string) => {
      const quoted = `'${p.replace(/'/g, `'\\''`)}'`;
      shellWrite(session.id, focusedRef.current, `\x15cd ${quoted}\n`).catch(() => {});
    },
    [session.id],
  );

  // Action contextuelle « terminal » : la commande est jouée dans le panneau actif,
  // visible et interruptible par l'utilisateur.
  const onRunHere = useCallback(
    (cmd: string) => {
      shellWrite(session.id, focusedRef.current, `\x15${cmd}\n`).catch(() => {});
    },
    [session.id],
  );

  const reconnect = async () => {
    setReconnecting(true);
    setReconnectError(null);
    try {
      await onReconnect(session);
    } catch (e) {
      setReconnectError(String(e));
      setReconnecting(false);
    }
  };

  // Reconnexion automatique : 2 s, 4 s, 8 s… plafonnée, puis on laisse la main.
  const [autoTry, setAutoTry] = useState(0);
  const [nextTry, setNextTry] = useState<number | null>(null);
  const MAX_TRIES = 5;

  useEffect(() => {
    // Une session vivante remet le compteur à zéro.
    if (!dead) {
      setAutoTry(0);
      setNextTry(null);
      return;
    }
    if (!autoReconnect || reconnecting || autoTry >= MAX_TRIES) return;

    const delay = Math.min(2000 * 2 ** autoTry, 30000);
    setNextTry(Math.round(delay / 1000));
    const tick = setInterval(
      () => setNextTry((v) => (v === null ? null : Math.max(0, v - 1))),
      1000,
    );
    const timer = setTimeout(() => {
      setAutoTry((n) => n + 1);
      setReconnecting(true);
      setReconnectError(null);
      onReconnect(session).catch((e) => {
        setReconnectError(String(e));
        setReconnecting(false);
      });
    }, delay);
    return () => {
      clearTimeout(timer);
      clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dead, autoReconnect, autoTry, reconnecting]);

  const onDividerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      const ratio = (ev.clientY - rect.top) / rect.height;
      setSplit(Math.min(0.85, Math.max(0.15, ratio)));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div
      className="session-view"
      ref={containerRef}
      style={{ display: visible ? "flex" : "none" }}
    >
      {sensitive && (
        <div className="prod-banner">
          Serveur sensible — les suppressions demandent une confirmation renforcée
          {readOnly && " · session en lecture seule"}
        </div>
      )}
      <div
        className="pane-files"
        style={{
          flexBasis: `${split * 100}%`,
          display: showFiles ? "flex" : "none",
        }}
      >
        <FileBrowser
          sessionId={session.id}
          homeDir={session.homeDir}
          active={visible && showFiles}
          hideHidden={settings.hideHidden}
          syncPath={sync ? syncPath : null}
          bookmarkKey={`${session.username}@${session.host}:${session.port}`}
          zoneActive={zone === "files"}
          onZone={() => onZone("files")}
          onUserNavigate={onUserNavigate}
          onCdHere={onCdHere}
          useTrash={settings.useTrash}
          editorApp={settings.editorApp}
          otherSessions={otherSessions}
          onCopyToServer={onCopyToServer}
          onEnqueue={onEnqueue}
          onCompare={onCompare}
          onNotify={onNotify}
          readOnly={readOnly}
          sensitive={sensitive}
          connName={connName}
          onEditFile={onEditFile}
          onFollowFile={onFollowFile}
          onRunHere={onRunHere}
          onRunStyled={onRunStyled}
        />
      </div>
      {showFiles && (
        <div
          className="divider"
          onPointerDown={onDividerDown}
          role="separator"
          aria-orientation="horizontal"
        />
      )}
      <div className="pane-term">
        {term.tree ? (
          zoomed && leavesOf(term.tree).includes(zoomed) ? (
            <TerminalPane
              target={{ kind: "ssh", sessionId: session.id, shellId: zoomed }}
              visible={visible}
              focused
              fontSize={settings.termFontSize}
              fontFamily={settings.termFontFamily}
              cursorBlink={settings.termCursorBlink}
              scrollback={settings.termScrollback}
              theme={settings.termTheme}
              searchEnabled={zone === "term"}
              broadcast={broadcast}
              onShellPid={(pid) => onShellPid(zoomed, pid)}
              onClosed={() => onPaneClosed(zoomed)}
              onFocus={() => {
                onZone("term");
                onFocusPane(zoomed);
              }}
              onSplit={(dir) => onSplitPane(zoomed, dir)}
              onZoom={onZoomPane}
              onClosePane={() => onRequestClosePane(zoomed)}
            />
          ) : (
            <PaneTree
              node={term.tree}
              onRatio={onRatio}
              renderLeaf={(paneId) => (
                <TerminalPane
                  target={{
                    kind: "ssh",
                    sessionId: session.id,
                    shellId: paneId,
                  }}
                  visible={visible}
                  focused={term.focused === paneId}
                  fontSize={settings.termFontSize}
                  fontFamily={settings.termFontFamily}
                  cursorBlink={settings.termCursorBlink}
                  scrollback={settings.termScrollback}
                  theme={settings.termTheme}
                  searchEnabled={zone === "term"}
                  broadcast={broadcast}
                  onShellPid={(pid) => onShellPid(paneId, pid)}
                  onClosed={() => onPaneClosed(paneId)}
                  onFocus={() => {
                    onZone("term");
                    onFocusPane(paneId);
                  }}
                  onSplit={(dir) => onSplitPane(paneId, dir)}
                  onZoom={onZoomPane}
                  onClosePane={() => onRequestClosePane(paneId)}
                  onStyledView={onStyledView}
                />
              )}
            />
          )
        ) : (
          <div className="term-dead">
            <p className="dead-text">
              Connexion à{" "}
              <code>
                {session.username}@{session.host}
              </code>{" "}
              terminée.
            </p>
            {reconnectError && <p className="dead-error">{reconnectError}</p>}
            {autoReconnect &&
              !reconnecting &&
              autoTry < MAX_TRIES &&
              nextTry !== null && (
                <p className="dead-auto">
                  Nouvelle tentative dans {nextTry} s (essai {autoTry + 1}/{MAX_TRIES})
                </p>
              )}
            {autoReconnect && autoTry >= MAX_TRIES && (
              <p className="dead-auto">
                {MAX_TRIES} tentatives sans succès — reprise manuelle.
              </p>
            )}
            <button className="btn primary" onClick={reconnect} disabled={reconnecting}>
              {reconnecting ? "Reconnexion…" : "Reconnecter"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Vue terminal local ──────────────────────────────────────────

function LocalView({
  id,
  visible,
  settings,
  term,
  onRatio,
  onFocusPane,
  onPaneClosed,
  onSplitPane,
  onZoomPane,
  onRequestClosePane,
}: {
  id: string;
  visible: boolean;
  settings: Settings;
  term: TermState;
  onRatio: (path: string, ratio: number) => void;
  onFocusPane: (paneId: string) => void;
  onPaneClosed: (paneId: string) => void;
  onSplitPane: (paneId: string, dir: "row" | "col") => void;
  onZoomPane: () => void;
  onRequestClosePane: (paneId: string) => void;
}) {
  void id;
  return (
    <div className="session-view" style={{ display: visible ? "flex" : "none" }}>
      <div className="pane-term full">
        {term.tree && (
          <PaneTree
            node={term.tree}
            onRatio={onRatio}
            renderLeaf={(paneId) => (
              <TerminalPane
                target={{ kind: "local", termId: paneId }}
                visible={visible}
                focused={term.focused === paneId}
                fontSize={settings.termFontSize}
                fontFamily={settings.termFontFamily}
                cursorBlink={settings.termCursorBlink}
                scrollback={settings.termScrollback}
                theme={settings.termTheme}
                onClosed={() => onPaneClosed(paneId)}
                onFocus={() => onFocusPane(paneId)}
                onSplit={(dir) => onSplitPane(paneId, dir)}
                onZoom={onZoomPane}
                onClosePane={() => onRequestClosePane(paneId)}
              />
            )}
          />
        )}
      </div>
    </div>
  );
}

// ─── Application ─────────────────────────────────────────────────

export default function App() {
  const [saved, setSaved] = useState<SavedConnection[]>(loadSaved);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [modal, setModal] = useState<{
    open: boolean;
    prefill: SavedConnection | null;
    mode?: "connect" | "edit";
    error?: string | null;
    hostKey?: HostKeyIssue | null;
  }>({ open: false, prefill: null });
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [notices, setNotices] = useState<
    Array<{ id: string; kind: "ok" | "err"; text: string }>
  >([]);
  const [transfers, setTransfers] = useState<TransferProgress[]>([]);
  const [syncs, setSyncs] = useState<Array<EditSync & { key: string }>>([]);
  const [configHosts, setConfigHosts] = useState<SshConfigHost[]>([]);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [panes, setPanes] = useState<Record<string, { files: boolean; sync: boolean }>>(
    {},
  );
  const [terms, setTerms] = useState<Record<string, TermState>>({});
  const [pids, setPids] = useState<Record<string, number>>({});
  const [localCount, setLocalCount] = useState(0);
  const [renamingTab, setRenamingTab] = useState<string | null>(null);
  const [tabNameDraft, setTabNameDraft] = useState("");
  const [tunnelsFor, setTunnelsFor] = useState<Session | null>(null);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
  const [disks, setDisks] = useState<Record<string, DiskUsage | null>>({});
  // Quelle zone reçoit ⌘F : l'explorateur ou le terminal.
  const [zone, setZone] = useState<"files" | "term">("term");
  const [zoomed, setZoomed] = useState<string | null>(null);
  const [broadcast, setBroadcast] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dashboardFor, setDashboardFor] = useState<Session | null>(null);
  const [compareFor, setCompareFor] = useState<{
    session: Session;
    remoteDir: string;
    localDir: string;
  } | null>(null);
  const [knownHostsOpen, setKnownHostsOpen] = useState(false);
  const [dockerOpen, setDockerOpen] = useState(false);
  const [gitOpen, setGitOpen] = useState(false);
  // Snippet dont les {{variables}} restent à remplir avant l'envoi.
  const [snippetVars, setSnippetVars] = useState<{
    command: string;
    names: string[];
  } | null>(null);
  const [appVersion, setAppVersion] = useState("");
  const [errors, setErrors] = useState<LoggedError[]>([]);
  const [errorLogOpen, setErrorLogOpen] = useState(false);
  const [readOnly, setReadOnly] = useState<Record<string, boolean>>({});
  const [editorFor, setEditorFor] = useState<{
    session: Session;
    path: string;
  } | null>(null);
  const [logFor, setLogFor] = useState<{
    session: Session;
    path: string;
  } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [styledFor, setStyledFor] = useState<{
    session: Session;
    cmd: string;
    output?: string;
  } | null>(null);
  const [snippetList, setSnippetList] = useState<Snippet[]>(loadSnippets);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(loadWorkspaces);
  const [groupFilter, setGroupFilter] = useState("");
  const queue = useTransferQueue();
  const [queueOpen, setQueueOpen] = useState(false);
  const [dragTab, setDragTab] = useState<string | null>(null);
  const [dropTab, setDropTab] = useState<string | null>(null);
  // Ref plutôt qu'état : disponible immédiatement dans les évènements de glisser.
  const dragTabRef = useRef<string | null>(null);

  /** Réordonne les onglets : `from` vient se placer à l'emplacement de `to`. */
  const moveTab = useCallback((from: string, to: string) => {
    setTabs((prev) => {
      const iFrom = prev.findIndex((t) => tabId(t) === from);
      const iTo = prev.findIndex((t) => tabId(t) === to);
      if (iFrom < 0 || iTo < 0 || iFrom === iTo) return prev;
      const next = [...prev];
      const [moved] = next.splice(iFrom, 1);
      next.splice(iTo, 0, moved);
      return next;
    });
  }, []);

  useEffect(() => {
    saveSnippets(snippetList);
  }, [snippetList]);
  useEffect(() => {
    saveWorkspaces(workspaces);
  }, [workspaces]);

  useEffect(() => {
    saveSettings(settings);
  }, [settings]);

  // Reconstruit la barre de menus dès que les raccourcis changent.
  useEffect(() => {
    setShortcuts(settings.shortcuts).catch(() => {});
  }, [settings.shortcuts]);

  useEffect(() => {
    localStorage.setItem(STORE_KEY, JSON.stringify(saved));
  }, [saved]);

  useEffect(() => {
    sshConfigHosts()
      .then(setConfigHosts)
      .catch(() => {});
  }, []);

  // Mémorise les serveurs ouverts pour pouvoir les rouvrir au prochain lancement.
  useEffect(() => {
    const open = tabs
      .filter((t): t is Extract<Tab, { kind: "ssh" }> => t.kind === "ssh")
      .map((t) => `${t.session.username}@${t.session.host}:${t.session.port}`);
    localStorage.setItem("cabestan.lastTabs", JSON.stringify(open));
  }, [tabs]);

  const paneOf = useCallback(
    (id: string) =>
      panes[id] ?? { files: settings.filesDefault, sync: settings.syncDefault },
    [panes, settings.filesDefault, settings.syncDefault],
  );

  // Refs pour les gestionnaires de menu/clavier (évite les fermetures périmées).
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const termsRef = useRef(terms);
  termsRef.current = terms;
  const paneOfRef = useRef(paneOf);
  paneOfRef.current = paneOf;
  const savedRef = useRef(saved);
  savedRef.current = saved;
  // Sessions déjà signalées pour un disque presque plein (une alerte par session).
  const alertedRef = useRef<Set<string>>(new Set());

  const togglePane = useCallback((id: string, key: "files" | "sync") => {
    setPanes((prev) => {
      const cur = paneOfRef.current(id);
      return { ...prev, [id]: { ...cur, [key]: !cur[key] } };
    });
  }, []);

  // ─── Transferts et synchro d'édition ───────────────────────────

  useEffect(() => {
    let un: (() => void) | undefined;
    listen<TransferProgress>("transfer-progress", (e) => {
      const t = e.payload;
      setTransfers((prev) => {
        const next = prev.filter((p) => p.transferId !== t.transferId);
        next.push(t);
        return next;
      });
      if (t.done) {
        setTimeout(() => {
          setTransfers((prev) => prev.filter((p) => p.transferId !== t.transferId));
        }, 2500);
      }
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  useEffect(() => {
    let un: (() => void) | undefined;
    listen<EditSync>("edit-sync", (e) => {
      const s = e.payload;
      const key = `${s.sessionId}|${s.remotePath}`;
      setSyncs((prev) => [...prev.filter((p) => p.key !== key), { ...s, key }]);
      if (s.status !== "error") {
        setTimeout(() => {
          setSyncs((prev) =>
            prev.filter((p) => !(p.key === key && p.status !== "error")),
          );
        }, 3000);
      }
    }).then((u) => (un = u));
    return () => un?.();
  }, []);

  // ─── Cycle de vie des onglets ──────────────────────────────────

  // Version du bundle : sans elle, impossible de dire d'un coup d'œil si l'app
  // ouverte est bien la dernière installée.
  useEffect(() => {
    import("@tauri-apps/api/app")
      .then((m) => m.getVersion())
      .then(setAppVersion)
      .catch(() => {});
  }, []);

  const notify = useCallback((kind: "ok" | "err", text: string) => {
    const id = crypto.randomUUID();
    setNotices((prev) => [...prev, { id, kind, text }]);
    setTimeout(() => setNotices((prev) => prev.filter((n) => n.id !== id)), 6000);
    // Les erreurs restent consultables même après disparition du message.
    if (kind === "err") {
      setErrors((prev) => [...prev, { id, at: Date.now(), text }].slice(-50));
    }
    // Notification système quand l'app n'est pas au premier plan.
    if (document.visibilityState === "hidden") {
      import("@tauri-apps/plugin-notification")
        .then(async ({ isPermissionGranted, requestPermission, sendNotification }) => {
          let granted = await isPermissionGranted();
          if (!granted) granted = (await requestPermission()) === "granted";
          if (granted) {
            sendNotification({
              title: kind === "err" ? "Cabestan — erreur" : "Cabestan",
              body: text.slice(0, 160),
            });
          }
        })
        .catch(() => {});
    }
  }, []);

  const connect = useCallback(
    async (opts: ConnectOptions, meta: ConnectMeta) => {
      const info = await sshConnect(opts);
      const session: Session = {
        id: info.id,
        name: meta.name,
        host: opts.host,
        port: opts.port,
        username: opts.username,
        homeDir: info.homeDir,
        // Si le mot de passe part au Trousseau, on ne le garde pas en mémoire :
        // la reconnexion le relira depuis le Trousseau au moment voulu.
        opts: meta.savePassword ? { ...opts, password: undefined } : opts,
      };
      setTabs((prev) => [...prev, { kind: "ssh", session }]);
      const paneId = crypto.randomUUID();
      setTerms((prev) => ({
        ...prev,
        [info.id]: { tree: leaf(paneId), focused: paneId },
      }));

      // Profil : commandes jouées automatiquement dans le nouveau panneau.
      const profile = meta.profile ?? [];
      if (profile.length > 0) {
        setTimeout(() => {
          for (const cmd of profile) {
            shellWrite(info.id, paneId, `${cmd}\n`).catch(() => {});
          }
        }, 900);
      }
      setActiveId(info.id);
      setModal({ open: false, prefill: null });

      // ssh-copy-id : installe la clé publique puis bascule la connexion sur la clé,
      // pour ne plus avoir à conserver le mot de passe.
      let auth = meta.auth;
      let keyPath = opts.keyPath;
      if (meta.copyIdKey) {
        try {
          const res = await sshCopyId(info.id, meta.copyIdKey.line);
          auth = meta.copyIdKey.privatePath ? "key" : "agent";
          keyPath = meta.copyIdKey.privatePath ?? undefined;
          notify(
            "ok",
            res === "already"
              ? "Clé déjà présente sur le serveur — connexions suivantes sans mot de passe."
              : "Clé installée sur le serveur — connexions suivantes sans mot de passe.",
          );
        } catch (e) {
          notify("err", `Installation de la clé échouée : ${String(e)}`);
        }
      }

      if (meta.save) {
        const entryId = `${opts.username}@${opts.host}:${opts.port}`;
        setSaved((prev) => {
          const entry: SavedConnection = {
            id: entryId,
            name: meta.name,
            host: opts.host,
            port: opts.port,
            username: opts.username,
            auth,
            keyPath,
            jump: opts.jump,
            group: meta.group,
            color: meta.color,
            profile: meta.profile,
          };
          return [...prev.filter((c) => c.id !== entry.id), entry];
        });
        if (meta.savePassword && opts.password) {
          credSet(entryId, opts.password).catch(() => {});
        } else {
          credDelete(entryId).catch(() => {});
        }
      }
    },
    [notify],
  );

  /** Nouvel onglet sur le même serveur, sans redemander les identifiants. */
  const duplicateSession = useCallback(async (src: Session) => {
    const info = await sshConnect(src.opts);
    const session: Session = { ...src, id: info.id, homeDir: info.homeDir };
    setTabs((prev) => [...prev, { kind: "ssh", session }]);
    const paneId = crypto.randomUUID();
    setTerms((prev) => ({
      ...prev,
      [info.id]: { tree: leaf(paneId), focused: paneId },
    }));
    setActiveId(info.id);
  }, []);

  /** Envoie une commande toute prête dans le panneau actif. */
  const sendSnippet = useCallback((cmd: string) => {
    const tab = tabsRef.current.find((t) => tabId(t) === activeIdRef.current);
    const rec = termsRef.current[activeIdRef.current ?? ""];
    if (!tab || !rec?.tree) return;
    // Variables : {{host}}, {{user}}, {{path}}.
    if (tab.kind === "ssh") {
      cmd = cmd
        .split("{{host}}")
        .join(tab.session.host)
        .split("{{user}}")
        .join(tab.session.username)
        .split("{{path}}")
        .join(tab.session.homeDir);
    }
    const pane = rec.focused || leavesOf(rec.tree)[0];
    const target =
      tab.kind === "ssh"
        ? ({ kind: "ssh", sessionId: tab.session.id, shellId: pane } as const)
        : ({ kind: "local", termId: pane } as const);
    // \x15 efface une saisie en cours avant d'insérer la commande.
    termWrite(target, `\x15${cmd}\n`).catch(() => {});
    setSnippetsOpen(false);
  }, []);

  /**
   * Joue un snippet : s'il contient des {{variables}} personnalisées, on les
   * demande d'abord ; sinon il part tel quel.
   */
  const runSnippet = useCallback(
    (cmd: string) => {
      const names = placeholdersOf(cmd);
      if (names.length > 0) {
        setSnippetsOpen(false);
        setSnippetVars({ command: cmd, names });
        return;
      }
      sendSnippet(cmd);
    },
    [sendSnippet],
  );

  /** Connexion directe depuis le port d'attache : pas de formulaire si tout est là. */
  const quickConnect = useCallback(
    async (c: SavedConnection) => {
      setConnectingId(c.id);
      try {
        let password: string | undefined;
        if (c.auth === "password") {
          password = (await credGet(c.id).catch(() => null)) ?? undefined;
          if (!password) {
            // Rien dans le Trousseau : on ne demande que ce qui manque.
            setModal({ open: true, prefill: c, mode: "connect" });
            return;
          }
        }
        await connect(
          {
            host: c.host,
            port: c.port,
            username: c.username,
            password,
            keyPath: c.auth === "key" ? c.keyPath : undefined,
            useAgent: c.auth === "agent",
            jump: c.jump,
          },
          {
            name: c.name,
            save: true,
            savePassword: c.auth === "password" && !!password,
            auth: c.auth,
            copyIdKey: null,
            group: c.group,
            color: c.color,
            profile: c.profile,
          },
        );
      } catch (e) {
        // Empreinte à valider, passphrase à saisir, mot de passe refusé… :
        // on ouvre le formulaire avec le contexte.
        const hk = parseHostKeyIssue(e);
        setModal({
          open: true,
          prefill: c,
          mode: "connect",
          error: hk ? null : String(e),
          hostKey: hk,
        });
      } finally {
        setConnectingId(null);
      }
    },
    [connect],
  );

  /** Ouvre un terminal local et rend l'identifiant de son panneau. */
  const addLocalTab = useCallback(() => {
    const id = `local-${crypto.randomUUID()}`;
    setLocalCount((n) => n + 1);
    setTabs((prev) => [...prev, { kind: "local", id, name: `Local ${localCount + 1}` }]);
    const paneId = crypto.randomUUID();
    setTerms((prev) => ({
      ...prev,
      [id]: { tree: leaf(paneId), focused: paneId },
    }));
    setActiveId(id);
    return paneId;
  }, [localCount]);

  /**
   * Joue une commande dans un terminal de la cible : le panneau actif de la
   * session, ou un nouveau terminal local. Le délai laisse au shell le temps de
   * démarrer avant de recevoir la ligne.
   */
  const runInTerminal = useCallback(
    (targetId: string | null, command: string) => {
      if (targetId === null) {
        const paneId = addLocalTab();
        setTimeout(() => {
          localWrite(paneId, `${command}\n`).catch(() => {});
        }, 800);
        return;
      }
      const onglet = tabsRef.current.find((t) => tabId(t) === targetId);
      if (!onglet || onglet.kind !== "ssh") {
        notify("err", "Cette session n'est plus ouverte.");
        return;
      }
      const pane = termsRef.current[targetId]?.focused;
      if (!pane) {
        notify("err", "Aucun terminal ouvert dans cette session.");
        return;
      }
      setActiveId(targetId);
      // \x15 (ctrl-U) efface une saisie en cours avant d'envoyer la commande.
      shellWrite(targetId, pane, `\x15${command}\n`).catch((e: unknown) =>
        notify("err", String(e)),
      );
    },
    [addLocalTab, notify],
  );

  const closeTab = useCallback(async (id: string) => {
    const tab = tabsRef.current.find((t) => tabId(t) === id);
    setTabs((prev) => {
      const next = prev.filter((t) => tabId(t) !== id);
      setActiveId((cur) =>
        cur === id ? (next.length ? tabId(next[next.length - 1]) : null) : cur,
      );
      return next;
    });
    setTerms((prev) => {
      const { [id]: _, ...rest } = prev;
      return rest;
    });
    if (tab?.kind === "ssh") {
      try {
        await sshDisconnect(id);
      } catch {
        // déjà fermée
      }
    } else if (tab?.kind === "local") {
      const tree = termsRef.current[id]?.tree;
      if (tree) {
        for (const paneId of leavesOf(tree)) {
          localClose(paneId).catch(() => {});
        }
      }
    }
  }, []);

  const reconnectSession = useCallback(async (old: Session) => {
    let opts = old.opts;
    // Mot de passe absent de la mémoire (il est au Trousseau) : on le relit.
    if (!opts.password && !opts.keyPath && !opts.useAgent) {
      const stored = await credGet(`${old.username}@${old.host}:${old.port}`).catch(
        () => null,
      );
      if (stored) opts = { ...opts, password: stored };
    }
    const info = await sshConnect(opts);
    sshDisconnect(old.id).catch(() => {});
    setTabs((prev) =>
      prev.map((t) =>
        t.kind === "ssh" && t.session.id === old.id
          ? {
              kind: "ssh",
              session: { ...t.session, id: info.id, homeDir: info.homeDir },
            }
          : t,
      ),
    );
    setPanes((prev) => {
      const { [old.id]: kept, ...rest } = prev;
      return kept ? { ...rest, [info.id]: kept } : prev;
    });
    // La session garde les options effectivement utilisées.
    setTabs((prev) =>
      prev.map((t) =>
        t.kind === "ssh" && t.session.id === info.id
          ? { kind: "ssh", session: { ...t.session, opts } }
          : t,
      ),
    );
    setTerms((prev) => {
      const { [old.id]: _, ...rest } = prev;
      const paneId = crypto.randomUUID();
      return { ...rest, [info.id]: { tree: leaf(paneId), focused: paneId } };
    });
    setActiveId((cur) => (cur === old.id ? info.id : cur));
  }, []);

  // ─── Panneaux de terminaux ─────────────────────────────────────

  const focusPane = useCallback((tab: string, paneId: string) => {
    setTerms((prev) => {
      const rec = prev[tab];
      if (!rec || rec.focused === paneId) return prev;
      return { ...prev, [tab]: { ...rec, focused: paneId } };
    });
  }, []);

  const paneClosed = useCallback(
    (tab: string, paneId: string) => {
      setTerms((prev) => {
        const rec = prev[tab];
        if (!rec?.tree) return prev;
        const tree = removePane(rec.tree, paneId);
        const focused =
          tree && (rec.focused === paneId || !leavesOf(tree).includes(rec.focused))
            ? leavesOf(tree)[0]
            : rec.focused;
        return { ...prev, [tab]: { tree, focused: focused ?? "" } };
      });
      // Dernier panneau d'un onglet local → fermer l'onglet.
      const t = tabsRef.current.find((x) => tabId(x) === tab);
      const rec = termsRef.current[tab];
      if (t?.kind === "local" && rec?.tree && leavesOf(rec.tree).length <= 1) {
        closeTab(tab);
      }
    },
    [closeTab],
  );

  const splitFocused = useCallback((dir: "row" | "col") => {
    const tab = activeIdRef.current;
    if (!tab) return;
    setTerms((prev) => {
      const rec = prev[tab];
      if (!rec?.tree) return prev;
      const focused = rec.focused || leavesOf(rec.tree)[0];
      const newId = crypto.randomUUID();
      return {
        ...prev,
        [tab]: {
          tree: splitPane(rec.tree, focused, dir, newId),
          focused: newId,
        },
      };
    });
  }, []);

  /** Scinde un panneau précis (menu contextuel). */
  const splitPaneOf = useCallback((tab: string, paneId: string, dir: "row" | "col") => {
    setTerms((prev) => {
      const rec = prev[tab];
      if (!rec?.tree) return prev;
      const newId = crypto.randomUUID();
      return {
        ...prev,
        [tab]: {
          tree: splitPane(rec.tree, paneId, dir, newId),
          focused: newId,
        },
      };
    });
  }, []);

  /** Ferme un panneau précis (bouton de survol, menu contextuel). */
  const closePaneOf = useCallback(
    (tab: string, paneId: string) => {
      const t = tabsRef.current.find((x) => tabId(x) === tab);
      if (!t) return;
      const target =
        t.kind === "ssh"
          ? ({ kind: "ssh", sessionId: t.session.id, shellId: paneId } as const)
          : ({ kind: "local", termId: paneId } as const);
      // Normalement le panneau disparaît sur l'évènement de fermeture du
      // backend ; si l'appel échoue (shell déjà mort), on le retire quand même
      // pour ne pas laisser un panneau fantôme.
      termClose(target).catch(() => paneClosed(tab, paneId));
    },
    [paneClosed],
  );

  const closeFocusedPane = useCallback(() => {
    const tab = activeIdRef.current;
    if (!tab) return;
    const t = tabsRef.current.find((x) => tabId(x) === tab);
    const rec = termsRef.current[tab];
    if (!t || !rec?.tree) return;
    const focused = rec.focused || leavesOf(rec.tree)[0];
    const target =
      t.kind === "ssh"
        ? ({ kind: "ssh", sessionId: t.session.id, shellId: focused } as const)
        : ({ kind: "local", termId: focused } as const);
    termClose(target).catch(() => {});
  }, []);

  const setTreeRatio = useCallback((tab: string, path: string, ratio: number) => {
    setTerms((prev) => {
      const rec = prev[tab];
      if (!rec?.tree) return prev;
      return {
        ...prev,
        [tab]: { ...rec, tree: setRatio(rec.tree, path, ratio) },
      };
    });
  }, []);

  // ─── Menu et raccourcis ────────────────────────────────────────

  const toggleZoom = useCallback(() => {
    const tab = activeIdRef.current;
    if (!tab) return;
    const rec = termsRef.current[tab];
    if (!rec?.tree) return;
    setZoomed((z) => (z ? null : rec.focused || leavesOf(rec.tree!)[0]));
  }, []);

  const saveCurrentWorkspace = useCallback(() => {
    const list = tabsRef.current;
    const connections = list
      .filter((t): t is Extract<Tab, { kind: "ssh" }> => t.kind === "ssh")
      .map((t) => `${t.session.username}@${t.session.host}:${t.session.port}`);
    const locals = list.filter((t) => t.kind === "local").length;
    const name = `Espace ${new Date().toLocaleDateString("fr-FR")} — ${connections.length} serveur(s)`;
    setWorkspaces((prev) => [
      ...prev,
      { id: crypto.randomUUID(), name, connections, locals },
    ]);
    notify("ok", `Espace enregistré : ${name}`);
  }, [notify]);

  const openWorkspace = useCallback(
    (w: Workspace) => {
      for (const id of w.connections) {
        const conn = savedRef.current.find((c) => c.id === id);
        if (conn) quickConnect(conn);
      }
      for (let i = 0; i < w.locals; i++) addLocalTab();
    },
    [addLocalTab],
  );

  const cycleTab = useCallback((delta: number) => {
    const list = tabsRef.current;
    if (list.length < 2) return;
    const idx = list.findIndex((t) => tabId(t) === activeIdRef.current);
    const next = (idx + delta + list.length) % list.length;
    setActiveId(tabId(list[next]));
  }, []);

  useAppMenu({
    newConn: () => setModal({ open: true, prefill: null }),
    newLocal: addLocalTab,
    closeTab: () => {
      const id = activeIdRef.current;
      if (id) closeTab(id);
    },
    nextTab: () => cycleTab(1),
    prevTab: () => cycleTab(-1),
    splitRight: () => splitFocused("row"),
    splitDown: () => splitFocused("col"),
    closePane: closeFocusedPane,
    reconnect: () => {
      const cur = tabsRef.current.find((t) => tabId(t) === activeIdRef.current);
      if (cur?.kind === "ssh") reconnectSession(cur.session).catch(() => {});
    },
    settings: () => setShowSettings(true),
    toggleFiles: () => {
      const cur = tabsRef.current.find((t) => tabId(t) === activeIdRef.current);
      if (cur?.kind === "ssh") togglePane(tabId(cur), "files");
    },
    toggleSync: () => {
      const cur = tabsRef.current.find((t) => tabId(t) === activeIdRef.current);
      if (cur?.kind === "ssh") togglePane(tabId(cur), "sync");
    },
    docker: () => setDockerOpen(true),
    git: () => setGitOpen(true),
  });

  // ⌘K : palette de commandes. ⌘⇧Z : agrandir le panneau.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if ((e.key === "k" || e.key === "K") && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if ((e.key === "h" || e.key === "H") && e.shiftKey) {
        e.preventDefault();
        const cur = tabsRef.current.find((t) => tabId(t) === activeIdRef.current);
        if (cur?.kind === "ssh") {
          setHistoryOpen(true);
          setHistoryLoading(true);
          remoteHistory(cur.session.id, 400)
            .then(setHistory)
            .catch(() => {})
            .finally(() => setHistoryLoading(false));
        }
      } else if ((e.key === "n" || e.key === "N") && e.shiftKey) {
        e.preventDefault();
        // Fenêtre supplémentaire, pour travailler sur deux écrans.
        import("@tauri-apps/api/webviewWindow")
          .then(({ WebviewWindow }) => {
            new WebviewWindow(`cabestan-${Date.now()}`, {
              url: "index.html",
              title: "Cabestan",
              width: 1240,
              height: 800,
            });
          })
          .catch(() => {});
      } else if ((e.key === "k" || e.key === "K") && e.shiftKey) {
        e.preventDefault();
        const cur = tabsRef.current.find((t) => tabId(t) === activeIdRef.current);
        if (cur?.kind === "ssh") setStyledFor({ session: cur.session, cmd: "" });
      } else if ((e.key === "z" || e.key === "Z") && e.shiftKey) {
        e.preventDefault();
        toggleZoom();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [toggleZoom]);

  // ⌘+ / ⌘- / ⌘0 : taille de police du terminal.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      const plus = e.key === "+" || e.key === "=";
      const minus = e.key === "-";
      const reset = e.key === "0";
      if (!plus && !minus && !reset) return;
      e.preventDefault();
      setSettings((prev) => ({
        ...prev,
        termFontSize: reset
          ? 13
          : Math.min(22, Math.max(10, prev.termFontSize + (plus ? 1 : -1))),
      }));
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // ⌘1…⌘9 : aller à l'onglet n.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 9) return;
      const target = tabsRef.current[n - 1];
      if (target) {
        e.preventDefault();
        setActiveId(tabId(target));
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  // Réouverture des sessions de la dernière fois, si l'option est active.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current || !settings.restoreTabs) return;
    restoredRef.current = true;
    let ids: string[] = [];
    try {
      ids = JSON.parse(localStorage.getItem("cabestan.lastTabs") ?? "[]");
    } catch {
      return;
    }
    for (const id of ids) {
      const conn = saved.find((c) => c.id === id);
      if (conn) quickConnect(conn);
    }
    // Volontairement au premier rendu seulement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.restoreTabs]);

  // Entrées de la palette ⌘K : serveurs, onglets, signets, commandes, actions.
  const paletteItems: PaletteItem[] = (() => {
    const items: PaletteItem[] = [];
    for (const c of saved) {
      items.push({
        id: `conn-${c.id}`,
        label: c.name,
        hint: `${c.username}@${c.host}`,
        group: c.group || "Serveur",
        run: () => quickConnect(c),
      });
    }
    for (const h of configHosts) {
      items.push({
        id: `cfg-${h.alias}`,
        label: h.alias,
        hint: h.hostName ?? undefined,
        group: "Config SSH",
        run: () => openFromConfig(h),
      });
    }
    for (const t of tabs) {
      items.push({
        id: `tab-${tabId(t)}`,
        label: tabName(t),
        hint: "aller à l'onglet",
        group: "Onglet",
        run: () => setActiveId(tabId(t)),
      });
    }
    for (const sn of snippetList) {
      items.push({
        id: `snip-${sn.id}`,
        label: sn.label,
        hint: sn.command,
        group: "Commande",
        run: () => runSnippet(sn.command),
      });
    }
    for (const w of workspaces) {
      items.push({
        id: `ws-${w.id}`,
        label: w.name,
        hint: `${w.connections.length} serveur(s)`,
        group: "Espace",
        run: () => openWorkspace(w),
      });
    }
    const actions: Array<[string, string, () => void]> = [
      ["Nouveau terminal local", "⌘N", addLocalTab],
      ["Nouvelle connexion", "⌘T", () => setModal({ open: true, prefill: null })],
      ["Scinder à droite", "⌘D", () => splitFocused("row")],
      ["Scinder en dessous", "⌘⇧D", () => splitFocused("col")],
      ["Agrandir/réduire le panneau", "⌘⇧Z", () => toggleZoom()],
      ["Diffuser la saisie à tous les panneaux", "", () => setBroadcast((v) => !v)],
      [
        "Vue structurée d'une commande",
        "⌘⇧K",
        () => {
          const cur = tabsRef.current.find((t) => tabId(t) === activeIdRef.current);
          if (cur?.kind === "ssh") setStyledFor({ session: cur.session, cmd: "" });
        },
      ],
      [
        "Historique du serveur",
        "⌘⇧H",
        () => {
          const cur = tabsRef.current.find((t) => tabId(t) === activeIdRef.current);
          if (cur?.kind === "ssh") {
            setHistoryOpen(true);
            setHistoryLoading(true);
            remoteHistory(cur.session.id, 400)
              .then(setHistory)
              .catch(() => {})
              .finally(() => setHistoryLoading(false));
          }
        },
      ],
      ["Docker (conteneurs)", "⌘⇧B", () => setDockerOpen(true)],
      ["Dépôt Git", "⌘⇧G", () => setGitOpen(true)],
      ["Dernières erreurs", "", () => setErrorLogOpen(true)],
      ["Réglages", "⌘,", () => setShowSettings(true)],
      ["Hôtes connus (empreintes)", "", () => setKnownHostsOpen(true)],
      ["Enregistrer cet espace de travail", "", () => saveCurrentWorkspace()],
    ];
    for (const [label, hint, run] of actions) {
      items.push({ id: `act-${label}`, label, hint, group: "Action", run });
    }
    return items;
  })();

  const openFromConfig = (h: SshConfigHost) => {
    setModal({
      open: true,
      prefill: {
        id: `${h.user ?? ""}@${h.hostName ?? h.alias}:${h.port ?? 22}`,
        name: h.alias,
        host: h.hostName ?? h.alias,
        port: h.port ?? 22,
        username: h.user ?? "",
        auth: h.identityFile ? "key" : "agent",
        keyPath: h.identityFile ?? undefined,
      },
    });
  };

  // Cibles Docker : la machine locale, puis chaque session SSH ouverte.
  const dockerTargets: DockerTarget[] = [
    { id: null, label: "Cette machine", host: "localhost" },
    ...tabs.flatMap((t) =>
      t.kind === "ssh"
        ? [
            {
              id: t.session.id,
              label: t.session.name,
              host: t.session.host,
              sensitive: isSensitive(
                savedRef.current.find(
                  (c) =>
                    c.id === `${t.session.username}@${t.session.host}:${t.session.port}`,
                ),
              ),
            },
          ]
        : [],
    ),
  ];

  // Cibles Git : mêmes machines que Docker, plus le dossier de départ.
  const gitTargets: GitTarget[] = [
    { id: null, label: "Cette machine", defaultDir: null },
    ...tabs.flatMap((t) =>
      t.kind === "ssh"
        ? [
            {
              id: t.session.id,
              label: t.session.name,
              defaultDir: t.session.homeDir,
              sensitive: isSensitive(
                savedRef.current.find(
                  (c) =>
                    c.id === `${t.session.username}@${t.session.host}:${t.session.port}`,
                ),
              ),
            },
          ]
        : [],
    ),
  ];

  const active = tabs.find((t) => tabId(t) === activeId) ?? null;
  const activeTerm = activeId ? terms[activeId] : undefined;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="wordmark">
          <span className="wordmark-name">Cabestan</span>
          <span className="wordmark-sub">
            SFTP &amp; terminal
            {appVersion && <em className="wordmark-version">v{appVersion}</em>}
          </span>
        </div>

        <p className="sidebar-label">Port d'attache</p>
        {saved.length > 4 && (
          <input
            className="group-filter mono"
            value={groupFilter}
            onChange={(e) => setGroupFilter(e.target.value)}
            placeholder="filtrer serveur ou groupe…"
          />
        )}
        <div className="saved-list">
          {saved.length === 0 && (
            <p className="saved-empty">
              Aucune connexion gardée. Elles apparaîtront ici après votre première escale.
            </p>
          )}
          {Object.entries(
            saved
              .filter((c) => {
                const q = groupFilter.trim().toLowerCase();
                if (!q) return true;
                return `${c.name} ${c.host} ${c.username} ${c.group ?? ""}`
                  .toLowerCase()
                  .includes(q);
              })
              .reduce<Record<string, SavedConnection[]>>((acc, c) => {
                const g = c.group?.trim() || "";
                (acc[g] ??= []).push(c);
                return acc;
              }, {}),
          )
            .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
            .flatMap(([group, list]) => [
              ...(group
                ? [
                    <p key={`g-${group}`} className="group-head">
                      {group}
                    </p>,
                  ]
                : []),
              ...list.map((c) => (
                <div
                  key={c.id}
                  className="saved-card"
                  style={c.color ? { borderLeftColor: c.color } : undefined}
                >
                  <button
                    className="saved-main"
                    onClick={() => quickConnect(c)}
                    disabled={connectingId === c.id}
                    title={`Se connecter à ${c.id}`}
                  >
                    <span className="saved-name">
                      {c.name}
                      {connectingId === c.id && (
                        <Loader size={11} className="saved-spin" />
                      )}
                    </span>
                    <span className="saved-coords">
                      <span className="saved-addr">
                        {c.username}@{c.host}:{c.port}
                      </span>
                      <span className="saved-auth">
                        {c.auth === "password"
                          ? "mdp"
                          : c.auth === "key"
                            ? "clé"
                            : "agent"}
                      </span>
                    </span>
                  </button>
                  <span className="saved-tools">
                    <button
                      className="saved-tool"
                      title="Modifier cette connexion"
                      onClick={() => setModal({ open: true, prefill: c, mode: "edit" })}
                    >
                      <SettingsIcon size={12} />
                    </button>
                    <button
                      className="saved-tool"
                      title="Retirer du port d'attache"
                      onClick={() => {
                        credDelete(c.id).catch(() => {});
                        setSaved((prev) => prev.filter((x) => x.id !== c.id));
                      }}
                    >
                      <X size={12} />
                    </button>
                  </span>
                </div>
              )),
            ])}
        </div>

        {configHosts.length > 0 && (
          <>
            <p className="sidebar-label">Config SSH</p>
            <div className="saved-list config-list">
              {configHosts.map((h) => (
                <div key={h.alias} className="saved-card config">
                  <button
                    className="saved-main"
                    onClick={() => openFromConfig(h)}
                    title={`~/.ssh/config — ${h.hostName ?? h.alias}`}
                  >
                    <span className="saved-name">{h.alias}</span>
                    <span className="saved-coords">
                      {h.user ? `${h.user}@` : ""}
                      {h.hostName ?? h.alias}
                      {h.port && h.port !== 22 ? `:${h.port}` : ""}
                    </span>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        <div className="sidebar-footer">
          <button
            className="btn primary new-conn"
            onClick={() => setModal({ open: true, prefill: null })}
          >
            Nouvelle connexion
          </button>
          <button className="btn local-btn" title="⌘N" onClick={addLocalTab}>
            <SquareTerminal size={14} /> Terminal local
          </button>
          <div className="sidebar-footer-row">
            <button
              className="btn icon"
              title="Conteneurs Docker (⌘⇧B)"
              onClick={() => setDockerOpen(true)}
            >
              <Boxes size={15} />
            </button>
            <button
              className="btn icon"
              title="Dépôt Git (⌘⇧G)"
              onClick={() => setGitOpen(true)}
            >
              <GitBranch size={15} />
            </button>
            <button
              className="btn icon"
              title="Réglages (⌘,)"
              onClick={() => setShowSettings(true)}
            >
              <SettingsIcon size={15} />
            </button>
          </div>
        </div>
      </aside>

      <main className="main">
        {tabs.length > 0 && (
          <div className="tabs" role="tablist">
            {tabs.map((t) => {
              const id = tabId(t);
              return (
                <div
                  key={id}
                  role="tab"
                  aria-selected={id === activeId}
                  className={`tab ${id === activeId ? "active" : ""} ${
                    dragTab === id ? "dragging" : ""
                  } ${dropTab === id ? "drop-before" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    dragTabRef.current = id;
                    setDragTab(id);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", id);
                  }}
                  onDragEnd={() => {
                    dragTabRef.current = null;
                    setDragTab(null);
                    setDropTab(null);
                  }}
                  onDragOver={(e) => {
                    const from = dragTabRef.current;
                    if (!from || from === id) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDropTab(id);
                  }}
                  onDragLeave={() => {
                    if (dropTab === id) setDropTab(null);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    const from = dragTabRef.current;
                    if (from && from !== id) moveTab(from, id);
                    dragTabRef.current = null;
                    setDragTab(null);
                    setDropTab(null);
                  }}
                  onClick={() => setActiveId(id)}
                >
                  {t.kind === "local" ? (
                    <SquareTerminal size={12} className="tab-glyph" />
                  ) : (
                    <span
                      className="tab-dot"
                      style={
                        savedRef.current.find(
                          (c) =>
                            c.id ===
                            `${t.session.username}@${t.session.host}:${t.session.port}`,
                        )?.color
                          ? {
                              background: savedRef.current.find(
                                (c) =>
                                  c.id ===
                                  `${t.session.username}@${t.session.host}:${t.session.port}`,
                              )!.color,
                            }
                          : undefined
                      }
                    />
                  )}
                  {renamingTab === id ? (
                    <input
                      className="tab-rename"
                      value={tabNameDraft}
                      autoFocus
                      onChange={(e) => setTabNameDraft(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          const name = tabNameDraft.trim();
                          if (name) {
                            setTabs((prev) =>
                              prev.map((x) =>
                                tabId(x) !== id
                                  ? x
                                  : x.kind === "ssh"
                                    ? {
                                        kind: "ssh",
                                        session: { ...x.session, name },
                                      }
                                    : { ...x, name },
                              ),
                            );
                          }
                          setRenamingTab(null);
                        }
                        if (e.key === "Escape") setRenamingTab(null);
                      }}
                      onBlur={() => setRenamingTab(null)}
                    />
                  ) : (
                    <span
                      className="tab-name"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setTabNameDraft(tabName(t));
                        setRenamingTab(id);
                      }}
                    >
                      {tabName(t)}
                    </span>
                  )}
                  <button
                    className="tab-close"
                    title="Fermer l'onglet"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(id);
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {tabs.length === 0 ? (
          <div className="welcome">
            <h1 className="welcome-title">Cabestan</h1>
            <p className="welcome-tag">
              Vos serveurs à portée de main : fichiers d'un côté, terminal de l'autre, la
              même amarre.
            </p>
            <div className="welcome-actions">
              <button
                className="btn primary big"
                onClick={() => setModal({ open: true, prefill: null })}
              >
                Se connecter à un serveur
              </button>
              <button className="btn big" onClick={addLocalTab}>
                <SquareTerminal size={16} /> Terminal local
              </button>
              <button className="btn big" onClick={() => setDockerOpen(true)}>
                <Boxes size={16} /> Conteneurs Docker
              </button>
            </div>
          </div>
        ) : (
          tabs.map((t) => {
            const id = tabId(t);
            const term = terms[id] ?? { tree: null, focused: "" };
            if (t.kind === "local") {
              return (
                <LocalView
                  key={id}
                  id={id}
                  visible={id === activeId}
                  settings={settings}
                  term={term}
                  onRatio={(path, ratio) => setTreeRatio(id, path, ratio)}
                  onFocusPane={(p) => focusPane(id, p)}
                  onPaneClosed={(p) => paneClosed(id, p)}
                  onSplitPane={(p, dir) => splitPaneOf(id, p, dir)}
                  onZoomPane={toggleZoom}
                  onRequestClosePane={(p) => closePaneOf(id, p)}
                />
              );
            }
            const pane = paneOf(id);
            return (
              <SessionView
                key={id}
                session={t.session}
                visible={id === activeId}
                showFiles={pane.files}
                sync={pane.sync}
                settings={settings}
                term={term}
                focusedPid={pids[term.focused] ?? null}
                onReconnect={reconnectSession}
                onRatio={(path, ratio) => setTreeRatio(id, path, ratio)}
                onFocusPane={(p) => focusPane(id, p)}
                onPaneClosed={(p) => paneClosed(id, p)}
                onShellPid={(p, pid) => setPids((prev) => ({ ...prev, [p]: pid }))}
                onDisk={(d) => {
                  setDisks((prev) => ({ ...prev, [id]: d }));
                  const pct = parseInt(d?.percent ?? "", 10);
                  if (Number.isFinite(pct) && pct >= 90 && !alertedRef.current.has(id)) {
                    alertedRef.current.add(id);
                    notify(
                      "err",
                      `${t.session.name} : disque à ${pct} % (${d?.avail} libres sur ${d?.size}).`,
                    );
                  }
                }}
                zone={zone}
                onZone={setZone}
                autoReconnect={settings.autoReconnect}
                zoomed={zoomed}
                broadcast={broadcast}
                onNotify={notify}
                readOnly={!!readOnly[id]}
                sensitive={isSensitive(
                  savedRef.current.find(
                    (c) =>
                      c.id ===
                      `${t.session.username}@${t.session.host}:${t.session.port}`,
                  ),
                )}
                connName={t.session.name}
                onEditFile={(path) => setEditorFor({ session: t.session, path })}
                onFollowFile={(path) => setLogFor({ session: t.session, path })}
                onRunStyled={(cmd) => setStyledFor({ session: t.session, cmd })}
                otherSessions={tabs
                  .filter(
                    (x): x is Extract<Tab, { kind: "ssh" }> =>
                      x.kind === "ssh" && x.session.id !== t.session.id,
                  )
                  .map((x) => ({
                    id: x.session.id,
                    name: x.session.name,
                    homeDir: x.session.homeDir,
                  }))}
                onCopyToServer={(entry, targetId, targetDir) => {
                  const dest = `${targetDir.replace(/\/+$/, "")}/${entry.name}`;
                  serverToServer(
                    t.session.id,
                    entry.path,
                    targetId,
                    dest,
                    crypto.randomUUID(),
                  )
                    .then(() => notify("ok", `« ${entry.name} » copié vers ${dest}`))
                    .catch((e: unknown) => notify("err", String(e)));
                }}
                onEnqueue={(kind, localPath, remotePath) =>
                  queue.enqueue(kind, t.session.id, localPath, remotePath)
                }
                onStyledView={(cmd, output) =>
                  setStyledFor({ session: t.session, cmd, output })
                }
                onSplitPane={(p, dir) => splitPaneOf(id, p, dir)}
                onZoomPane={toggleZoom}
                onRequestClosePane={(p) => closePaneOf(id, p)}
                onCompare={(remoteDir) => {
                  openDirDialog().then((localDir) => {
                    if (localDir)
                      setCompareFor({
                        session: t.session,
                        remoteDir,
                        localDir,
                      });
                  });
                }}
              />
            );
          })
        )}

        {active && (
          <footer className="status-bar">
            {active.kind === "ssh" ? (
              <>
                <span className="status-dot" />
                <span className="status-coords">
                  {active.session.username}@{active.session.host}:{active.session.port}
                </span>
                <span className="status-sep">·</span>
                <span className="status-home">{active.session.homeDir}</span>
              </>
            ) : (
              <>
                <SquareTerminal size={12} />
                <span className="status-coords">terminal local</span>
              </>
            )}
            {active.kind === "ssh" && disks[tabId(active)] && (
              <>
                <span className="status-sep">·</span>
                <span
                  className="status-disk"
                  title={`${disks[tabId(active)]!.used} utilisés sur ${disks[tabId(active)]!.size} (${disks[tabId(active)]!.mount})`}
                >
                  <HardDrive size={11} /> {disks[tabId(active)]!.avail} libres
                </span>
              </>
            )}
            {activeTerm?.tree && leavesOf(activeTerm.tree).length > 1 && (
              <>
                <span className="status-sep">·</span>
                <span>{leavesOf(activeTerm.tree).length} panneaux</span>
              </>
            )}
            <span className="status-spacer" />
            {queue.jobs.length > 0 && (
              <button
                className={`sb-toggle ${queue.paused ? "on" : ""}`}
                title="File de transferts"
                onClick={() => setQueueOpen(true)}
              >
                <ListOrdered size={13} />
                <span className="sb-label">file ({queue.pending})</span>
              </button>
            )}
            {errors.length > 0 && (
              <button
                className="sb-toggle alert"
                title="Dernières erreurs"
                onClick={() => setErrorLogOpen(true)}
              >
                <TriangleAlert size={13} />
                <span className="sb-label">{errors.length}</span>
              </button>
            )}
            <button
              className="sb-toggle"
              title="Commandes prêtes à l'emploi"
              onClick={() => setSnippetsOpen((v) => !v)}
            >
              <Zap size={13} />
              <span className="sb-label">commandes</span>
            </button>
            <button
              className="sb-toggle"
              title="Conteneurs Docker (⌘⇧B)"
              onClick={() => setDockerOpen(true)}
            >
              <Boxes size={13} />
              <span className="sb-label">docker</span>
            </button>
            <button
              className="sb-toggle"
              title="Dépôt Git (⌘⇧G)"
              onClick={() => setGitOpen(true)}
            >
              <GitBranch size={13} />
              <span className="sb-label">git</span>
            </button>
            {activeTerm?.tree && (
              <>
                <button
                  className="sb-toggle"
                  title="Scinder à droite (⌘D)"
                  onClick={() => splitFocused("row")}
                >
                  <SplitSquareHorizontal size={13} />
                  <span className="sb-label">scinder</span>
                </button>
                <button
                  className="sb-toggle"
                  title="Scinder en dessous (⌘⇧D)"
                  onClick={() => splitFocused("col")}
                >
                  <SplitSquareVertical size={13} />
                </button>
              </>
            )}
            {activeTerm?.tree && leavesOf(activeTerm.tree).length > 1 && (
              <>
                <button
                  className={`sb-toggle ${broadcast ? "on" : ""}`}
                  title="Diffuser la saisie à tous les panneaux"
                  onClick={() => setBroadcast((v) => !v)}
                >
                  <Radio size={13} />
                  <span className="sb-label">diffusion</span>
                </button>
                <button
                  className={`sb-toggle ${zoomed ? "on" : ""}`}
                  title="Agrandir le panneau actif (⌘⇧Z)"
                  onClick={toggleZoom}
                >
                  <Maximize2 size={13} />
                  <span className="sb-label">zoom</span>
                </button>
              </>
            )}
            {active.kind === "ssh" && (
              <>
                <button
                  className={`sb-toggle ${readOnly[tabId(active)] ? "locked" : ""}`}
                  title={
                    readOnly[tabId(active)]
                      ? "Session en lecture seule — cliquer pour déverrouiller"
                      : "Passer la session en lecture seule"
                  }
                  onClick={() =>
                    setReadOnly((prev) => ({
                      ...prev,
                      [tabId(active)]: !prev[tabId(active)],
                    }))
                  }
                >
                  {readOnly[tabId(active)] ? <Lock size={13} /> : <LockOpen size={13} />}
                  <span className="sb-label">
                    {readOnly[tabId(active)] ? "verrouillé" : "écriture"}
                  </span>
                </button>
                <button
                  className="sb-toggle"
                  title="Historique du serveur (⌘⇧H)"
                  onClick={() => {
                    setHistoryOpen(true);
                    setHistoryLoading(true);
                    remoteHistory(active.session.id, 400)
                      .then(setHistory)
                      .catch((e: unknown) => notify("err", String(e)))
                      .finally(() => setHistoryLoading(false));
                  }}
                >
                  <ScrollText size={13} />
                  <span className="sb-label">historique</span>
                </button>
                <button
                  className="sb-toggle"
                  title="Vue structurée d'une commande (⌘⇧K)"
                  onClick={() => setStyledFor({ session: active.session, cmd: "" })}
                >
                  <Sparkles size={13} />
                  <span className="sb-label">vue</span>
                </button>
                <button
                  className="sb-toggle"
                  title="État du serveur (système, Docker, systemd)"
                  onClick={() => setDashboardFor(active.session)}
                >
                  <Activity size={13} />
                  <span className="sb-label">état</span>
                </button>
                <button
                  className="sb-toggle"
                  title="Dupliquer la session dans un nouvel onglet"
                  onClick={() => duplicateSession(active.session).catch(() => {})}
                >
                  <Copy size={13} />
                  <span className="sb-label">dupliquer</span>
                </button>
                <button
                  className="sb-toggle"
                  title="Redirections de port (tunnels)"
                  onClick={() => setTunnelsFor(active.session)}
                >
                  <Cable size={13} />
                  <span className="sb-label">tunnels</span>
                </button>
                <button
                  className={`sb-toggle ${paneOf(tabId(active)).sync ? "on" : ""}`}
                  title="Suivre le dossier du terminal (⌘⇧E)"
                  onClick={() => togglePane(tabId(active), "sync")}
                >
                  <FolderSync size={13} />
                  <span className="sb-label">suivi</span>
                </button>
                <button
                  className={`sb-toggle ${paneOf(tabId(active)).files ? "on" : ""}`}
                  title="Masquer/afficher l'explorateur (⌘E)"
                  onClick={() => togglePane(tabId(active), "files")}
                >
                  <FolderTree size={13} />
                  <span className="sb-label">explorateur</span>
                </button>
              </>
            )}
          </footer>
        )}
      </main>

      {(transfers.length > 0 || syncs.length > 0 || notices.length > 0) && (
        <div className="transfers">
          {notices.map((n) => (
            <div
              key={n.id}
              className={`sync-toast ${n.kind === "ok" ? "uploaded" : "error"}`}
              onClick={() => setNotices((prev) => prev.filter((x) => x.id !== n.id))}
            >
              <span className="sync-icon">
                {n.kind === "ok" ? <KeyRound size={13} /> : <TriangleAlert size={13} />}
              </span>
              <span className="sync-text">{n.text}</span>
            </div>
          ))}
          {syncs.map((s) => (
            <div
              key={s.key}
              className={`sync-toast ${s.status}`}
              onClick={() =>
                s.status === "error" &&
                setSyncs((prev) => prev.filter((p) => p.key !== s.key))
              }
            >
              <span className="sync-icon">
                {s.status === "opened" ? (
                  <Pencil size={13} />
                ) : s.status === "uploaded" ? (
                  <Check size={13} />
                ) : (
                  <TriangleAlert size={13} />
                )}
              </span>
              <span className="sync-text">
                <strong>{s.fileName}</strong>
                {s.status === "opened"
                  ? " — ouvert pour édition, chaque sauvegarde sera renvoyée au serveur"
                  : s.status === "uploaded"
                    ? " — sauvegarde renvoyée au serveur"
                    : ` — échec du renvoi : ${s.message ?? "erreur inconnue"}`}
              </span>
            </div>
          ))}
          {transfers.map((t) => (
            <div
              key={t.transferId}
              className={`transfer ${t.done ? (t.cancelled ? "cancelled" : "done") : ""}`}
            >
              <div className="transfer-head">
                <span className="transfer-dir">
                  {t.direction === "upload" ? (
                    <ArrowUp size={13} />
                  ) : (
                    <ArrowDown size={13} />
                  )}
                </span>
                <span className="transfer-name">{t.fileName}</span>
                <span className="transfer-size">
                  {t.done
                    ? t.cancelled
                      ? "annulé"
                      : "terminé"
                    : `${formatSize(t.transferred)}${t.total ? ` / ${formatSize(t.total)}` : ""}`}
                </span>
                {!t.done && (
                  <button
                    className="transfer-cancel"
                    title="Annuler le transfert"
                    onClick={() => transferCancel(t.transferId).catch(() => {})}
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
              <div className="transfer-bar">
                <div
                  className="transfer-fill"
                  style={{
                    width: t.total
                      ? `${Math.min(100, (t.transferred / t.total) * 100)}%`
                      : "100%",
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      {snippetsOpen && (
        <>
          <div className="ctx-backdrop" onMouseDown={() => setSnippetsOpen(false)} />
          <div className="snippets-pop">
            <p className="settings-group">Commandes</p>
            {snippetList.map((sn) => (
              <button
                key={sn.id}
                className="ctx-item"
                onClick={() => runSnippet(sn.command)}
                title={sn.command}
              >
                <Zap size={13} /> {sn.label}
              </button>
            ))}
            <p className="snippets-hint">
              Envoyées dans le panneau actif. Modifiables dans{" "}
              <code>cabestan.snippets</code>.
            </p>
          </div>
        </>
      )}

      {tunnelsFor && (
        <TunnelsModal
          sessionId={tunnelsFor.id}
          sessionLabel={tunnelsFor.name}
          onClose={() => setTunnelsFor(null)}
        />
      )}

      {paletteOpen && (
        <CommandPalette items={paletteItems} onClose={() => setPaletteOpen(false)} />
      )}

      {dashboardFor && (
        <DashboardModal
          sessionId={dashboardFor.id}
          sessionLabel={dashboardFor.name}
          onClose={() => setDashboardFor(null)}
          onNotify={notify}
        />
      )}

      {compareFor && (
        <CompareModal
          sessionId={compareFor.session.id}
          remoteDir={compareFor.remoteDir}
          localDir={compareFor.localDir}
          onSend={(names) => {
            for (const n of names) {
              queue.enqueue(
                "upload",
                compareFor.session.id,
                `${compareFor.localDir}/${n}`,
                `${compareFor.remoteDir}/${n}`,
              );
            }
            setCompareFor(null);
          }}
          onFetch={(names) => {
            for (const n of names) {
              queue.enqueue(
                "download",
                compareFor.session.id,
                `${compareFor.localDir}/${n}`,
                `${compareFor.remoteDir}/${n}`,
              );
            }
            setCompareFor(null);
          }}
          onMirror={(direction, transfer, remove) => {
            const { session, localDir, remoteDir } = compareFor;
            for (const n of transfer) {
              queue.enqueue(
                direction === "toServer" ? "upload" : "download",
                session.id,
                `${localDir}/${n}`,
                `${remoteDir}/${n}`,
              );
            }
            if (remove.length > 0) {
              const purge =
                direction === "toServer"
                  ? sftpTrash(
                      session.id,
                      remove.map((n) => `${remoteDir}/${n}`),
                    )
                  : localTrash(remove.map((n) => `${localDir}/${n}`));
              purge
                .then((n) =>
                  notify("ok", `Miroir : ${n} fichier(s) mis à la corbeille.`),
                )
                .catch((e: unknown) => notify("err", String(e)));
            }
            if (transfer.length > 0) {
              notify("ok", `Miroir : ${transfer.length} transfert(s) en file.`);
            }
            setCompareFor(null);
          }}
          onClose={() => setCompareFor(null)}
        />
      )}

      {knownHostsOpen && <KnownHostsModal onClose={() => setKnownHostsOpen(false)} />}

      {dockerOpen && (
        <DockerModal
          targets={dockerTargets}
          initialTargetId={active?.kind === "ssh" ? active.session.id : null}
          onExec={runInTerminal}
          onNotify={notify}
          onClose={() => setDockerOpen(false)}
        />
      )}

      {gitOpen && (
        <GitModal
          targets={gitTargets}
          initialTargetId={active?.kind === "ssh" ? active.session.id : null}
          onNotify={notify}
          onClose={() => setGitOpen(false)}
        />
      )}

      {snippetVars && (
        <SnippetVarsModal
          command={snippetVars.command}
          names={snippetVars.names}
          onSubmit={(filled) => {
            setSnippetVars(null);
            sendSnippet(filled);
          }}
          onCancel={() => setSnippetVars(null)}
        />
      )}

      {styledFor && (
        <StyledViewModal
          sessionId={styledFor.session.id}
          sessionLabel={styledFor.session.name}
          initialCommand={styledFor.cmd}
          initialOutput={styledFor.output}
          onNotify={notify}
          onClose={() => setStyledFor(null)}
        />
      )}

      {queueOpen && (
        <QueuePanel
          jobs={queue.jobs}
          paused={queue.paused}
          concurrency={queue.concurrency}
          onPause={queue.setPaused}
          onConcurrency={queue.setConcurrency}
          onRetry={queue.retry}
          onCancel={queue.cancel}
          onClear={queue.clear}
          onClose={() => setQueueOpen(false)}
        />
      )}

      {editorFor && (
        <EditorModal
          sessionId={editorFor.session.id}
          path={editorFor.path}
          readOnly={!!readOnly[editorFor.session.id]}
          onNotify={notify}
          onClose={() => setEditorFor(null)}
        />
      )}

      {logFor && (
        <LogViewModal
          sessionId={logFor.session.id}
          path={logFor.path}
          onNotify={notify}
          onClose={() => setLogFor(null)}
        />
      )}

      {errorLogOpen && (
        <ErrorLogModal
          errors={errors}
          onClear={() => setErrors([])}
          onClose={() => setErrorLogOpen(false)}
        />
      )}

      {historyOpen && (
        <HistoryPalette
          commands={history}
          loading={historyLoading}
          onPick={(cmd) => runSnippet(cmd)}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          onChange={setSettings}
          snippets={snippetList}
          onSnippets={setSnippetList}
          onKnownHosts={() => {
            setShowSettings(false);
            setKnownHostsOpen(true);
          }}
          onNotify={notify}
          onClose={() => setShowSettings(false)}
        />
      )}

      {modal.open && (
        <ConnectModal
          prefill={modal.prefill}
          mode={modal.mode}
          initialError={modal.error ?? null}
          initialHostKey={modal.hostKey ?? null}
          onCancel={() => setModal({ open: false, prefill: null })}
          onConnect={connect}
        />
      )}
    </div>
  );
}
