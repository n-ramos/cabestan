import { useState } from "react";
import { Folder, File as FileGlyph, Search } from "lucide-react";
import { SearchHit } from "../api";

interface Props {
  root: string;
  hits: SearchHit[] | null;
  searching: boolean;
  onSearch: (pattern: string, contains: string) => void;
  onOpen: (hit: SearchHit) => void;
  onClose: () => void;
}

export default function SearchModal({
  root,
  hits,
  searching,
  onSearch,
  onOpen,
  onClose,
}: Props) {
  const [pattern, setPattern] = useState("");
  const [contains, setContains] = useState("");

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(pattern, contains);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <form className="modal" onMouseDown={(e) => e.stopPropagation()} onSubmit={submit}>
        <p className="modal-eyebrow">Recherche sur le serveur</p>
        <h2 className="modal-title">Chercher sous {root}</h2>

        <label className="field">
          <span>Nom du fichier (recherche partielle)</span>
          <input
            className="mono"
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder="config, .log, backup…"
            autoFocus
          />
        </label>
        <label className="field">
          <span>Ou texte contenu dans les fichiers</span>
          <input
            className="mono"
            value={contains}
            onChange={(e) => setContains(e.target.value)}
            placeholder="DB_PASSWORD, TODO…"
          />
        </label>
        <p className="snippets-hint">
          Si les deux champs sont remplis, la recherche par contenu prime. Les dossiers{" "}
          <code>.git</code> et les binaires sont ignorés.
        </p>

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Fermer
          </button>
          <button type="submit" className="btn primary" disabled={searching}>
            <Search size={13} /> {searching ? "Recherche…" : "Chercher"}
          </button>
        </div>

        {hits && (
          <>
            <p className="settings-group">
              {hits.length === 0
                ? "Aucun résultat"
                : `${hits.length} résultat${hits.length > 1 ? "s" : ""}`}
            </p>
            <div className="search-hits">
              {hits.map((h) => (
                <button
                  type="button"
                  key={h.path}
                  className="ctx-item"
                  onClick={() => onOpen(h)}
                  title={h.path}
                >
                  {h.isDir ? <Folder size={13} /> : <FileGlyph size={13} />}
                  <span className="hit-path">{h.path}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </form>
    </div>
  );
}
