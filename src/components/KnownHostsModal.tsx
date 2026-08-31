import { useEffect, useState } from "react";
import { ShieldCheck, Trash2 } from "lucide-react";
import { KnownHostLine, knownHostsList, knownHostsRemove } from "../api";

export default function KnownHostsModal({ onClose }: { onClose: () => void }) {
  const [lines, setLines] = useState<KnownHostLine[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = () =>
    knownHostsList()
      .then(setLines)
      .catch((e) => setError(String(e)));
  useEffect(() => {
    refresh();
  }, []);

  const shown = lines.filter((l) =>
    l.hosts.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide-modal" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">Empreintes mémorisées</p>
        <h2 className="modal-title">
          <ShieldCheck size={16} /> Hôtes connus
        </h2>
        <p className="hostkey-text">
          Contenu de <code>~/.ssh/known_hosts</code>. Retirer une ligne fera redemander la
          confirmation d'empreinte à la prochaine connexion.
        </p>

        <label className="field">
          <span>Filtrer</span>
          <input
            className="mono"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="exemple.fr"
          />
        </label>

        {error && <div className="modal-error">{error}</div>}

        <div className="kh-list">
          {shown.length === 0 ? (
            <p className="saved-empty">Aucune entrée.</p>
          ) : (
            shown.map((l) => (
              <div key={l.line} className="kh-row">
                <span className="kh-host mono">{l.hosts}</span>
                <span className="kh-algo">{l.algo}</span>
                <button
                  className="sc-mini"
                  title="Retirer cette empreinte"
                  onClick={() =>
                    knownHostsRemove(l.line)
                      .then(refresh)
                      .catch((e) => setError(String(e)))
                  }
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="modal-actions">
          <button className="btn primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
