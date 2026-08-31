import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  FileDiff,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  History,
  ListChecks,
  Minus,
  Plus,
  RefreshCw,
  RotateCw,
  Undo2,
  X,
} from "lucide-react";
import { confirm as ask } from "@tauri-apps/plugin-dialog";
import { gitCli } from "../api";
import {
  GitBranch as Branch,
  GitCommit,
  GitEntry,
  GitStatus,
  branchArgs,
  commitArgs,
  createBranchArgs,
  diffArgs,
  discardArgs,
  fetchArgs,
  isConflict,
  isStaged,
  isUnstaged,
  isUntracked,
  logArgs,
  parseBranches,
  parseLog,
  parseStatus,
  pullArgs,
  pushArgs,
  pushSetUpstreamArgs,
  rootArgs,
  showArgs,
  stageArgs,
  statusArgs,
  statusLabel,
  summarizeStatus,
  switchArgs,
  unstageArgs,
} from "../git";
import { stripAnsi } from "../tabulate";

export interface GitTarget {
  /** null = machine locale ; sinon identifiant d'une session SSH ouverte. */
  id: string | null;
  label: string;
  /** Dossier de départ (le home de la session SSH ; null en local). */
  defaultDir: string | null;
  /** Serveur sensible : pousser et abandonner demandent confirmation. */
  sensitive?: boolean;
}

interface Props {
  targets: GitTarget[];
  initialTargetId?: string | null;
  onNotify: (kind: "ok" | "err", text: string) => void;
  onClose: () => void;
}

type Tab = "changes" | "history" | "branches";

const TABS: Array<{ id: Tab; label: string; icon: typeof ListChecks }> = [
  { id: "changes", label: "Changements", icon: ListChecks },
  { id: "history", label: "Historique", icon: History },
  { id: "branches", label: "Branches", icon: GitBranch },
];

const DIR_KEY = "cabestan.git.dirs";

function loadDirs(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DIR_KEY) ?? "{}");
  } catch {
    return {};
  }
}

/** Demande un dossier local contenant un dépôt. */
async function openDirDialog(): Promise<string | null> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ directory: true, title: "Dossier du dépôt Git" });
  return typeof picked === "string" ? picked : null;
}

export default function GitModal({
  targets,
  initialTargetId = null,
  onNotify,
  onClose,
}: Props) {
  const [targetId, setTargetId] = useState<string | null>(initialTargetId);
  const target = useMemo(
    () => targets.find((t) => t.id === targetId) ?? targets[0],
    [targets, targetId],
  );
  const cible = target?.id ?? null;
  // Dernier dossier utilisé par cible, pour retrouver son dépôt d'une fois
  // sur l'autre. Clé : identifiant de session ou "local".
  const dirsRef = useRef(loadDirs());
  const dirKey = target?.label ?? "local";
  const [dir, setDir] = useState<string | null>(
    () => dirsRef.current[dirKey] ?? target?.defaultDir ?? null,
  );
  const [dirDraft, setDirDraft] = useState("");
  const [root, setRoot] = useState<string | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);

  const [tab, setTab] = useState<Tab>("changes");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [status, setStatus] = useState<GitStatus | null>(null);
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [message, setMessage] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [detail, setDetail] = useState<{ title: string; text: string } | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  // Changement de cible : on repart du dossier mémorisé pour celle-ci.
  useEffect(() => {
    setDir(dirsRef.current[dirKey] ?? target?.defaultDir ?? null);
    setDirDraft("");
    setRoot(null);
    setProbeError(null);
    setStatus(null);
    setCommits([]);
    setBranches([]);
    setDetail(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cible]);

  // Sonde le dossier : est-ce un dépôt, et où est sa racine ?
  useEffect(() => {
    if (!dir) {
      setRoot(null);
      setProbeError(null);
      return;
    }
    let stop = false;
    setProbeError(null);
    setRoot(null);
    gitCli(cible, dir, rootArgs(), 15)
      .then((out) => {
        if (stop) return;
        const racine = out.trim().split("\n").pop() ?? dir;
        setRoot(racine);
        dirsRef.current[dirKey] = racine;
        localStorage.setItem(DIR_KEY, JSON.stringify(dirsRef.current));
      })
      .catch((e) => !stop && setProbeError(String(e)));
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cible, dir]);

  const run = useCallback(
    (args: string[], timeout?: number) => {
      if (!root) return Promise.reject("Pas de dépôt ouvert");
      return gitCli(cible, root, args, timeout);
    },
    [cible, root],
  );

  const refresh = useCallback(async () => {
    if (!root) return;
    setLoading(true);
    try {
      if (tab === "changes") {
        setStatus(parseStatus(await run(statusArgs())));
      } else if (tab === "history") {
        setCommits(parseLog(await run(logArgs(150))));
      } else {
        setBranches(parseBranches(await run(branchArgs())));
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [run, tab, root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (detail) setDetail(null);
        else onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [detail, onClose]);

  /** Joue une action et rafraîchit, avec l'erreur en notification. */
  const act = async (
    key: string,
    args: string[],
    okText: string,
    timeout?: number,
  ) => {
    setBusy(key);
    try {
      await run(args, timeout);
      onNotify("ok", okText);
      await refresh();
    } catch (e) {
      onNotify("err", String(e));
    } finally {
      setBusy(null);
    }
  };

  const discard = async (e: GitEntry) => {
    const message = target?.sensitive
      ? `Serveur sensible : abandonner les modifications de « ${e.path} » sur ${target.label} ?`
      : `Abandonner les modifications de « ${e.path} » ? Elles seront perdues.`;
    if (!(await ask(message, { title: "Abandonner" }))) return;
    await act(`discard-${e.path}`, discardArgs([e.path]), `Modifications abandonnées : ${e.path}`);
  };

  const commit = async () => {
    const msg = message.trim();
    if (!msg) return;
    setBusy("commit");
    try {
      await run(commitArgs(msg), 60);
      setMessage("");
      onNotify("ok", `Commit créé : ${msg.split("\n")[0]}`);
      await refresh();
    } catch (e) {
      onNotify("err", String(e));
    } finally {
      setBusy(null);
    }
  };

  const push = async () => {
    if (!status) return;
    if (target?.sensitive) {
      const ok = await ask(
        `Serveur sensible : pousser vers l'amont depuis ${target.label} ?`,
        { title: "Pousser" },
      );
      if (!ok) return;
    }
    // Pas d'amont : on publie la branche au lieu d'échouer.
    const args =
      !status.upstream && status.branch
        ? pushSetUpstreamArgs(status.branch)
        : pushArgs();
    await act("push", args, "Poussé vers le dépôt distant.", 180);
  };

  const openDiff = async (e: GitEntry) => {
    setDetail({ title: e.path, text: "" });
    setDetailBusy(true);
    try {
      // Le diff utile : l'arbre de travail s'il a bougé, sinon l'index.
      const out = await run(diffArgs(e.path, !isUnstaged(e)), 30);
      setDetail({ title: e.path, text: stripAnsi(out) || "(pas de différence)" });
    } catch (err) {
      setDetail({ title: e.path, text: String(err) });
    } finally {
      setDetailBusy(false);
    }
  };

  const openCommit = async (c: GitCommit) => {
    setDetail({ title: `${c.shortHash} — ${c.subject}`, text: "" });
    setDetailBusy(true);
    try {
      const out = await run(showArgs(c.hash), 30);
      setDetail({ title: `${c.shortHash} — ${c.subject}`, text: stripAnsi(out) });
    } catch (err) {
      setDetail({ title: c.shortHash, text: String(err) });
    } finally {
      setDetailBusy(false);
    }
  };

  const pickLocalDir = () => {
    void openDirDialog().then((d) => {
      if (d) setDir(d);
    });
  };

  const applyDirDraft = () => {
    const d = dirDraft.trim();
    if (d) setDir(d);
  };

  const staged = status?.entries.filter(isStaged) ?? [];
  const unstaged = status?.entries.filter((e) => isUnstaged(e) && !isUntracked(e)) ?? [];
  const untracked = status?.entries.filter(isUntracked) ?? [];

  /** Une section de fichiers (index, modifiés, non suivis). */
  const fileRows = (
    entries: GitEntry[],
    kind: "staged" | "unstaged" | "untracked",
  ) =>
    entries.map((e) => {
      const code = kind === "staged" ? e.x : e.y;
      return (
        <div key={`${kind}-${e.path}`} className="dk-row">
          <span className={`gt-code gt-${kind === "staged" ? "s" : "u"}`}>
            {code === "?" ? "N" : code}
          </span>
          <span className="dk-name mono" title={e.from ? `${e.from} → ${e.path}` : e.path}>
            {e.path}
            {isConflict(e) && <em className="gt-conflict"> conflit</em>}
          </span>
          <span className="dk-status">{statusLabel(code)}</span>
          <span className="dk-row-actions">
            {!isUntracked(e) && (
              <button
                className="dk-icon-btn"
                title="Voir le diff"
                onClick={() => void openDiff(e)}
              >
                <FileDiff size={13} />
              </button>
            )}
            {kind === "staged" ? (
              <button
                className="dk-icon-btn"
                title="Retirer de l'index"
                disabled={busy !== null}
                onClick={() =>
                  void act(`unstage-${e.path}`, unstageArgs([e.path]), `Retiré : ${e.path}`)
                }
              >
                <Minus size={13} />
              </button>
            ) : (
              <button
                className="dk-icon-btn"
                title="Ajouter à l'index"
                disabled={busy !== null}
                onClick={() =>
                  void act(`stage-${e.path}`, stageArgs([e.path]), `Indexé : ${e.path}`)
                }
              >
                <Plus size={13} />
              </button>
            )}
            {kind === "unstaged" && (
              <button
                className="dk-icon-btn danger"
                title="Abandonner les modifications"
                disabled={busy !== null}
                onClick={() => void discard(e)}
              >
                <Undo2 size={13} />
              </button>
            )}
          </span>
        </div>
      );
    });

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal docker-modal" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">Git</p>
        <div className="dk-head">
          <h2 className="modal-title">
            <GitBranch size={16} /> Dépôt
          </h2>
          <div className="dk-targets">
            {targets.map((t) => (
              <button
                key={t.id ?? "local"}
                className={`dk-target ${t.id === cible ? "on" : ""} ${t.sensitive ? "sensitive" : ""}`}
                onClick={() => setTargetId(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {root && <span className="dk-version mono">{root}</span>}
        </div>

        {/* Choix du dossier : dialogue en local, champ texte à distance. */}
        {(!root || probeError) && (
          <div className="gt-pick">
            {probeError && <div className="modal-error">{probeError}</div>}
            {cible === null ? (
              <button className="btn" onClick={pickLocalDir}>
                <FolderOpen size={13} /> Choisir le dossier du dépôt…
              </button>
            ) : (
              <div className="field-row">
                <label className="field grow">
                  <span>Dossier du dépôt sur le serveur</span>
                  <input
                    className="mono"
                    value={dirDraft}
                    placeholder={dir ?? "/var/www/mon-site"}
                    onChange={(e) => setDirDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") applyDirDraft();
                    }}
                  />
                </label>
                <button className="btn" onClick={applyDirDraft} disabled={!dirDraft.trim()}>
                  Ouvrir
                </button>
              </div>
            )}
          </div>
        )}

        {error && root && <div className="modal-error">{error}</div>}

        {root && (
          <>
            <div className="dk-tabs">
              {TABS.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={`dk-tab ${tab === id ? "on" : ""}`}
                  onClick={() => {
                    setTab(id);
                    setDetail(null);
                  }}
                >
                  <Icon size={13} /> {label}
                </button>
              ))}
              <span className="dk-spacer" />
              {cible === null && (
                <button className="dk-icon-btn" title="Changer de dépôt" onClick={pickLocalDir}>
                  <FolderOpen size={14} />
                </button>
              )}
              {cible !== null && (
                <button
                  className="dk-icon-btn"
                  title="Changer de dépôt"
                  onClick={() => {
                    // Vider aussi le dossier : re-saisir le même chemin doit
                    // relancer la sonde, pas rester sans effet.
                    setDir(null);
                    setRoot(null);
                    setDirDraft("");
                  }}
                >
                  <FolderOpen size={14} />
                </button>
              )}
              <button
                className="dk-icon-btn"
                title="Actualiser"
                onClick={() => void refresh()}
                disabled={loading}
              >
                <RotateCw size={14} className={loading ? "spin" : ""} />
              </button>
            </div>

            {detail && (
              <div className="dk-detail">
                <div className="dk-detail-head">
                  <button className="dk-back" onClick={() => setDetail(null)}>
                    <X size={13} /> Retour
                  </button>
                  <strong className="mono">{detail.title}</strong>
                </div>
                <pre className="dk-log gt-diff">
                  {detailBusy && !detail.text
                    ? "Chargement…"
                    : detail.text.split("\n").map((l, i) => (
                        <div
                          key={i}
                          className={
                            l.startsWith("+") && !l.startsWith("+++")
                              ? "gt-add"
                              : l.startsWith("-") && !l.startsWith("---")
                                ? "gt-del"
                                : l.startsWith("@@")
                                  ? "gt-hunk"
                                  : ""
                          }
                        >
                          {l || " "}
                        </div>
                      ))}
                </pre>
              </div>
            )}

            {tab === "changes" && !detail && status && (
              <>
                <div className="dk-bar">
                  <span className="gt-branch" title={status.upstream ?? "pas de branche amont"}>
                    <GitBranch size={12} /> {status.branch ?? "tête détachée"}
                  </span>
                  <span className="dk-summary">{summarizeStatus(status.entries)}</span>
                  <span className="dk-spacer" />
                  <button
                    className="dk-icon-btn"
                    title="Récupérer (fetch --prune)"
                    disabled={busy !== null}
                    onClick={() => void act("fetch", fetchArgs(), "Références récupérées.", 120)}
                  >
                    <RefreshCw size={13} />
                  </button>
                  <button
                    className="btn gt-sync"
                    title="pull --ff-only"
                    disabled={busy !== null || !status.upstream}
                    onClick={() =>
                      void act("pull", pullArgs(), "Branche mise à jour depuis l'amont.", 180)
                    }
                  >
                    <ArrowDownToLine size={13} /> Tirer
                    {status.behind > 0 && <span className="gt-count">{status.behind}</span>}
                  </button>
                  <button
                    className="btn gt-sync"
                    disabled={busy !== null || (status.ahead === 0 && !!status.upstream)}
                    onClick={() => void push()}
                  >
                    <ArrowUpFromLine size={13} />{" "}
                    {status.upstream ? "Pousser" : "Publier la branche"}
                    {status.ahead > 0 && <span className="gt-count">{status.ahead}</span>}
                  </button>
                </div>

                <div className="dk-body">
                  {status.entries.length === 0 && !loading && (
                    <p className="saved-empty">
                      Rien à valider : l'arbre de travail est propre.
                    </p>
                  )}

                  {staged.length > 0 && (
                    <section className="dk-group">
                      <h3 className="dk-group-title">
                        Dans l'index <span className="dk-count">{staged.length}</span>
                        <span className="dk-pile-actions">
                          <button
                            className="dk-icon-btn"
                            title="Tout retirer de l'index"
                            disabled={busy !== null}
                            onClick={() =>
                              void act(
                                "unstage-all",
                                unstageArgs(staged.map((e) => e.path)),
                                "Index vidé.",
                              )
                            }
                          >
                            <Minus size={12} />
                          </button>
                        </span>
                      </h3>
                      {fileRows(staged, "staged")}
                    </section>
                  )}

                  {unstaged.length > 0 && (
                    <section className="dk-group">
                      <h3 className="dk-group-title">
                        Modifiés <span className="dk-count">{unstaged.length}</span>
                        <span className="dk-pile-actions">
                          <button
                            className="dk-icon-btn"
                            title="Tout ajouter à l'index"
                            disabled={busy !== null}
                            onClick={() =>
                              void act(
                                "stage-all",
                                stageArgs(unstaged.map((e) => e.path)),
                                "Modifications indexées.",
                              )
                            }
                          >
                            <Plus size={12} />
                          </button>
                        </span>
                      </h3>
                      {fileRows(unstaged, "unstaged")}
                    </section>
                  )}

                  {untracked.length > 0 && (
                    <section className="dk-group">
                      <h3 className="dk-group-title">
                        Non suivis <span className="dk-count">{untracked.length}</span>
                        <span className="dk-pile-actions">
                          <button
                            className="dk-icon-btn"
                            title="Tout ajouter à l'index"
                            disabled={busy !== null}
                            onClick={() =>
                              void act(
                                "stage-untracked",
                                stageArgs(untracked.map((e) => e.path)),
                                "Fichiers ajoutés à l'index.",
                              )
                            }
                          >
                            <Plus size={12} />
                          </button>
                        </span>
                      </h3>
                      {fileRows(untracked, "untracked")}
                    </section>
                  )}
                </div>

                <div className="gt-commit">
                  <textarea
                    className="mono"
                    rows={2}
                    placeholder={
                      staged.length === 0
                        ? "Indexez des fichiers pour pouvoir valider"
                        : "Message du commit"
                    }
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.metaKey && e.key === "Enter") void commit();
                    }}
                  />
                  <button
                    className="btn primary"
                    disabled={busy !== null || staged.length === 0 || !message.trim()}
                    onClick={() => void commit()}
                  >
                    <GitCommitHorizontal size={13} />{" "}
                    {busy === "commit" ? "Validation…" : "Valider (⌘⏎)"}
                  </button>
                </div>
              </>
            )}

            {tab === "history" && !detail && (
              <div className="dk-body">
                {commits.length === 0 && !loading && (
                  <p className="saved-empty">Aucun commit.</p>
                )}
                {commits.map((c) => (
                  <button key={c.hash} className="dk-row gt-commit-row" onClick={() => void openCommit(c)}>
                    <span className="gt-hash mono">{c.shortHash}</span>
                    <span className="dk-name" title={c.subject}>
                      {c.subject}
                      {c.refs && <em className="gt-refs"> {c.refs}</em>}
                    </span>
                    <span className="dk-image">{c.author}</span>
                    <span className="dk-status mono">{c.date}</span>
                  </button>
                ))}
              </div>
            )}

            {tab === "branches" && !detail && (
              <>
                <div className="dk-bar">
                  <span className="dk-search">
                    <GitBranch size={13} />
                    <input
                      value={newBranch}
                      onChange={(e) => setNewBranch(e.target.value)}
                      placeholder="Nom de la nouvelle branche"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newBranch.trim()) {
                          void act(
                            "new-branch",
                            createBranchArgs(newBranch.trim()),
                            `Branche créée : ${newBranch.trim()}`,
                          ).then(() => setNewBranch(""));
                        }
                      }}
                    />
                  </span>
                  <button
                    className="btn"
                    disabled={busy !== null || !newBranch.trim()}
                    onClick={() =>
                      void act(
                        "new-branch",
                        createBranchArgs(newBranch.trim()),
                        `Branche créée : ${newBranch.trim()}`,
                      ).then(() => setNewBranch(""))
                    }
                  >
                    <Plus size={13} /> Créer et basculer
                  </button>
                </div>
                <div className="dk-body">
                  {branches.map((b) => (
                    <div key={b.name} className="dk-row">
                      <span className="gt-code">{b.current ? <Check size={12} /> : ""}</span>
                      <span className={`dk-name mono ${b.remote ? "gt-remote" : ""}`}>
                        {b.name}
                      </span>
                      <span className="dk-status">
                        {b.current ? "branche courante" : b.remote ? "distante" : "locale"}
                      </span>
                      <span className="dk-row-actions">
                        {!b.current && !b.remote && (
                          <button
                            className="dk-icon-btn"
                            title="Basculer sur cette branche"
                            disabled={busy !== null}
                            onClick={() =>
                              void act(
                                `switch-${b.name}`,
                                switchArgs(b.name),
                                `Basculé sur ${b.name}`,
                              )
                            }
                          >
                            <GitBranch size={13} />
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                  {branches.length === 0 && !loading && (
                    <p className="saved-empty">Aucune branche.</p>
                  )}
                </div>
              </>
            )}
          </>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
