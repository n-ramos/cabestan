import { useEffect, useState } from "react";
import {
  ArrowLeftRight,
  ArrowRight,
  ArrowLeft,
  FolderSync,
  MonitorDown,
} from "lucide-react";
import { confirm as ask } from "@tauri-apps/plugin-dialog";
import { DiffEntry, compareDirs, formatDate, formatSize } from "../api";

interface Props {
  sessionId: string;
  remoteDir: string;
  localDir: string;
  onSend: (names: string[]) => void;
  onFetch: (names: string[]) => void;
  /**
   * Miroir : transfère `transfer` dans la direction donnée et met à la
   * corbeille les orphelins `remove` de l'autre côté.
   */
  onMirror: (
    direction: "toServer" | "toLocal",
    transfer: string[],
    remove: string[],
  ) => void;
  onClose: () => void;
}

const LABELS: Record<DiffEntry["status"], string> = {
  local: "local seulement",
  remote: "serveur seulement",
  differs: "tailles différentes",
  same: "identiques",
};

/** Quel côté est le plus récent, quand les deux dates sont connues. */
function newerSide(r: DiffEntry): "local" | "remote" | null {
  if (r.status !== "differs" || r.localMtime == null || r.remoteMtime == null) {
    return null;
  }
  if (r.localMtime === r.remoteMtime) return null;
  return r.localMtime > r.remoteMtime ? "local" : "remote";
}

export default function CompareModal({
  sessionId,
  remoteDir,
  localDir,
  onSend,
  onFetch,
  onMirror,
  onClose,
}: Props) {
  const [rows, setRows] = useState<DiffEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    compareDirs(sessionId, localDir, remoteDir)
      .then(setRows)
      .catch((e) => setError(String(e)));
  }, [sessionId, localDir, remoteDir]);

  const pick = (status: DiffEntry["status"]) =>
    (rows ?? []).filter((r) => r.status === status).map((r) => r.name);

  const mirror = async (direction: "toServer" | "toLocal") => {
    const transfer =
      direction === "toServer"
        ? [...pick("local"), ...pick("differs")]
        : [...pick("remote"), ...pick("differs")];
    const remove = direction === "toServer" ? pick("remote") : pick("local");
    if (transfer.length === 0 && remove.length === 0) return;
    const où = direction === "toServer" ? "le serveur" : "ce Mac";
    const corbeille =
      direction === "toServer" ? "la corbeille du serveur" : "la corbeille du Mac";
    const détail = [
      transfer.length > 0 && `${transfer.length} fichier(s) copiés vers ${où}`,
      remove.length > 0 && `${remove.length} fichier(s) déplacés vers ${corbeille}`,
    ]
      .filter(Boolean)
      .join(", ");
    if (!(await ask(`Miroir : ${détail}. Continuer ?`, { title: "Synchroniser" }))) {
      return;
    }
    onMirror(direction, transfer, remove);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide-modal" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">Comparaison</p>
        <h2 className="modal-title">
          <ArrowLeftRight size={16} /> Local ↔ serveur
        </h2>
        <p className="preview-meta mono">
          {localDir} ↔ {remoteDir}
        </p>

        {error && <div className="modal-error">{error}</div>}

        {!rows ? (
          <p className="saved-empty">Comparaison en cours…</p>
        ) : rows.length === 0 ? (
          <p className="saved-empty">Les deux dossiers sont vides.</p>
        ) : (
          <div className="diff-list">
            {rows.map((r) => {
              const récent = newerSide(r);
              return (
                <div key={r.name} className={`diff-row ${r.status}`}>
                  <span className="diff-name">{r.name}</span>
                  <span
                    className="diff-sizes mono"
                    title={`local : ${formatDate(r.localMtime)} · serveur : ${formatDate(r.remoteMtime)}`}
                  >
                    {r.localSize != null ? formatSize(r.localSize) : "—"} /{" "}
                    {r.remoteSize != null ? formatSize(r.remoteSize) : "—"}
                  </span>
                  <span className="diff-status">
                    {LABELS[r.status]}
                    {récent === "local" && " · local plus récent"}
                    {récent === "remote" && " · serveur plus récent"}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Fermer
          </button>
          <button
            className="btn"
            title="Envoie les manquants et différents, met les orphelins du serveur à sa corbeille"
            disabled={
              !rows ||
              pick("local").length + pick("differs").length + pick("remote").length === 0
            }
            onClick={() => void mirror("toServer")}
          >
            <FolderSync size={13} /> Miroir → serveur
          </button>
          <button
            className="btn"
            title="Récupère les manquants et différents, met les orphelins locaux à la corbeille"
            disabled={
              !rows ||
              pick("remote").length + pick("differs").length + pick("local").length === 0
            }
            onClick={() => void mirror("toLocal")}
          >
            <MonitorDown size={13} /> Miroir → local
          </button>
          <button
            className="btn"
            disabled={!rows || pick("local").length + pick("differs").length === 0}
            onClick={() => onSend([...pick("local"), ...pick("differs")])}
          >
            <ArrowRight size={13} /> Envoyer les manquants et différents
          </button>
          <button
            className="btn primary"
            disabled={!rows || pick("remote").length + pick("differs").length === 0}
            onClick={() => onFetch([...pick("remote"), ...pick("differs")])}
          >
            <ArrowLeft size={13} /> Récupérer les manquants et différents
          </button>
        </div>
      </div>
    </div>
  );
}
