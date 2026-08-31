import { useEffect, useState } from "react";
import { Boxes, Cpu, RotateCw, Play, Square } from "lucide-react";
import {
  ServerStats,
  ServiceItem,
  remoteServiceAction,
  remoteServices,
  remoteStats,
} from "../api";

/** Courbe minimaliste : une valeur par relevé, échelle automatique. */
function Sparkline({ values, max }: { values: number[]; max?: number }) {
  if (values.length < 2) return null;
  const top = max ?? Math.max(...values, 0.001);
  const w = 100;
  const h = 22;
  const step = w / (values.length - 1);
  const points = values
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / top) * h).toFixed(1)}`)
    .join(" ");
  return (
    <svg className="sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={points} />
    </svg>
  );
}

interface Props {
  sessionId: string;
  sessionLabel: string;
  onClose: () => void;
  onNotify: (kind: "ok" | "err", text: string) => void;
}

export default function DashboardModal({
  sessionId,
  sessionLabel,
  onClose,
  onNotify,
}: Props) {
  const [tab, setTab] = useState<"stats" | "docker" | "systemd">("stats");
  const [stats, setStats] = useState<ServerStats | null>(null);
  const [items, setItems] = useState<ServiceItem[]>([]);
  const [loading, setLoading] = useState(false);
  // Historique court pour les courbes (une valeur par relevé).
  const [series, setSeries] = useState<{ load: number[]; mem: number[] }>({
    load: [],
    mem: [],
  });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    setError(null);
    setLoading(true);
    const load = async () => {
      try {
        if (tab === "stats") {
          const s = await remoteStats(sessionId);
          if (!stop) {
            setStats(s);
            const load = parseFloat(s.load.split(/\s+/)[0] ?? "");
            const used = parseFloat((s.memUsed || "").replace(/[^\d.]/g, ""));
            const total = parseFloat((s.memTotal || "").replace(/[^\d.]/g, ""));
            setSeries((prev) => ({
              load: [...prev.load, Number.isFinite(load) ? load : 0].slice(-40),
              mem: [
                ...prev.mem,
                Number.isFinite(used) && Number.isFinite(total) && total > 0
                  ? (used / total) * 100
                  : 0,
              ].slice(-40),
            }));
          }
        } else {
          const list = await remoteServices(sessionId, tab);
          if (!stop) setItems(list);
        }
      } catch (e) {
        if (!stop) setError(String(e));
      } finally {
        if (!stop) setLoading(false);
      }
    };
    load();
    const t = tab === "stats" ? setInterval(load, 5000) : undefined;
    return () => {
      stop = true;
      if (t) clearInterval(t);
    };
  }, [tab, sessionId]);

  const act = async (name: string, action: "start" | "stop" | "restart") => {
    if (tab === "stats") return;
    try {
      const out = await remoteServiceAction(sessionId, tab, name, action);
      onNotify("ok", `${action} ${name} : ${out.trim().slice(0, 120) || "ok"}`);
      const list = await remoteServices(sessionId, tab);
      setItems(list);
    } catch (e) {
      onNotify("err", String(e));
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide-modal" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">État du serveur</p>
        <h2 className="modal-title">{sessionLabel}</h2>

        <div className="settings-tabs" role="tablist">
          <button
            className={tab === "stats" ? "active" : ""}
            onClick={() => setTab("stats")}
          >
            <Cpu size={13} /> Système
          </button>
          <button
            className={tab === "docker" ? "active" : ""}
            onClick={() => setTab("docker")}
          >
            <Boxes size={13} /> Docker
          </button>
          <button
            className={tab === "systemd" ? "active" : ""}
            onClick={() => setTab("systemd")}
          >
            <RotateCw size={13} /> systemd
          </button>
        </div>

        {error && <div className="modal-error">{error}</div>}

        {tab === "stats" ? (
          stats ? (
            <>
              <div className="stat-grid">
                <div className="stat-cell">
                  <span className="stat-key">Disponibilité</span>
                  <span className="stat-val">{stats.uptime || "—"}</span>
                </div>
                <div className="stat-cell">
                  <span className="stat-key">Charge</span>
                  <span className="stat-val mono">{stats.load || "—"}</span>
                  <Sparkline values={series.load} />
                </div>
                <div className="stat-cell">
                  <span className="stat-key">Mémoire</span>
                  <span className="stat-val mono">
                    {stats.memUsed && stats.memTotal
                      ? `${stats.memUsed} / ${stats.memTotal}`
                      : "—"}
                  </span>
                  <Sparkline values={series.mem} max={100} />
                </div>
                <div className="stat-cell">
                  <span className="stat-key">Cœurs</span>
                  <span className="stat-val mono">{stats.cpuCount || "—"}</span>
                </div>
                <div className="stat-cell wide">
                  <span className="stat-key">Noyau</span>
                  <span className="stat-val mono">{stats.kernel || "—"}</span>
                </div>
              </div>
              <p className="settings-group">Processus les plus gourmands</p>
              {stats.top.length === 0 ? (
                <p className="saved-empty">Indisponible sur ce serveur.</p>
              ) : (
                stats.top.map((line, i) => (
                  <div key={i} className="top-line mono">
                    {line}
                  </div>
                ))
              )}
            </>
          ) : (
            <p className="saved-empty">{loading ? "Relevé en cours…" : "—"}</p>
          )
        ) : (
          <div className="svc-list">
            {loading && items.length === 0 && <p className="saved-empty">Chargement…</p>}
            {!loading && items.length === 0 && !error && (
              <p className="saved-empty">Aucun élément.</p>
            )}
            {items.map((it) => (
              <div key={it.name} className="svc-row">
                <span
                  className={`svc-dot ${
                    /running|active/i.test(it.status) ? "up" : "down"
                  }`}
                />
                <span className="svc-name mono">{it.name}</span>
                <span className="svc-detail">{it.detail}</span>
                <span className="svc-actions">
                  <button
                    className="sc-mini"
                    title="Démarrer"
                    onClick={() => act(it.name, "start")}
                  >
                    <Play size={11} />
                  </button>
                  <button
                    className="sc-mini"
                    title="Redémarrer"
                    onClick={() => act(it.name, "restart")}
                  >
                    <RotateCw size={11} />
                  </button>
                  <button
                    className="sc-mini"
                    title="Arrêter"
                    onClick={() => act(it.name, "stop")}
                  >
                    <Square size={11} />
                  </button>
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
