import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { confirmMatches } from "../guards";

interface Props {
  /** Nom à retaper (celui de la connexion). */
  expected: string;
  action: string;
  details: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDangerModal({
  expected,
  action,
  details,
  onConfirm,
  onCancel,
}: Props) {
  const [typed, setTyped] = useState("");
  const ok = confirmMatches(typed, expected);

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) onConfirm();
        }}
      >
        <p className="modal-eyebrow">Serveur sensible</p>
        <h2 className="modal-title">
          <TriangleAlert size={16} /> {action}
        </h2>
        <p className="hostkey-text danger">{details}</p>
        <p className="hostkey-text">
          Ce serveur est marqué comme sensible. Pour confirmer, retapez son nom :{" "}
          <code>{expected}</code>
        </p>
        <label className="field">
          <span>Nom du serveur</span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={expected}
            autoFocus
          />
        </label>
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Annuler
          </button>
          <button type="submit" className="btn danger-solid" disabled={!ok}>
            Confirmer
          </button>
        </div>
      </form>
    </div>
  );
}
