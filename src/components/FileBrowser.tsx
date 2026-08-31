import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog, ask } from "@tauri-apps/plugin-dialog";
import {
  ArrowUp,
  ClipboardCopy,
  CornerUpRight,
  Download,
  File as FileGlyph,
  FilePlus,
  Folder,
  FolderPlus,
  Eye,
  FileArchive,
  FileCheck2,
  GitCompareArrows,
  HardDrive,
  House,
  Lock,
  PackageOpen,
  Pencil,
  RotateCw,
  ScrollText,
  Search,
  SquareTerminal,
  Table2,
  Star,
  TextCursorInput,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  FileEntry,
  editOpen,
  formatDate,
  formatPermissions,
  formatSize,
  joinPath,
  parentPath,
  Preview,
  remoteArchive,
  remoteDu,
  remoteExtract,
  remotePreview,
  remoteSearch,
  remoteSha256,
  localSha256,
  localReadText,
  sftpReadText,
  SearchHit,
  sftpChmod,
  sftpList,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  sftpTouch,
  sftpTrash,
} from "../api";
import { VIRTUAL_THRESHOLD, visibleWindow } from "../virtual";
import { READ_ONLY_MESSAGE, WriteAction, needsStrongConfirm } from "../guards";
import { FileAction, buildCommand, detectKind } from "../fileactions";
import { isIdentical } from "../diff";
import DiffModal from "./DiffModal";
import ConfirmDangerModal from "./ConfirmDangerModal";
import PermissionsModal from "./PermissionsModal";
import PreviewModal from "./PreviewModal";
import SearchModal from "./SearchModal";

type SortKey = "name" | "size" | "mtime";

interface Props {
  sessionId: string;
  homeDir: string;
  active: boolean;
  hideHidden: boolean;
  syncPath: string | null;
  /** Clé de persistance des signets, propre au serveur. */
  bookmarkKey: string;
  /** true quand l'explorateur est la zone active (arbitre ⌘F avec le terminal). */
  zoneActive: boolean;
  /** Signale que l'utilisateur agit dans l'explorateur. */
  onZone?: () => void;
  onUserNavigate?: (path: string) => void;
  /** « Ouvrir un terminal ici » : envoie un cd dans le panneau actif. */
  onCdHere?: (path: string) => void;
  /** Corbeille plutôt que suppression définitive. */
  useTrash: boolean;
  /** Application d'édition choisie dans les réglages. */
  editorApp: string;
  /** Ouvre la comparaison avec un dossier local. */
  onCompare?: (remoteDir: string) => void;
  /** Notifie le parent (toasts). */
  onNotify?: (kind: "ok" | "err", text: string) => void;
  /** Autres sessions ouvertes, pour la copie serveur → serveur. */
  otherSessions?: Array<{ id: string; name: string; homeDir: string }>;
  onCopyToServer?: (entry: FileEntry, targetId: string, targetDir: string) => void;
  /** Met le transfert en file d'attente au lieu de le lancer directement. */
  onEnqueue: (kind: "upload" | "download", localPath: string, remotePath: string) => void;
  /** Écritures bloquées. */
  readOnly: boolean;
  /** Connexion sensible : confirmation renforcée sur les suppressions. */
  sensitive: boolean;
  connName: string;
  /** Ouvre l'éditeur intégré. */
  onEditFile: (path: string) => void;
  /** Ouvre le suivi de journal. */
  onFollowFile: (path: string) => void;
  /** Envoie une commande au terminal actif de la session. */
  onRunHere?: (cmd: string) => void;
  /** Exécute une commande et affiche sa sortie mise en forme. */
  onRunStyled?: (cmd: string) => void;
}

function loadBookmarks(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(`cabestan.bookmarks.${key}`) ?? "[]");
  } catch {
    return [];
  }
}

export default function FileBrowser({
  sessionId,
  homeDir,
  active,
  hideHidden,
  syncPath,
  bookmarkKey,
  zoneActive,
  onZone,
  onUserNavigate,
  onCdHere,
  useTrash,
  editorApp,
  onCompare,
  onNotify,
  otherSessions,
  onCopyToServer,
  onEnqueue,
  readOnly,
  sensitive,
  connName,
  onEditFile,
  onFollowFile,
  onRunHere,
  onRunStyled,
}: Props) {
  const [path, setPath] = useState(homeDir);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [creating, setCreating] = useState<"dir" | "file" | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [dragOver, setDragOver] = useState(false);
  /** Envoi en attente d'arbitrage : le fichier existe déjà et diffère. */
  const [pendingUpload, setPendingUpload] = useState<{
    local: string;
    remote: string;
    serveur: string;
    local_texte: string;
  } | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [internalDrag, setInternalDrag] = useState<string[] | null>(null);
  const [filter, setFilter] = useState("");
  const [filterOn, setFilterOn] = useState(false);
  const [gotoOn, setGotoOn] = useState(false);
  const [gotoValue, setGotoValue] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [bookmarks, setBookmarks] = useState<string[]>(() => loadBookmarks(bookmarkKey));
  const [dirSize, setDirSize] = useState<{ name: string; size: string } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    entry: FileEntry | null;
  } | null>(null);
  const [permTarget, setPermTarget] = useState<FileEntry | null>(null);
  const [preview, setPreview] = useState<{
    entry: FileEntry;
    data: Preview;
  } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchHits, setSearchHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [danger, setDanger] = useState<{
    action: string;
    details: string;
    run: () => void;
  } | null>(null);
  // Virtualisation : uniquement au-delà du seuil, pour ne rien changer aux
  // petits dossiers (et garder scrollIntoView simple).
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(400);
  const editRef = useRef<HTMLInputElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const gotoRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const pathRef = useRef(path);
  pathRef.current = path;
  const cursorRef = useRef(0);
  cursorRef.current = cursor;
  const visibleRef = useRef<FileEntry[]>([]);

  useEffect(() => {
    localStorage.setItem(`cabestan.bookmarks.${bookmarkKey}`, JSON.stringify(bookmarks));
  }, [bookmarks, bookmarkKey]);

  const load = useCallback(
    async (target: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await sftpList(sessionId, target);
        setEntries(list);
        setPath(target);
        setSelected([]);
        setDirSize(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    load(homeDir);
  }, [load, homeDir]);

  useEffect(() => {
    if ((creating || renaming) && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [creating, renaming]);

  const refresh = () => load(pathRef.current);

  /** Refuse une action d'écriture quand la session est verrouillée. */
  const blocked = (what: WriteAction): boolean => {
    if (!readOnly) return false;
    onNotify?.("err", `${READ_ONLY_MESSAGE} (${what})`);
    return true;
  };

  // Navigation déclenchée par l'utilisateur (informe le parent pour le sync).
  const go = (target: string) => {
    load(target);
    onUserNavigate?.(target);
  };

  // Échap ferme le menu contextuel.
  useEffect(() => {
    if (!ctxMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [ctxMenu]);

  // Suivi du dossier du terminal.
  useEffect(() => {
    if (syncPath && syncPath !== pathRef.current) {
      load(syncPath);
    }
  }, [syncPath, load]);

  // ⌘F : filtre, ⌘L : aller à un chemin.
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "f" || e.key === "F") {
        if (!zoneActive) return; // le terminal a la main sur ⌘F
        e.preventDefault();
        setFilterOn(true);
        requestAnimationFrame(() => filterRef.current?.focus());
      } else if (e.key === "l" || e.key === "L") {
        e.preventDefault();
        setGotoValue(pathRef.current);
        setGotoOn(true);
        requestAnimationFrame(() => gotoRef.current?.select());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, zoneActive]);

  // Un transfert terminé sur cette session : on rafraîchit la vue.
  useEffect(() => {
    const onDone = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { sessionId: string };
      if (detail.sessionId === sessionId) load(pathRef.current);
    };
    window.addEventListener("cabestan-transfer-done", onDone);
    return () => window.removeEventListener("cabestan-transfer-done", onDone);
  }, [sessionId, load]);

  // Navigation au clavier dans la liste (zone explorateur active).
  useEffect(() => {
    if (!active || !zoneActive) return;
    const onKey = (e: KeyboardEvent) => {
      // On ne détourne pas les frappes destinées à un champ de saisie.
      const el = document.activeElement;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const list = visibleRef.current;
      if (list.length === 0) return;

      switch (e.key) {
        case "ArrowDown": {
          e.preventDefault();
          const next = Math.min(list.length - 1, cursorRef.current + 1);
          setCursor(next);
          setSelected(
            e.shiftKey
              ? (prev) => [...new Set([...prev, list[next].path])]
              : [list[next].path],
          );
          break;
        }
        case "ArrowUp": {
          e.preventDefault();
          const prevIdx = Math.max(0, cursorRef.current - 1);
          setCursor(prevIdx);
          setSelected(
            e.shiftKey
              ? (prev) => [...new Set([...prev, list[prevIdx].path])]
              : [list[prevIdx].path],
          );
          break;
        }
        case "Enter": {
          e.preventDefault();
          const cur = list[cursorRef.current];
          if (cur) cur.isDir ? go(cur.path) : edit(cur);
          break;
        }
        case "Backspace": {
          e.preventDefault();
          if (pathRef.current !== "/") go(parentPath(pathRef.current));
          break;
        }
        case " ": {
          e.preventDefault();
          const cur = list[cursorRef.current];
          if (cur) doPreview(cur);
          break;
        }
        case "Home":
          e.preventDefault();
          setCursor(0);
          setSelected([list[0].path]);
          break;
        case "End":
          e.preventDefault();
          setCursor(list.length - 1);
          setSelected([list[list.length - 1].path]);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, zoneActive]);

  const uploadInto = useCallback(
    async (locals: string[], dir: string) => {
      if (readOnly) {
        onNotify?.("err", `${READ_ONLY_MESSAGE} (envoyer)`);
        return;
      }
      const enqueue = () => {
        for (const local of locals) {
          const name = local.replace(/\/+$/, "").split("/").pop() ?? local;
          onEnqueue("upload", local, joinPath(dir, name));
        }
      };

      // Un seul fichier texte qui écrase un fichier existant : on montre le diff
      // avant. Tout échec de comparaison (binaire, trop gros, droits) laisse
      // l'envoi suivre son cours normal.
      if (locals.length !== 1) {
        enqueue();
        return;
      }
      const local = locals[0];
      const name = local.replace(/\/+$/, "").split("/").pop() ?? local;
      const remote = joinPath(dir, name);
      try {
        const existant = (await sftpList(sessionId, dir)).find(
          (e) => e.name === name && !e.isDir,
        );
        if (existant) {
          const [mien, serveur] = await Promise.all([
            localReadText(local),
            sftpReadText(sessionId, remote),
          ]);
          if (mien !== null) {
            if (isIdentical(serveur, mien)) {
              onNotify?.("ok", `« ${name} » est déjà identique sur le serveur.`);
              return;
            }
            setPendingUpload({ local, remote, serveur, local_texte: mien });
            return;
          }
        }
      } catch {
        // Comparaison impossible : on n'empêche pas l'envoi pour autant.
      }
      enqueue();
    },
    [onEnqueue, readOnly, onNotify, sessionId],
  );

  /** Dossier distant sous le curseur, pour un dépôt ciblé. */
  const dirUnderPointer = (physX: number, physY: number): string | null => {
    const r = window.devicePixelRatio || 1;
    const el = document.elementFromPoint(physX / r, physY / r);
    const row = el?.closest("[data-dirpath]") as HTMLElement | null;
    return row?.dataset.dirpath ?? null;
  };

  // Glisser-déposer depuis le Finder (fichiers ou dossiers) vers le serveur.
  useEffect(() => {
    if (!active) return;
    let un: (() => void) | undefined;
    let disposed = false;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragOver(true);
          const pos = (p as { position?: { x: number; y: number } }).position;
          setDropDir(pos ? dirUnderPointer(pos.x, pos.y) : null);
        } else if (p.type === "leave") {
          setDragOver(false);
          setDropDir(null);
        } else if (p.type === "drop") {
          const pos = (p as { position?: { x: number; y: number } }).position;
          const target = (pos ? dirUnderPointer(pos.x, pos.y) : null) ?? pathRef.current;
          setDragOver(false);
          setDropDir(null);
          void uploadInto(p.paths, target);
        }
      })
      .then((u) => {
        if (disposed) u();
        else un = u;
      });
    return () => {
      disposed = true;
      un?.();
      setDragOver(false);
      setDropDir(null);
    };
  }, [active, uploadInto]);

  const upload = async () => {
    const picked = await openDialog({
      multiple: true,
      title: "Envoyer vers le serveur",
    });
    if (!picked) return;
    void uploadInto(Array.isArray(picked) ? picked : [picked], pathRef.current);
  };

  const download = async (entry: FileEntry) => {
    if (entry.isDir) {
      const dest = await openDialog({
        directory: true,
        title: `Télécharger « ${entry.name} » vers…`,
      });
      if (typeof dest !== "string") return;
      onEnqueue("download", `${dest}/${entry.name}`, entry.path);
      return;
    }
    const dest = await saveDialog({
      defaultPath: entry.name,
      title: "Télécharger vers…",
    });
    if (!dest) return;
    onEnqueue("download", dest, entry.path);
  };

  /** Téléchargement en lot : un seul dossier de destination à choisir. */
  const downloadMany = async (list: FileEntry[]) => {
    const dest = await openDialog({
      directory: true,
      title: `Télécharger ${list.length} éléments vers…`,
    });
    if (typeof dest !== "string") return;
    for (const entry of list) {
      onEnqueue("download", `${dest}/${entry.name}`, entry.path);
    }
  };

  const edit = (entry: FileEntry) => {
    if (entry.isDir) return;
    editOpen(sessionId, entry.path, editorApp || undefined).catch((e) =>
      setError(String(e)),
    );
  };

  const chmod = async (entry: FileEntry, mode: number) => {
    setPermTarget(null);
    if (blocked("droits")) return;
    try {
      await sftpChmod(sessionId, entry.path, mode);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const showDirSize = async (entry: FileEntry) => {
    setDirSize({ name: entry.name, size: "calcul…" });
    try {
      const size = await remoteDu(sessionId, entry.path);
      setDirSize({ name: entry.name, size });
    } catch (e) {
      setDirSize(null);
      setError(String(e));
    }
  };

  const copyPath = (p: string) => {
    navigator.clipboard?.writeText(p).catch(() => {
      const ta = document.createElement("textarea");
      ta.value = p;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    });
  };

  const startRename = (entry: FileEntry) => {
    setEditName(entry.name);
    setRenaming(entry.path);
  };

  const toggleBookmark = (p: string) =>
    setBookmarks((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );

  const openCtxMenu = (e: React.MouseEvent, entry: FileEntry | null) => {
    e.preventDefault();
    e.stopPropagation();
    // Clic droit hors sélection : la sélection devient cet élément.
    if (entry && !selected.includes(entry.path)) setSelected([entry.path]);
    setCtxMenu({
      x: Math.min(e.clientX, window.innerWidth - 230),
      y: Math.min(e.clientY, window.innerHeight - 340),
      entry,
    });
  };

  /** Joue une action proposée pour le type du fichier visé. */
  const runFileAction = (action: FileAction, path: string) => {
    if (action.writes && blocked("écrire")) return;
    const cmd = buildCommand(action, path);
    if (action.mode === "table") {
      if (onRunStyled) onRunStyled(cmd);
      else onNotify?.("err", "Aucun terminal pour exécuter cette action.");
      return;
    }
    if (onRunHere) onRunHere(cmd);
    else onNotify?.("err", "Aucun terminal pour exécuter cette action.");
  };

  const ctxAction = (fn: () => void) => () => {
    setCtxMenu(null);
    fn();
  };

  const remove = async (list: FileEntry[]) => {
    if (blocked("supprimer")) return;
    // Serveur sensible : on exige de retaper son nom pour un dossier ou un lot.
    if (needsStrongConfirm(sensitive, list)) {
      setDanger({
        action: useTrash ? "Mise à la corbeille" : "Suppression définitive",
        details:
          list.length > 1
            ? `${list.length} éléments sur ${connName}, dont ${list.filter((e) => e.isDir).length} dossier(s).`
            : `« ${list[0].name} » (dossier) sur ${connName}, avec tout son contenu.`,
        run: () => {
          setDanger(null);
          void doRemove(list);
        },
      });
      return;
    }
    await doRemove(list);
  };

  const doRemove = async (list: FileEntry[]) => {
    const many = list.length > 1;
    const one = list[0];
    const ok = useTrash
      ? await ask(
          many
            ? `Déplacer ${list.length} éléments vers la corbeille du serveur ?`
            : `Déplacer « ${one.name} » vers la corbeille du serveur ?`,
          { title: "Mettre à la corbeille" },
        )
      : await ask(
          many
            ? `Supprimer ${list.length} éléments du serveur ? Les dossiers seront vidés. Cette action est définitive.`
            : one.isDir
              ? `Supprimer le dossier « ${one.name} » et tout son contenu du serveur ? Cette action est définitive.`
              : `Supprimer « ${one.name} » du serveur ? Cette action est définitive.`,
          { title: "Supprimer", kind: "warning" },
        );
    if (!ok) return;
    try {
      if (useTrash) {
        const moved = await sftpTrash(
          sessionId,
          list.map((e) => e.path),
        );
        onNotify?.(
          "ok",
          `${moved} élément${moved > 1 ? "s" : ""} déplacé${moved > 1 ? "s" : ""} vers ~/.cabestan-corbeille sur le serveur.`,
        );
      } else {
        for (const entry of list) {
          await sftpRemove(sessionId, entry.path, entry.isDir);
        }
      }
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const doPreview = async (entry: FileEntry) => {
    if (entry.isDir) return;
    try {
      const data = await remotePreview(sessionId, entry.path);
      setPreview({ entry, data });
    } catch (e) {
      setError(String(e));
    }
  };

  const archive = async (list: FileEntry[]) => {
    if (blocked("archiver")) return;
    const base = list.length === 1 ? list[0].name : path.split("/").pop() || "archive";
    const name = `${base}.tar.gz`;
    try {
      const created = await remoteArchive(
        sessionId,
        pathRef.current,
        list.map((e) => e.name),
        name,
        "tar.gz",
      );
      onNotify?.("ok", `Archive créée : ${created.split("/").pop()}`);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const extract = async (entry: FileEntry) => {
    if (blocked("extraire")) return;
    try {
      await remoteExtract(sessionId, entry.path);
      onNotify?.("ok", `« ${entry.name} » extrait dans le dossier courant.`);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  /** Compare l'empreinte distante à celle d'un fichier local choisi. */
  const verify = async (entry: FileEntry) => {
    const local = await openDialog({
      title: `Fichier local à comparer à « ${entry.name} »`,
    });
    if (typeof local !== "string") return;
    try {
      const [remote, mine] = await Promise.all([
        remoteSha256(sessionId, entry.path),
        localSha256(local),
      ]);
      onNotify?.(
        remote === mine ? "ok" : "err",
        remote === mine
          ? `Empreintes identiques (${remote.slice(0, 12)}…) — fichiers conformes.`
          : `Empreintes différentes : distant ${remote.slice(0, 12)}… / local ${mine.slice(0, 12)}…`,
      );
    } catch (e) {
      setError(String(e));
    }
  };

  const runSearch = async (pattern: string, contains: string) => {
    setSearching(true);
    setSearchHits(null);
    try {
      const hits = await remoteSearch(
        sessionId,
        pathRef.current,
        pattern,
        contains || undefined,
      );
      setSearchHits(hits);
    } catch (e) {
      setError(String(e));
      setSearchHits([]);
    } finally {
      setSearching(false);
    }
  };

  const isArchive = (name: string) =>
    /\.(zip|tar|tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|gz)$/i.test(name);

  const submitCreate = async () => {
    if (blocked("créer")) {
      setCreating(null);
      return;
    }
    const kind = creating;
    const name = editName.trim();
    setCreating(null);
    if (!name || !kind) return;
    try {
      const target = joinPath(pathRef.current, name);
      if (kind === "dir") await sftpMkdir(sessionId, target);
      else await sftpTouch(sessionId, target);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const submitRename = async (entry: FileEntry) => {
    if (blocked("renommer")) {
      setRenaming(null);
      return;
    }
    const name = editName.trim();
    setRenaming(null);
    if (!name || name === entry.name) return;
    try {
      await sftpRename(sessionId, entry.path, joinPath(pathRef.current, name));
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  /** Déplacement interne : glisser une sélection sur un dossier de la liste. */
  const moveInto = async (paths: string[], dir: string) => {
    if (blocked("déplacer")) return;
    try {
      for (const p of paths) {
        const name = p.replace(/\/+$/, "").split("/").pop() ?? p;
        const target = joinPath(dir, name);
        if (target === p) continue;
        await sftpRename(sessionId, p, target);
      }
      refresh();
    } catch (e) {
      setError(String(e));
    }
  };

  const crumbs = (() => {
    const parts = path.split("/").filter(Boolean);
    const acc: Array<{ label: string; target: string }> = [{ label: "/", target: "/" }];
    let cur = "";
    for (const p of parts) {
      cur += "/" + p;
      acc.push({ label: p, target: cur });
    }
    return acc;
  })();

  const visibleEntries = useMemo(() => {
    let list = hideHidden ? entries.filter((e) => !e.name.startsWith(".")) : entries;
    const f = filter.trim().toLowerCase();
    if (f) list = list.filter((e) => e.name.toLowerCase().includes(f));
    const dir = sortAsc ? 1 : -1;
    return [...list].sort((a, b) => {
      // Les dossiers restent groupés en tête, quel que soit le tri.
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      if (sortKey === "size") return (a.size - b.size) * dir;
      if (sortKey === "mtime") return ((a.mtime ?? 0) - (b.mtime ?? 0)) * dir;
      return a.name.localeCompare(b.name, "fr", { numeric: true }) * dir;
    });
  }, [entries, hideHidden, filter, sortKey, sortAsc]);

  visibleRef.current = visibleEntries;

  const virtualized = visibleEntries.length > VIRTUAL_THRESHOLD;
  const ROW_HEIGHT = 25;
  const win = virtualized
    ? visibleWindow(visibleEntries.length, ROW_HEIGHT, viewport, scrollTop)
    : { start: 0, end: visibleEntries.length, padTop: 0, padBottom: 0 };
  const rendered = visibleEntries.slice(win.start, win.end);

  // Hauteur de la zone défilante, pour dimensionner la fenêtre de rendu.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const obs = new ResizeObserver(() => setViewport(el.clientHeight));
    obs.observe(el);
    setViewport(el.clientHeight);
    return () => obs.disconnect();
  }, []);

  // Garde le curseur dans les bornes et le fait défiler dans la vue.
  useEffect(() => {
    if (cursor >= visibleEntries.length)
      setCursor(Math.max(0, visibleEntries.length - 1));
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-idx="${cursor}"]`);
    if (row) {
      row.scrollIntoView({ block: "nearest" });
    } else if (visibleEntries.length > VIRTUAL_THRESHOLD) {
      // Ligne hors fenêtre de rendu : on positionne le défilement à la main.
      list.scrollTop = Math.max(0, cursor * 25 - list.clientHeight / 2);
    }
  }, [cursor, visibleEntries.length]);

  const selectedEntries = visibleEntries.filter((e) => selected.includes(e.path));
  const single = selectedEntries.length === 1 ? selectedEntries[0] : null;

  const onRowClick = (e: React.MouseEvent, entry: FileEntry) => {
    if (e.metaKey) {
      setSelected((prev) =>
        prev.includes(entry.path)
          ? prev.filter((p) => p !== entry.path)
          : [...prev, entry.path],
      );
    } else if (e.shiftKey && selected.length > 0) {
      const idx = visibleEntries.findIndex((x) => x.path === entry.path);
      const last = visibleEntries.findIndex(
        (x) => x.path === selected[selected.length - 1],
      );
      if (idx >= 0 && last >= 0) {
        const [from, to] = idx < last ? [idx, last] : [last, idx];
        setSelected(visibleEntries.slice(from, to + 1).map((x) => x.path));
      }
    } else {
      setSelected([entry.path]);
    }
  };

  const sortHeader = (key: SortKey, label: string) => (
    <button
      className={`col-sort ${sortKey === key ? "on" : ""}`}
      onClick={() => {
        if (sortKey === key) setSortAsc((v) => !v);
        else {
          setSortKey(key);
          setSortAsc(key === "name");
        }
      }}
    >
      {label}
      {sortKey === key && <span className="sort-arrow">{sortAsc ? "▲" : "▼"}</span>}
    </button>
  );

  const totalSize = visibleEntries
    .filter((e) => !e.isDir)
    .reduce((n, e) => n + e.size, 0);

  return (
    <div className="file-browser" onMouseDownCapture={() => onZone?.()}>
      {dragOver && !dropDir && (
        <div className="drop-overlay">
          <span>
            Déposer pour envoyer vers <code>{path}</code>
          </span>
        </div>
      )}

      <div className="fb-toolbar">
        <button
          className="btn icon"
          title="Dossier parent"
          onClick={() => go(parentPath(path))}
          disabled={path === "/"}
        >
          <ArrowUp size={15} />
        </button>
        <button
          className="btn icon"
          title="Dossier personnel"
          onClick={() => go(homeDir)}
        >
          <House size={15} />
        </button>

        {gotoOn ? (
          <input
            ref={gotoRef}
            className="goto-input mono"
            value={gotoValue}
            placeholder="/chemin/absolu"
            onChange={(e) => setGotoValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setGotoOn(false);
                const t = gotoValue.trim();
                if (t) go(t);
              }
              if (e.key === "Escape") setGotoOn(false);
            }}
            onBlur={() => setGotoOn(false)}
            autoFocus
          />
        ) : (
          <nav className="fb-crumbs">
            {crumbs.map((c, i) => (
              <span key={c.target}>
                {i > 1 && <span className="crumb-sep">/</span>}
                <button className="crumb" onClick={() => go(c.target)}>
                  {c.label}
                </button>
              </span>
            ))}
          </nav>
        )}

        <div className="fb-actions">
          {filterOn ? (
            <div className="filter-wrap">
              <Search size={12} />
              <input
                ref={filterRef}
                className="filter-input"
                value={filter}
                placeholder="Filtrer…"
                onChange={(e) => setFilter(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setFilter("");
                    setFilterOn(false);
                  }
                }}
              />
              <button
                className="filter-clear"
                title="Fermer le filtre"
                onClick={() => {
                  setFilter("");
                  setFilterOn(false);
                }}
              >
                <X size={11} />
              </button>
            </div>
          ) : (
            <button
              className="btn icon"
              title="Filtrer (⌘F)"
              onClick={() => {
                setFilterOn(true);
                requestAnimationFrame(() => filterRef.current?.focus());
              }}
            >
              <Search size={14} />
            </button>
          )}

          <button
            className="btn icon"
            title="Chercher sur le serveur"
            onClick={() => {
              setSearchHits(null);
              setSearchOpen(true);
            }}
          >
            <FileCheck2 size={14} />
          </button>
          {onCompare && (
            <button
              className="btn icon"
              title="Comparer avec un dossier local"
              onClick={() => onCompare(pathRef.current)}
            >
              <GitCompareArrows size={14} />
            </button>
          )}
          <button
            className={`btn icon ${bookmarks.includes(path) ? "starred" : ""}`}
            title={
              bookmarks.includes(path) ? "Retirer des signets" : "Ajouter aux signets"
            }
            onClick={() => toggleBookmark(path)}
          >
            <Star size={14} />
          </button>

          {selectedEntries.length > 1 ? (
            <>
              <button className="btn" onClick={() => downloadMany(selectedEntries)}>
                <Download size={13} /> Télécharger ({selectedEntries.length})
              </button>
              <button className="btn danger" onClick={() => remove(selectedEntries)}>
                <Trash2 size={13} /> Supprimer ({selectedEntries.length})
              </button>
            </>
          ) : (
            <>
              {single && !single.isDir && (
                <button className="btn" onClick={() => edit(single)}>
                  <Pencil size={13} /> Modifier
                </button>
              )}
              {single && (
                <>
                  <button className="btn" onClick={() => download(single)}>
                    <Download size={13} /> Télécharger
                  </button>
                  <button className="btn" onClick={() => startRename(single)}>
                    <TextCursorInput size={13} /> Renommer
                  </button>
                  <button className="btn danger" onClick={() => remove([single])}>
                    <Trash2 size={13} /> Supprimer
                  </button>
                </>
              )}
            </>
          )}

          <button
            className="btn icon"
            title="Nouveau dossier"
            onClick={() => {
              setEditName("");
              setCreating("dir");
            }}
          >
            <FolderPlus size={14} />
          </button>
          <button
            className="btn icon"
            title="Nouveau fichier"
            onClick={() => {
              setEditName("");
              setCreating("file");
            }}
          >
            <FilePlus size={14} />
          </button>
          <button className="btn primary" onClick={upload}>
            <Upload size={13} /> Envoyer…
          </button>
          <button className="btn icon" title="Actualiser" onClick={refresh}>
            <RotateCw size={14} />
          </button>
        </div>
      </div>

      {bookmarks.length > 0 && (
        <div className="fb-bookmarks">
          <Star size={11} className="bm-glyph" />
          {bookmarks.map((b) => (
            <button
              key={b}
              className={`bm-chip ${b === path ? "on" : ""}`}
              onClick={() => {
                // Un signet de fichier ouvre son dossier et le pointe.
                const known = entries.find((e) => e.path === b);
                if (known && !known.isDir) {
                  setSelected([b]);
                  return;
                }
                go(b);
                setSelected([b]);
              }}
              title={b}
            >
              {b === "/" ? "/" : b.split("/").pop() || b}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="fb-error">
          {error}
          <button className="btn icon" onClick={() => setError(null)}>
            <X size={13} />
          </button>
        </div>
      )}

      <div
        className="fb-list"
        role="grid"
        ref={listRef}
        onScroll={
          virtualized
            ? (e) => setScrollTop((e.target as HTMLDivElement).scrollTop)
            : undefined
        }
        onContextMenu={(e) => openCtxMenu(e, null)}
      >
        <div className="fb-row fb-head" role="row">
          <span className="col-name">{sortHeader("name", "Nom")}</span>
          <span className="col-size">{sortHeader("size", "Taille")}</span>
          <span className="col-date">{sortHeader("mtime", "Modifié")}</span>
          <span className="col-perm">Droits</span>
        </div>

        {creating && (
          <div className="fb-row editing">
            <span className="col-name">
              <span className={`file-icon ${creating === "dir" ? "dir" : "file"}`}>
                {creating === "dir" ? <Folder size={14} /> : <FileGlyph size={14} />}
              </span>
              <input
                ref={editRef}
                className="inline-edit"
                value={editName}
                placeholder={creating === "dir" ? "Nom du dossier" : "Nom du fichier"}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submitCreate();
                  if (e.key === "Escape") setCreating(null);
                }}
                onBlur={submitCreate}
              />
            </span>
          </div>
        )}

        {loading && visibleEntries.length === 0 ? (
          <div className="fb-empty">Chargement…</div>
        ) : visibleEntries.length === 0 && !creating ? (
          <div className="fb-empty">
            {filter.trim()
              ? `Aucun élément ne correspond à « ${filter.trim()} »`
              : "Dossier vide — glissez un fichier ou un dossier depuis le Finder, ou « Envoyer… »"}
          </div>
        ) : (
          <>
            {win.padTop > 0 && <div style={{ height: win.padTop }} aria-hidden />}
            {rendered.map((entry, i) => {
              const idx = win.start + i;
              return (
                <div
                  key={entry.path}
                  role="row"
                  data-idx={idx}
                  data-dirpath={entry.isDir ? entry.path : undefined}
                  className={`fb-row ${selected.includes(entry.path) ? "selected" : ""} ${
                    dropDir === entry.path ? "drop-target" : ""
                  } ${cursor === idx && zoneActive ? "cursor" : ""}`}
                  draggable
                  onDragStart={(e) => {
                    const paths = selected.includes(entry.path) ? selected : [entry.path];
                    setInternalDrag(paths);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", paths.join("\n"));
                  }}
                  onDragEnd={() => {
                    setInternalDrag(null);
                    setDropDir(null);
                  }}
                  onDragOver={(e) => {
                    if (!internalDrag || !entry.isDir) return;
                    if (internalDrag.includes(entry.path)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    setDropDir(entry.path);
                  }}
                  onDragLeave={() => {
                    if (dropDir === entry.path) setDropDir(null);
                  }}
                  onDrop={(e) => {
                    if (!internalDrag || !entry.isDir) return;
                    e.preventDefault();
                    const paths = internalDrag;
                    setInternalDrag(null);
                    setDropDir(null);
                    moveInto(paths, entry.path);
                  }}
                  onClick={(e) => {
                    setCursor(idx);
                    onRowClick(e, entry);
                  }}
                  onContextMenu={(e) => openCtxMenu(e, entry)}
                  onDoubleClick={() => (entry.isDir ? go(entry.path) : edit(entry))}
                >
                  <span className="col-name">
                    <span className={`file-icon ${entry.isDir ? "dir" : "file"}`}>
                      {entry.isDir ? (
                        <Folder size={14} />
                      ) : entry.isLink ? (
                        <CornerUpRight size={14} />
                      ) : (
                        <FileGlyph size={14} />
                      )}
                    </span>
                    {renaming === entry.path ? (
                      <input
                        ref={editRef}
                        className="inline-edit"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") submitRename(entry);
                          if (e.key === "Escape") setRenaming(null);
                        }}
                        onBlur={() => submitRename(entry)}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="file-name">{entry.name}</span>
                    )}
                  </span>
                  <span className="col-size">
                    {entry.isDir ? "—" : formatSize(entry.size)}
                  </span>
                  <span className="col-date">{formatDate(entry.mtime)}</span>
                  <span className="col-perm">
                    {formatPermissions(entry.permissions, entry.isDir)}
                  </span>
                </div>
              );
            })}
            {win.padBottom > 0 && <div style={{ height: win.padBottom }} aria-hidden />}
          </>
        )}
      </div>

      <div className="fb-footer">
        <span>
          {visibleEntries.length} élément{visibleEntries.length > 1 ? "s" : ""}
          {filter.trim() && entries.length !== visibleEntries.length
            ? ` sur ${entries.length}`
            : ""}
        </span>
        {totalSize > 0 && (
          <>
            <span className="status-sep">·</span>
            <span>{formatSize(totalSize)}</span>
          </>
        )}
        {selected.length > 1 && (
          <>
            <span className="status-sep">·</span>
            <span className="fb-sel">{selected.length} sélectionnés</span>
          </>
        )}
        {dirSize && (
          <>
            <span className="status-spacer" />
            <span className="fb-du">
              <HardDrive size={11} /> {dirSize.name} : {dirSize.size}
            </span>
          </>
        )}
      </div>

      {ctxMenu && (
        <>
          <div className="ctx-backdrop" onMouseDown={() => setCtxMenu(null)} />
          <div
            className="ctx-menu"
            style={{ left: ctxMenu.x, top: ctxMenu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {ctxMenu.entry ? (
              selectedEntries.length > 1 ? (
                <>
                  <button
                    className="ctx-item"
                    onClick={ctxAction(() => downloadMany(selectedEntries))}
                  >
                    <Download size={14} /> Télécharger ({selectedEntries.length})
                  </button>
                  <button
                    className="ctx-item"
                    onClick={ctxAction(() => archive(selectedEntries))}
                  >
                    <FileArchive size={14} /> Compresser en une archive
                  </button>
                  <div className="ctx-sep" />
                  <button
                    className="ctx-item danger"
                    onClick={ctxAction(() => remove(selectedEntries))}
                  >
                    <Trash2 size={14} />{" "}
                    {useTrash ? "Mettre à la corbeille" : "Supprimer"} (
                    {selectedEntries.length})
                  </button>
                </>
              ) : (
                <>
                  {ctxMenu.entry.isDir ? (
                    <>
                      <button
                        className="ctx-item"
                        onClick={ctxAction(() => go(ctxMenu.entry!.path))}
                      >
                        <Folder size={14} /> Ouvrir
                      </button>
                      <button
                        className="ctx-item"
                        onClick={ctxAction(() => showDirSize(ctxMenu.entry!))}
                      >
                        <HardDrive size={14} /> Calculer la taille
                      </button>
                      <button
                        className="ctx-item"
                        onClick={ctxAction(() => toggleBookmark(ctxMenu.entry!.path))}
                      >
                        <Star size={14} />{" "}
                        {bookmarks.includes(ctxMenu.entry.path)
                          ? "Retirer des signets"
                          : "Ajouter aux signets"}
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="ctx-item"
                        onClick={ctxAction(() => edit(ctxMenu.entry!))}
                      >
                        <Pencil size={14} /> Ouvrir dans l'app externe
                      </button>
                      <button
                        className="ctx-item"
                        onClick={ctxAction(() => onEditFile(ctxMenu.entry!.path))}
                      >
                        <Pencil size={14} /> Éditer dans Cabestan
                      </button>
                      <button
                        className="ctx-item"
                        onClick={ctxAction(() => doPreview(ctxMenu.entry!))}
                      >
                        <Eye size={14} /> Aperçu (Espace)
                      </button>
                      {/\.(log|out|err|txt)$/i.test(ctxMenu.entry.name) && (
                        <button
                          className="ctx-item"
                          onClick={ctxAction(() => onFollowFile(ctxMenu.entry!.path))}
                        >
                          <ScrollText size={14} /> Suivre en direct
                        </button>
                      )}
                      {isArchive(ctxMenu.entry.name) && (
                        <button
                          className="ctx-item"
                          onClick={ctxAction(() => extract(ctxMenu.entry!))}
                        >
                          <PackageOpen size={14} /> Extraire ici
                        </button>
                      )}
                      <button
                        className="ctx-item"
                        onClick={ctxAction(() => verify(ctxMenu.entry!))}
                      >
                        <FileCheck2 size={14} /> Vérifier l'empreinte…
                      </button>
                      <button
                        className="ctx-item"
                        onClick={ctxAction(() => toggleBookmark(ctxMenu.entry!.path))}
                      >
                        <Star size={14} />{" "}
                        {bookmarks.includes(ctxMenu.entry!.path)
                          ? "Retirer ce fichier des signets"
                          : "Ajouter ce fichier aux signets"}
                      </button>
                      {(() => {
                        const kind = detectKind(ctxMenu.entry!.path);
                        if (!kind) return null;
                        const target = ctxMenu.entry!.path;
                        return (
                          <>
                            <div className="ctx-sep" />
                            <div className="ctx-head">{kind.kind}</div>
                            {kind.actions.map((a) => (
                              <button
                                key={a.label}
                                className="ctx-item"
                                onClick={ctxAction(() => runFileAction(a, target))}
                              >
                                {a.mode === "table" ? (
                                  <Table2 size={14} />
                                ) : (
                                  <SquareTerminal size={14} />
                                )}{" "}
                                {a.label}
                              </button>
                            ))}
                          </>
                        );
                      })()}
                    </>
                  )}
                  <button
                    className="ctx-item"
                    onClick={ctxAction(() => download(ctxMenu.entry!))}
                  >
                    <Download size={14} /> Télécharger…
                  </button>
                  <div className="ctx-sep" />
                  <button
                    className="ctx-item"
                    onClick={ctxAction(() => archive([ctxMenu.entry!]))}
                  >
                    <FileArchive size={14} /> Compresser (tar.gz)
                  </button>
                  <button
                    className="ctx-item"
                    onClick={ctxAction(() => startRename(ctxMenu.entry!))}
                  >
                    <TextCursorInput size={14} /> Renommer
                  </button>
                  <button
                    className="ctx-item"
                    onClick={ctxAction(() => setPermTarget(ctxMenu.entry))}
                  >
                    <Lock size={14} /> Droits…
                  </button>
                  <button
                    className="ctx-item"
                    onClick={ctxAction(() => copyPath(ctxMenu.entry!.path))}
                  >
                    <ClipboardCopy size={14} /> Copier le chemin
                  </button>
                  {!ctxMenu.entry.isDir &&
                    onCopyToServer &&
                    (otherSessions ?? []).length > 0 && (
                      <>
                        <div className="ctx-sep" />
                        <p className="ctx-head">Copier vers</p>
                        {(otherSessions ?? []).map((o) => (
                          <button
                            key={o.id}
                            className="ctx-item"
                            onClick={ctxAction(() =>
                              onCopyToServer(ctxMenu.entry!, o.id, o.homeDir),
                            )}
                          >
                            <Upload size={14} /> {o.name}
                          </button>
                        ))}
                      </>
                    )}
                  <div className="ctx-sep" />
                  <button
                    className="ctx-item danger"
                    onClick={ctxAction(() => remove([ctxMenu.entry!]))}
                  >
                    <Trash2 size={14} /> Supprimer
                  </button>
                </>
              )
            ) : (
              <>
                <button
                  className="ctx-item"
                  onClick={ctxAction(() => {
                    setEditName("");
                    setCreating("dir");
                  })}
                >
                  <FolderPlus size={14} /> Nouveau dossier
                </button>
                <button
                  className="ctx-item"
                  onClick={ctxAction(() => {
                    setEditName("");
                    setCreating("file");
                  })}
                >
                  <FilePlus size={14} /> Nouveau fichier
                </button>
                <button className="ctx-item" onClick={ctxAction(upload)}>
                  <Upload size={14} /> Envoyer ici…
                </button>
                <div className="ctx-sep" />
                {onCdHere && (
                  <button
                    className="ctx-item"
                    onClick={ctxAction(() => onCdHere(pathRef.current))}
                  >
                    <SquareTerminal size={14} /> Ouvrir un terminal ici
                  </button>
                )}
                <button
                  className="ctx-item"
                  onClick={ctxAction(() => toggleBookmark(pathRef.current))}
                >
                  <Star size={14} />{" "}
                  {bookmarks.includes(path)
                    ? "Retirer des signets"
                    : "Ajouter aux signets"}
                </button>
                <button
                  className="ctx-item"
                  onClick={ctxAction(() => copyPath(pathRef.current))}
                >
                  <ClipboardCopy size={14} /> Copier le chemin
                </button>
                <button className="ctx-item" onClick={ctxAction(refresh)}>
                  <RotateCw size={14} /> Actualiser
                </button>
              </>
            )}
          </div>
        </>
      )}

      {preview && (
        <PreviewModal
          entry={preview.entry}
          data={preview.data}
          onClose={() => setPreview(null)}
        />
      )}

      {searchOpen && (
        <SearchModal
          root={path}
          hits={searchHits}
          searching={searching}
          onSearch={runSearch}
          onOpen={(hit) => {
            setSearchOpen(false);
            go(hit.isDir ? hit.path : parentPath(hit.path));
            if (!hit.isDir) setSelected([hit.path]);
          }}
          onClose={() => setSearchOpen(false)}
        />
      )}

      {danger && (
        <ConfirmDangerModal
          expected={connName}
          action={danger.action}
          details={danger.details}
          onConfirm={danger.run}
          onCancel={() => setDanger(null)}
        />
      )}

      {pendingUpload && (
        <DiffModal
          path={pendingUpload.remote}
          beforeLabel="version du serveur"
          before={pendingUpload.serveur}
          afterLabel="fichier local"
          after={pendingUpload.local_texte}
          confirmLabel="Écraser sur le serveur"
          onConfirm={() => {
            const { local, remote } = pendingUpload;
            setPendingUpload(null);
            onEnqueue("upload", local, remote);
          }}
          onCancel={() => setPendingUpload(null)}
        />
      )}

      {permTarget && (
        <PermissionsModal
          entry={permTarget}
          onClose={() => setPermTarget(null)}
          onApply={(mode) => chmod(permTarget, mode)}
        />
      )}
    </div>
  );
}
