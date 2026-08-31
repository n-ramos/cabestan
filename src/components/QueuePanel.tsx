import { Pause, Play, RotateCcw, Trash2, X } from "lucide-react";
import { Job, MAX_ATTEMPTS, canRetry, queueSummary } from "../queue";

interface Props {
  jobs: Job[];
  paused: boolean;
  concurrency: number;
  onPause: (paused: boolean) => void;
  onConcurrency: (n: number) => void;
  onRetry: (id: string) => void;
  onCancel: (id: string) => void;
  onClear: () => void;
  onClose: () => void;
}

const STATE_CLASS: Record<Job["state"], string> = {
  attente: "wait",
  "en cours": "run",
  terminé: "done",
  échec: "fail",
  annulé: "cancel",
};

export default function QueuePanel({
  jobs,
  paused,
  concurrency,
  onPause,
  onConcurrency,
  onRetry,
  onCancel,
  onClear,
  onClose,
}: Props) {
  const s = queueSummary(jobs);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide-modal" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">File de transferts</p>
        <h2 className="modal-title">
          {s.enCours} en cours · {s.attente} en attente
          {s.echec > 0 && ` · ${s.echec} en échec`}
        </h2>

        <div className="queue-controls">
          <button className="btn" onClick={() => onPause(!paused)}>
            {paused ? (
              <>
                <Play size={13} /> Reprendre
              </>
            ) : (
              <>
                <Pause size={13} /> Mettre en pause
              </>
            )}
          </button>
          <label className="field concurrency">
            <span>Transferts simultanés</span>
            <input
              type="number"
              min={1}
              max={8}
              className="mono"
              value={concurrency}
              onChange={(e) =>
                onConcurrency(Math.min(8, Math.max(1, Number(e.target.value) || 1)))
              }
            />
          </label>
          <span className="status-spacer" />
          <button className="btn" onClick={onClear} disabled={jobs.length === 0}>
            <Trash2 size={13} /> Vider la liste
          </button>
        </div>

        {paused && (
          <p className="dead-auto">
            File en pause — les transferts en cours se terminent, les suivants attendent.
          </p>
        )}

        {jobs.length === 0 ? (
          <p className="saved-empty">Aucun transfert en file.</p>
        ) : (
          <div className="queue-list">
            {jobs.map((j) => (
              <div key={j.id} className={`queue-row ${STATE_CLASS[j.state]}`}>
                <span className="queue-dir">{j.kind === "upload" ? "↑" : "↓"}</span>
                <span className="queue-name" title={`${j.localPath} → ${j.remotePath}`}>
                  {j.name}
                </span>
                <span className="queue-state">
                  {j.state}
                  {j.attempts > 0 && ` (${j.attempts}/${MAX_ATTEMPTS})`}
                </span>
                {j.error && (
                  <span className="queue-error" title={j.error}>
                    {j.error.slice(0, 40)}
                  </span>
                )}
                <span className="queue-actions">
                  {canRetry(j) && (
                    <button
                      className="sc-mini"
                      title="Reprendre ce transfert"
                      onClick={() => onRetry(j.id)}
                    >
                      <RotateCcw size={11} />
                    </button>
                  )}
                  {(j.state === "attente" || j.state === "en cours") && (
                    <button
                      className="sc-mini"
                      title="Annuler ce transfert"
                      onClick={() => onCancel(j.id)}
                    >
                      <X size={11} />
                    </button>
                  )}
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
