import { useState } from "react";
import { Plus, Trash2, Zap } from "lucide-react";
import { Snippet } from "../snippets";

interface Props {
  snippets: Snippet[];
  onChange: (list: Snippet[]) => void;
}

export default function SnippetsTab({ snippets, onChange }: Props) {
  const [label, setLabel] = useState("");
  const [command, setCommand] = useState("");

  const add = () => {
    const l = label.trim();
    const c = command.trim();
    if (!l || !c) return;
    onChange([...snippets, { id: crypto.randomUUID(), label: l, command: c }]);
    setLabel("");
    setCommand("");
  };

  return (
    <>
      <p className="sc-intro">
        Ces commandes sont envoyées dans le panneau actif depuis le bouton « commandes »
        ou la palette (⌘K). Les variables <code>{"{{host}}"}</code>,{" "}
        <code>{"{{user}}"}</code> et <code>{"{{path}}"}</code> sont remplacées à l'envoi ;
        toute autre variable, comme <code>{"{{service}}"}</code>, est demandée au moment
        de jouer la commande.
      </p>

      <p className="settings-group">Mes commandes</p>
      {snippets.length === 0 && <p className="saved-empty">Aucune commande.</p>}
      {snippets.map((s) => (
        <div key={s.id} className="snip-row">
          <span className="snip-label">
            <Zap size={12} /> {s.label}
          </span>
          <code className="snip-cmd">{s.command}</code>
          <button
            className="sc-mini"
            title="Supprimer"
            onClick={() => onChange(snippets.filter((x) => x.id !== s.id))}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}

      <p className="settings-group">Ajouter</p>
      <div className="field-row">
        <label className="field grow">
          <span>Nom</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Redémarrer nginx"
          />
        </label>
      </div>
      <label className="field">
        <span>Commande</span>
        <input
          className="mono"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="sudo systemctl restart nginx"
        />
      </label>
      <div className="modal-actions">
        <button className="btn" onClick={add} disabled={!label.trim() || !command.trim()}>
          <Plus size={13} /> Ajouter la commande
        </button>
      </div>
    </>
  );
}
