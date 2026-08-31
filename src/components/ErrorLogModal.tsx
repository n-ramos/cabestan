import { ClipboardCopy, Trash2, TriangleAlert } from "lucide-react";

export interface LoggedError {
  id: string;
  at: number;
  text: string;
}

interface Props {
  errors: LoggedError[];
  onClear: () => void;
  onClose: () => void;
}

export default function ErrorLogModal({ errors, onClear, onClose }: Props) {
  const copy = () =>
    navigator.clipboard
      ?.writeText(
        errors
          .map((e) => `${new Date(e.at).toLocaleTimeString("fr-FR")} ${e.text}`)
          .join("\n"),
      )
      .catch(() => {});

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal wide-modal" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">Journal</p>
        <h2 className="modal-title">
          <TriangleAlert size={16} /> Dernières erreurs
        </h2>
        <p className="sv-note">
          Les 50 dernières erreurs de la session, même celles dont le message a déjà
          disparu.
        </p>

        {errors.length === 0 ? (
          <p className="saved-empty">Aucune erreur enregistrée.</p>
        ) : (
          <div className="kh-list">
            {[...errors].reverse().map((e) => (
              <div key={e.id} className="el-row">
                <span className="el-time mono">
                  {new Date(e.at).toLocaleTimeString("fr-FR")}
                </span>
                <span className="el-text">{e.text}</span>
              </div>
            ))}
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={copy} disabled={errors.length === 0}>
            <ClipboardCopy size={13} /> Copier
          </button>
          <button className="btn" onClick={onClear} disabled={errors.length === 0}>
            <Trash2 size={13} /> Vider
          </button>
          <button className="btn primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
