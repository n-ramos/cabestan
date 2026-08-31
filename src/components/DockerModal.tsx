import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Boxes,
  CircleStop,
  Container as ContainerIcon,
  HardDrive,
  Layers,
  Network,
  Pause,
  Play,
  RotateCw,
  ScrollText,
  Search,
  SquareTerminal,
  Radio,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { confirm as ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  dockerCli,
  dockerLogsFollow,
  dockerLogsStop,
  dockerProbe,
  formatSize,
} from "../api";
import {
  ACTION_LABELS,
  COMPOSE_LABELS,
  ComposeAction,
  ComposeProject,
  Container,
  ContainerAction,
  DockerImage,
  Network as DockerNetwork,
  Stat,
  Volume,
  PRUNE_LABELS,
  PruneKind,
  actionArgs,
  actionsFor,
  composeArgs,
  composeProjectOf,
  execCommand,
  filterContainers,
  formatPort,
  groupByProject,
  imagesArgs,
  inspectArgs,
  isComposeDisruptive,
  isDisruptive,
  logsArgs,
  networksArgs,
  parseContainers,
  parseImages,
  attachVolumeUsage,
  parseLogLines,
  parseNetworks,
  parseStats,
  parseVolumes,
  pruneArgs,
  pruneImpact,
  psArgs,
  statsArgs,
  summarize,
  sortVolumes,
  volumeLabel,
  volumesArgs,
  webUrl,
} from "../docker";
import { stripAnsi } from "../tabulate";

export interface DockerTarget {
  /** null = machine locale ; sinon identifiant d'une session SSH ouverte. */
  id: string | null;
  label: string;
  /** Hôte à utiliser pour ouvrir un port publié dans le navigateur. */
  host: string;
  /** Serveur sensible : les actions destructrices demandent confirmation. */
  sensitive?: boolean;
}

interface Props {
  targets: DockerTarget[];
  initialTargetId?: string | null;
  /** Joue une commande dans un terminal de la cible (entrée dans un conteneur). */
  onExec: (targetId: string | null, command: string) => void;
  onNotify: (kind: "ok" | "err", text: string) => void;
  onClose: () => void;
}

type Tab = "containers" | "images" | "volumes" | "networks";

const TABS: Array<{ id: Tab; label: string; icon: typeof Boxes }> = [
  { id: "containers", label: "Conteneurs", icon: ContainerIcon },
  { id: "images", label: "Images", icon: Layers },
  { id: "volumes", label: "Volumes", icon: HardDrive },
  { id: "networks", label: "Réseaux", icon: Network },
];

/** Bornes du tampon de journal affiché. */
const MAX_LIGNES = 5000;

const ACTION_ICONS: Record<ContainerAction, typeof Play> = {
  start: Play,
  stop: CircleStop,
  restart: RotateCw,
  pause: Pause,
  unpause: Play,
  kill: Zap,
  rm: Trash2,
};

/** Pastille d'état, couleur comprise. */
function StateDot({ state }: { state: string }) {
  return <span className={`dk-dot dk-${state || "unknown"}`} title={state} />;
}

export default function DockerModal({
  targets,
  initialTargetId = null,
  onExec,
  onNotify,
  onClose,
}: Props) {
  const [targetId, setTargetId] = useState<string | null>(initialTargetId);
  const target = useMemo(
    () => targets.find((t) => t.id === targetId) ?? targets[0],
    [targets, targetId],
  );
  const [tab, setTab] = useState<Tab>("containers");
  const [version, setVersion] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const [containers, setContainers] = useState<Container[]>([]);
  const [stats, setStats] = useState<Record<string, Stat>>({});
  const [images, setImages] = useState<DockerImage[]>([]);
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [networks, setNetworks] = useState<DockerNetwork[]>([]);

  const [showAll, setShowAll] = useState(true);
  const [filter, setFilter] = useState("");
  const [auto, setAuto] = useState(true);
  const [detail, setDetail] = useState<{
    kind: "logs" | "inspect";
    container: Container;
  } | null>(null);
  const [detailText, setDetailText] = useState("");
  const [detailBusy, setDetailBusy] = useState(false);
  const [tail, setTail] = useState(200);

  const cible = target?.id ?? null;
  // Le suivi est consulté depuis openDetail, qui n'est pas re-créé à chaque
  // bascule de la case : une référence évite de le remonter inutilement.
  const autoRef = useRef(auto);
  autoRef.current = auto;

  // Une commande docker sur la cible courante, erreurs remontées telles quelles.
  const run = useCallback(
    (args: string[], timeout?: number) => dockerCli(cible, args, timeout),
    [cible],
  );

  // Sonde à chaque changement de cible : inutile de charger si Docker manque.
  useEffect(() => {
    let stop = false;
    setVersion(null);
    setError(null);
    setContainers([]);
    setStats({});
    setImages([]);
    setVolumes([]);
    setNetworks([]);
    setDetail(null);
    dockerProbe(cible)
      .then((v) => !stop && setVersion(v))
      .catch((e) => !stop && setError(String(e)));
    return () => {
      stop = true;
    };
  }, [cible]);

  const refresh = useCallback(async () => {
    if (!version) return;
    setLoading(true);
    try {
      if (tab === "containers") {
        const [ps, st] = await Promise.all([
          run(psArgs(showAll)),
          // Les mesures sont facultatives : sur un serveur chargé, `docker
          // stats` peut traîner sans que la liste doive en pâtir.
          run(statsArgs(), 25).catch(() => ""),
        ]);
        setContainers(parseContainers(ps));
        const map: Record<string, Stat> = {};
        for (const s of parseStats(st)) map[s.id] = s;
        setStats(map);
      } else if (tab === "images") {
        setImages(parseImages(await run(imagesArgs())));
      } else if (tab === "volumes") {
        // La liste des volumes ne dit pas qui les monte : on le déduit des
        // conteneurs, sans quoi un volume anonyme reste un identifiant nu.
        const [vs, ps] = await Promise.all([
          run(volumesArgs()),
          run(psArgs(true)).catch(() => ""),
        ]);
        setVolumes(sortVolumes(attachVolumeUsage(parseVolumes(vs), parseContainers(ps))));
      } else {
        setNetworks(parseNetworks(await run(networksArgs())));
      }
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [run, tab, showAll, version]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Rafraîchissement périodique : seulement sur la liste des conteneurs, et
  // jamais pendant qu'une action est en cours (la liste sauterait sous la main).
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    if (!auto || tab !== "containers" || !version) return;
    const t = setInterval(() => {
      if (!busy) void refreshRef.current();
    }, 3000);
    return () => clearInterval(t);
  }, [auto, tab, version, busy]);

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

  const act = async (action: ContainerAction, c: Container) => {
    if (isDisruptive(action)) {
      const quoi = `${ACTION_LABELS[action].toLowerCase()} « ${c.name} »`;
      const message = target?.sensitive
        ? `Serveur sensible : ${quoi} sur ${target.label} ?`
        : `${ACTION_LABELS[action]} « ${c.name} » ?`;
      if (!(await ask(message, { title: ACTION_LABELS[action] }))) return;
    }
    setBusy(c.id);
    try {
      await run(actionArgs(action, c.id), 60);
      onNotify("ok", `${ACTION_LABELS[action]} : ${c.name}`);
      await refresh();
    } catch (e) {
      onNotify("err", String(e));
    } finally {
      setBusy(null);
    }
  };

  const actCompose = async (action: ComposeAction, pile: ComposeProject) => {
    if (isComposeDisruptive(action)) {
      const message = target?.sensitive
        ? `Serveur sensible : ${COMPOSE_LABELS[action].toLowerCase()} « ${pile.name} » sur ${target.label} ?`
        : `${COMPOSE_LABELS[action]} « ${pile.name} » ?`;
      if (!(await ask(message, { title: COMPOSE_LABELS[action] }))) return;
    }
    setBusy(`pile-${pile.name}`);
    try {
      // Une pile peut être longue à monter : bien plus large qu'une action
      // sur un conteneur seul.
      await run(composeArgs(pile, action), 120);
      onNotify("ok", `${COMPOSE_LABELS[action]} : ${pile.name}`);
      await refresh();
    } catch (e) {
      onNotify("err", String(e));
    } finally {
      setBusy(null);
    }
  };

  const nettoyer = async (kind: PruneKind) => {
    const impact = pruneImpact(kind, { images, volumes, networks });
    if (impact.count === 0) {
      onNotify("ok", `${PRUNE_LABELS[kind]} : rien à retirer.`);
      return;
    }
    const ok = await ask(`${PRUNE_LABELS[kind]} — ${impact.detail}. Confirmer ?`, {
      title: PRUNE_LABELS[kind],
    });
    if (!ok) return;
    setBusy(`prune-${kind}`);
    try {
      const out = await run(pruneArgs(kind), 120);
      const libere = out.match(/Total reclaimed space:\s*(.+)/i)?.[1]?.trim();
      onNotify(
        "ok",
        libere ? `Nettoyage terminé : ${libere} libérés.` : "Nettoyage terminé.",
      );
      await refresh();
    } catch (e) {
      onNotify("err", String(e));
    } finally {
      setBusy(null);
    }
  };

  const openDetail = useCallback(
    async (kind: "logs" | "inspect", c: Container) => {
      setDetail({ kind, container: c });
      setDetailBusy(true);
      setDetailText("");
      try {
        // En suivi, le flux fournit lui-même l'historique : rien à charger ici.
        if (kind === "logs" && autoRef.current) return;
        const out =
          kind === "logs"
            ? await run(logsArgs(c.id, tail), 40)
            : await run(inspectArgs(c.id), 25);
        setDetailText(stripAnsi(out));
      } catch (e) {
        setDetailText(String(e));
      } finally {
        setDetailBusy(false);
      }
    },
    [run, tail],
  );

  // Journaux en direct : `docker logs --follow` tourne côté backend et pousse
  // ses blocs par évènement. Le premier envoi contient déjà l'historique
  // demandé, il n'y a donc rien à charger séparément.
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!auto || detail?.kind !== "logs") {
      setLive(false);
      return;
    }
    const cle = `dk-${crypto.randomUUID()}`;
    const conteneur = detail.container.id;
    let annule = false;
    let tampon = "";
    let arreterData: (() => void) | undefined;
    let arreterFin: (() => void) | undefined;
    setDetailText("");
    setLive(true);

    void (async () => {
      arreterData = await listen<string>(`docker-log-${cle}`, (e) => {
        tampon += stripAnsi(e.payload);
        // Un conteneur bavard remplirait la mémoire : on ne garde que la fin.
        const lignes = tampon.split("\n");
        if (lignes.length > MAX_LIGNES) tampon = lignes.slice(-MAX_LIGNES).join("\n");
        setDetailText(tampon);
      });
      arreterFin = await listen(`docker-log-end-${cle}`, () => setLive(false));
      if (annule) return;
      try {
        await dockerLogsFollow(cible, cle, conteneur, tail);
      } catch (e) {
        setDetailText(String(e));
        setLive(false);
      }
    })();

    return () => {
      annule = true;
      arreterData?.();
      arreterFin?.();
      void dockerLogsStop(cle).catch(() => {});
    };
  }, [auto, detail, tail, cible]);

  // Suivi coupé alors que le panneau est ouvert : on prend un instantané, sinon
  // l'affichage resterait figé sur la dernière ligne du flux.
  const openDetailRef = useRef(openDetail);
  openDetailRef.current = openDetail;
  useEffect(() => {
    if (detail?.kind !== "logs" || auto) return;
    void openDetailRef.current("logs", detail.container);
    // Dépendances volontairement réduites à l'identité du conteneur : `detail`
    // change d'objet à chaque chargement et relancerait l'effet en boucle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, detail?.kind, detail?.container.id]);

  const logRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = logRef.current;
    if (!el || detail?.kind !== "logs") return;
    // On ne recolle en bas que si l'utilisateur y était déjà.
    const enBas = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    if (enBas) el.scrollTop = el.scrollHeight;
  }, [detailText, detail]);

  const visibles = useMemo(
    () => filterContainers(containers, filter),
    [containers, filter],
  );
  const groupes = useMemo(() => groupByProject(visibles), [visibles]);
  const resume = useMemo(() => summarize(containers), [containers]);

  const ouvrirPort = (hostPort: number, containerPort: number) => {
    const url = webUrl(
      { hostPort, containerPort, protocol: "tcp" },
      target?.host ?? "localhost",
    );
    if (url) void openUrl(url).catch((e) => onNotify("err", String(e)));
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal docker-modal" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">Docker</p>
        <div className="dk-head">
          <h2 className="modal-title">
            <Boxes size={16} /> Conteneurs
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
          {version && <span className="dk-version">Docker {version}</span>}
        </div>

        {error && <div className="modal-error">{error}</div>}

        {version && (
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
              <label className="dk-check">
                <input
                  type="checkbox"
                  checked={auto}
                  onChange={(e) => setAuto(e.target.checked)}
                />
                Suivi auto
              </label>
              <button
                className="dk-icon-btn"
                title="Actualiser"
                onClick={() => void refresh()}
                disabled={loading}
              >
                <RotateCw size={14} className={loading ? "spin" : ""} />
              </button>
            </div>

            {tab === "containers" && !detail && (
              <>
                <div className="dk-bar">
                  <span className="dk-search">
                    <Search size={13} />
                    <input
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      placeholder="Filtrer par nom, image, pile, port…"
                    />
                  </span>
                  <label className="dk-check">
                    <input
                      type="checkbox"
                      checked={showAll}
                      onChange={(e) => setShowAll(e.target.checked)}
                    />
                    Inclure les arrêtés
                  </label>
                  <span className="dk-summary">
                    {resume.running} en marche · {resume.stopped} arrêtés
                    {resume.paused > 0 && ` · ${resume.paused} suspendus`}
                    {resume.projects > 0 && ` · ${resume.projects} pile(s)`}
                  </span>
                </div>

                <div className="dk-body">
                  {groupes.length === 0 && !loading && (
                    <p className="saved-empty">
                      {containers.length === 0
                        ? "Aucun conteneur sur cette machine."
                        : "Aucun conteneur ne correspond au filtre."}
                    </p>
                  )}
                  {groupes.map((g) => {
                    const pile = g.project ? composeProjectOf(g.containers) : null;
                    return (
                      <section key={g.project ?? "—"} className="dk-group">
                        <h3 className="dk-group-title">
                          {g.project ? (
                            <>
                              <Layers size={12} /> {g.project}
                            </>
                          ) : (
                            "Hors pile"
                          )}
                          <span className="dk-count">{g.containers.length}</span>
                          {pile && (
                            <span className="dk-pile-actions">
                              {(["up", "restart", "down"] as ComposeAction[]).map((a) => {
                                const Icon =
                                  a === "up"
                                    ? Play
                                    : a === "restart"
                                      ? RotateCw
                                      : CircleStop;
                                return (
                                  <button
                                    key={a}
                                    className={`dk-icon-btn ${isComposeDisruptive(a) ? "danger" : ""}`}
                                    title={COMPOSE_LABELS[a]}
                                    disabled={busy === `pile-${pile.name}`}
                                    onClick={() => void actCompose(a, pile)}
                                  >
                                    <Icon size={12} />
                                  </button>
                                );
                              })}
                            </span>
                          )}
                        </h3>
                        {g.containers.map((c) => {
                          const s = stats[c.id];
                          return (
                            <div
                              key={c.id}
                              className={`dk-row ${busy === c.id ? "busy" : ""}`}
                            >
                              <StateDot state={c.state} />
                              <span className="dk-name" title={c.name}>
                                {c.service ?? c.name}
                              </span>
                              <span className="dk-image" title={c.image}>
                                {c.image}
                              </span>
                              <span className="dk-ports">
                                {c.ports.map((p) =>
                                  p.hostPort ? (
                                    <button
                                      key={`${p.hostPort}-${p.containerPort}-${p.protocol}`}
                                      className="dk-port link"
                                      title={`Ouvrir dans le navigateur (${target?.host})`}
                                      onClick={() =>
                                        ouvrirPort(p.hostPort!, p.containerPort)
                                      }
                                    >
                                      {formatPort(p)}
                                    </button>
                                  ) : (
                                    <span
                                      key={`i-${p.containerPort}-${p.protocol}`}
                                      className="dk-port"
                                    >
                                      {formatPort(p)}
                                    </span>
                                  ),
                                )}
                              </span>
                              <span className="dk-cpu">
                                {s ? `${s.cpu.toFixed(1)} %` : "—"}
                              </span>
                              <span className="dk-mem" title={s?.memUsage}>
                                {s ? s.memUsage.split(" / ")[0] : "—"}
                              </span>
                              <span className="dk-status" title={c.status}>
                                {c.status}
                              </span>
                              <span className="dk-row-actions">
                                <button
                                  className="dk-icon-btn"
                                  title="Journaux"
                                  onClick={() => void openDetail("logs", c)}
                                >
                                  <ScrollText size={13} />
                                </button>
                                <button
                                  className="dk-icon-btn"
                                  title="Ouvrir un terminal dans le conteneur"
                                  disabled={c.state !== "running"}
                                  onClick={() => {
                                    onExec(cible, execCommand(c.name || c.id));
                                    onClose();
                                  }}
                                >
                                  <SquareTerminal size={13} />
                                </button>
                                <button
                                  className="dk-icon-btn"
                                  title="Inspecter"
                                  onClick={() => void openDetail("inspect", c)}
                                >
                                  <Search size={13} />
                                </button>
                                {actionsFor(c.state).map((a) => {
                                  const Icon = ACTION_ICONS[a];
                                  return (
                                    <button
                                      key={a}
                                      className={`dk-icon-btn ${isDisruptive(a) ? "danger" : ""}`}
                                      title={ACTION_LABELS[a]}
                                      disabled={busy === c.id}
                                      onClick={() => void act(a, c)}
                                    >
                                      <Icon size={13} />
                                    </button>
                                  );
                                })}
                              </span>
                            </div>
                          );
                        })}
                      </section>
                    );
                  })}
                </div>
              </>
            )}

            {detail && (
              <div className="dk-detail">
                <div className="dk-detail-head">
                  <button className="dk-back" onClick={() => setDetail(null)}>
                    <X size={13} /> Retour
                  </button>
                  <strong className="mono">{detail.container.name}</strong>
                  <span className="dk-detail-kind">
                    {detail.kind === "logs" ? "journaux" : "inspection"}
                  </span>
                  {detail.kind === "logs" && live && (
                    <span className="dk-live" title="Flux ouvert sur le conteneur">
                      <Radio size={11} /> en direct
                    </span>
                  )}
                  {detail.kind === "logs" && (
                    <select
                      className="dk-select"
                      value={tail}
                      onChange={(e) => {
                        setTail(Number(e.target.value));
                        void openDetail("logs", detail.container);
                      }}
                    >
                      <option value={100}>100 lignes</option>
                      <option value={200}>200 lignes</option>
                      <option value={1000}>1 000 lignes</option>
                      <option value={5000}>5 000 lignes</option>
                    </select>
                  )}
                  <button
                    className="dk-icon-btn"
                    title="Actualiser"
                    onClick={() => void openDetail(detail.kind, detail.container)}
                  >
                    <RotateCw size={14} className={detailBusy ? "spin" : ""} />
                  </button>
                </div>
                <pre className="dk-log" ref={logRef}>
                  {detailBusy && !detailText
                    ? "Chargement…"
                    : detail.kind === "logs"
                      ? parseLogLines(detailText).map((l, i) => (
                          <div
                            key={i}
                            className={`dk-logline ${l.level ? `lv-${l.level}` : ""}`}
                          >
                            {l.time && <span className="dk-logtime">{l.time}</span>}
                            {l.text}
                          </div>
                        ))
                      : detailText || "(vide)"}
                </pre>
              </div>
            )}

            {(tab === "images" || tab === "volumes" || tab === "networks") && (
              <div className="dk-bar">
                {(() => {
                  const kind: PruneKind = tab;
                  const impact = pruneImpact(kind, { images, volumes, networks });
                  return (
                    <>
                      <span className="dk-summary">{impact.detail}</span>
                      <button
                        className="dk-prune"
                        disabled={impact.count === 0 || busy === `prune-${kind}`}
                        onClick={() => void nettoyer(kind)}
                      >
                        <Trash2 size={12} /> {PRUNE_LABELS[kind]}
                      </button>
                    </>
                  );
                })()}
              </div>
            )}

            {tab === "images" && (
              <div className="dk-body">
                <div className="dk-row dk-head-row">
                  <span className="dk-name">Dépôt</span>
                  <span className="dk-image">Étiquette</span>
                  <span className="dk-status">Créée</span>
                  <span className="dk-cpu">Taille</span>
                </div>
                {images.map((im) => (
                  <div key={`${im.repository}-${im.tag}-${im.id}`} className="dk-row">
                    <span className="dk-name" title={im.repository}>
                      {im.dangling ? <em>(orpheline)</em> : im.repository}
                    </span>
                    <span className="dk-image">{im.tag}</span>
                    <span className="dk-status">{im.createdSince}</span>
                    <span className="dk-cpu">
                      {Number.isFinite(im.sizeBytes) && im.sizeBytes > 0
                        ? formatSize(im.sizeBytes)
                        : im.size}
                    </span>
                  </div>
                ))}
                {images.length === 0 && !loading && (
                  <p className="saved-empty">Aucune image.</p>
                )}
              </div>
            )}

            {tab === "volumes" && (
              <div className="dk-body">
                {volumes.map((v) => (
                  <div key={v.name} className="dk-row">
                    <span className="dk-name" title={v.name}>
                      {volumeLabel(v.name)}
                    </span>
                    <span className="dk-image">{v.project ?? "—"}</span>
                    <span
                      className="dk-status"
                      title={v.usedBy?.length ? v.usedBy.join(", ") : v.mountpoint}
                    >
                      {v.usedBy?.length
                        ? `monté par ${v.usedBy.join(", ")}`
                        : "inutilisé"}
                    </span>
                  </div>
                ))}
                {volumes.length === 0 && !loading && (
                  <p className="saved-empty">Aucun volume.</p>
                )}
              </div>
            )}

            {tab === "networks" && (
              <div className="dk-body">
                {networks.map((n) => (
                  <div key={n.id} className="dk-row">
                    <span className="dk-name">{n.name}</span>
                    <span className="dk-image">{n.driver}</span>
                    <span className="dk-status">{n.project ?? "—"}</span>
                    <span className="dk-cpu mono">{n.id}</span>
                  </div>
                ))}
                {networks.length === 0 && !loading && (
                  <p className="saved-empty">Aucun réseau.</p>
                )}
              </div>
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
