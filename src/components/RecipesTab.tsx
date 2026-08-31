import { useState } from "react";
import { Plus, Sparkles, Trash2 } from "lucide-react";
import { CustomRecipe, RECIPES } from "../tabulate";

interface Props {
  recipes: CustomRecipe[];
  onChange: (list: CustomRecipe[]) => void;
}

export default function RecipesTab({ recipes, onChange }: Props) {
  const [label, setLabel] = useState("");
  const [prefix, setPrefix] = useState("");
  const [command, setCommand] = useState("");
  const [headers, setHeaders] = useState("");

  const complete = prefix.trim() && command.trim() && headers.trim();

  const add = () => {
    if (!complete) return;
    onChange([
      ...recipes,
      { id: crypto.randomUUID(), label: label.trim(), prefix, command, headers },
    ]);
    setLabel("");
    setPrefix("");
    setCommand("");
    setHeaders("");
  };

  return (
    <>
      <p className="sc-intro">
        Une recette met en tableau la sortie d'une commande. Quand vous tapez le début
        indiqué, Cabestan exécute la version « tabulée » et découpe sur les tabulations.
        Vos recettes passent avant celles intégrées.
      </p>

      <p className="settings-group">Mes recettes</p>
      {recipes.length === 0 && (
        <p className="saved-empty">Aucune recette personnalisée.</p>
      )}
      {recipes.map((r) => (
        <div key={r.id} className="snip-row">
          <span className="snip-label">
            <Sparkles size={12} /> {r.label || r.prefix}
          </span>
          <code className="snip-cmd">
            {r.prefix} → {r.headers}
          </code>
          <button
            className="sc-mini"
            title="Supprimer"
            onClick={() => onChange(recipes.filter((x) => x.id !== r.id))}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}

      <p className="settings-group">Ajouter une recette</p>
      <div className="field-row">
        <label className="field grow">
          <span>Nom</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Files d'attente"
          />
        </label>
        <label className="field grow">
          <span>Déclenchée quand la commande commence par</span>
          <input
            className="mono"
            value={prefix}
            onChange={(e) => setPrefix(e.target.value)}
            placeholder="rabbitmqctl list_queues"
          />
        </label>
      </div>
      <label className="field">
        <span>Commande exécutée (séparez les colonnes par des tabulations)</span>
        <input
          className="mono"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="rabbitmqctl list_queues name messages | tail -n +2"
        />
      </label>
      <label className="field">
        <span>En-têtes, séparés par des virgules</span>
        <input
          className="mono"
          value={headers}
          onChange={(e) => setHeaders(e.target.value)}
          placeholder="File, Messages"
        />
      </label>
      <p className="snippets-hint">
        Astuce : <code>awk</code> aide à produire des tabulations, par exemple{" "}
        <code>{`awk '{print $1"\\t"$2}'`}</code>. {RECIPES.length} recettes sont déjà
        fournies (Docker, disque, processus, services, ports, dossier).
      </p>

      <div className="modal-actions">
        <button className="btn" onClick={add} disabled={!complete}>
          <Plus size={13} /> Ajouter
        </button>
      </div>
    </>
  );
}
