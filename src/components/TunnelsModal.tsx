import { useEffect, useState } from "react";
import { Cable, Trash2 } from "lucide-react";
import {
  Tunnel,
  tunnelClose,
  tunnelList,
  tunnelOpen,
  tunnelOpenRemote,
  tunnelOpenSocks,
} from "../api";

type Kind = "local" | "remote" | "socks";

const KIND_LABEL: Record<Kind, string> = {
  local: "Local (-L)",
  remote: "Distant (-R)",
  socks: "SOCKS (-D)",
};

const KIND_HELP: Record<Kind, string> = {
  local: "Ce qui arrive sur votre port local est transporté jusqu'à la machine distante.",
  remote:
    "Le serveur écoute sur un port et renvoie tout vers un service de cette machine.",
  socks: "Proxy SOCKS5 local : votre navigateur ou vos outils sortent par le serveur.",
};

interface Props {
  sessionId: string;
  sessionLabel: string;
  onClose: () => void;
}

export default function TunnelsModal({ sessionId, sessionLabel, onClose }: Props) {
  const [tunnels, setTunnels] = useState<Tunnel[]>([]);
  const [kind, setKind] = useState<Kind>("local");
  const [localPort, setLocalPort] = useState(8080);
  const [remoteHost, setRemoteHost] = useState("127.0.0.1");
  const [remotePort, setRemotePort] = useState(80);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    tunnelList()
      .then(setTunnels)
      .catch(() => {});

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, []);

  const open = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (kind === "local") {
        await tunnelOpen(sessionId, localPort, remoteHost.trim(), remotePort);
      } else if (kind === "remote") {
        // -R : le serveur écoute sur remotePort, on renvoie vers localHost:localPort.
        await tunnelOpenRemote(sessionId, remotePort, remoteHost.trim(), localPort);
      } else {
        await tunnelOpenSocks(sessionId, localPort);
      }
      refresh();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  const mine = tunnels.filter((t) => t.sessionId === sessionId);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={open}>
        <p className="modal-eyebrow">Redirection de port</p>
        <h2 className="modal-title">Tunnels — {sessionLabel}</h2>
        <div className="settings-tabs" role="tablist">
          {(["local", "remote", "socks"] as Kind[]).map((k) => (
            <button
              type="button"
              key={k}
              className={kind === k ? "active" : ""}
              onClick={() => setKind(k)}
            >
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <p className="hostkey-text">{KIND_HELP[kind]}</p>

        <div className="field-row">
          <label className="field grow">
            <span>{kind === "remote" ? "Port local (cible)" : "Port local"}</span>
            <input
              type="number"
              min={1}
              max={65535}
              className="mono"
              value={localPort}
              onChange={(e) => setLocalPort(Number(e.target.value) || 8080)}
            />
          </label>
          {kind !== "socks" && (
            <>
              <label className="field grow">
                <span>{kind === "remote" ? "Hôte local (cible)" : "Hôte distant"}</span>
                <input
                  className="mono"
                  value={remoteHost}
                  onChange={(e) => setRemoteHost(e.target.value)}
                  placeholder="127.0.0.1"
                />
              </label>
              <label className="field port">
                <span>{kind === "remote" ? "Port du serveur" : "Port distant"}</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  className="mono"
                  value={remotePort}
                  onChange={(e) => setRemotePort(Number(e.target.value) || 80)}
                />
              </label>
            </>
          )}
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="modal-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            <Cable size={13} /> {busy ? "Ouverture…" : "Ouvrir le tunnel"}
          </button>
        </div>

        <p className="settings-group">Tunnels ouverts</p>
        {mine.length === 0 ? (
          <p className="saved-empty">Aucun tunnel pour cette session.</p>
        ) : (
          mine.map((t) => (
            <div key={t.id} className="tunnel-row">
              <span className="tunnel-kind">{t.kind}</span>
              <span className="tunnel-path mono">
                {t.kind === "socks"
                  ? `socks5://127.0.0.1:${t.localPort}`
                  : t.kind === "remote"
                    ? `serveur:${t.remotePort} → ${t.remoteHost}:${t.localPort}`
                    : `localhost:${t.localPort} → ${t.remoteHost}:${t.remotePort}`}
              </span>
              <span className="tunnel-count">
                {t.connections} connexion{t.connections > 1 ? "s" : ""}
              </span>
              <button
                type="button"
                className="sc-mini"
                title="Fermer le tunnel"
                onClick={() => tunnelClose(t.id).then(refresh)}
              >
                <Trash2 size={12} />
              </button>
            </div>
          ))
        )}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Fermer
          </button>
        </div>
      </form>
    </div>
  );
}
