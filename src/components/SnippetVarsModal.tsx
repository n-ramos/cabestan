import { useState } from "react";
import { Zap } from "lucide-react";
import { fillPlaceholders } from "../snippets";

interface Props {
  /** Commande contenant les {{variables}} à remplir. */
  command: string;
  /** Noms des variables à demander, dans l'ordre d'apparition. */
  names: string[];
  onSubmit: (filled: string) => void;
  onCancel: () => void;
}

/** Demande les valeurs des variables d'une commande avant de l'envoyer. */
export default function SnippetVarsModal({ command, names, onSubmit, onCancel }: Props) {
  const [values, setValues] = useState<Record<string, string>>({});
  const preview = fillPlaceholders(command, values);

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(preview);
        }}
      >
        <p className="modal-eyebrow">Commande</p>
        <h2 className="modal-title">
          <Zap size={16} /> Variables à remplir
        </h2>

        {names.map((name, i) => (
          <label key={name} className="field">
            <span>{name}</span>
            <input
              className="mono"
              autoFocus={i === 0}
              value={values[name] ?? ""}
              onChange={(e) =>
                setValues((prev) => ({ ...prev, [name]: e.target.value }))
              }
            />
          </label>
        ))}

        <p className="preview-meta mono">{preview}</p>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onCancel}>
            Annuler
          </button>
          <button type="submit" className="btn primary">
            <Zap size={13} /> Envoyer
          </button>
        </div>
      </form>
    </div>
  );
}
