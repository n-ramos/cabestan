import { useMemo, useState } from "react";
import { Braces, FileText } from "lucide-react";
import { FileEntry, Preview, formatSize } from "../api";
import { parseJsonTree, parseYamlTree } from "../tree";
import TreeView from "./TreeView";

interface Props {
  entry: FileEntry;
  data: Preview;
  onClose: () => void;
}

export default function PreviewModal({ entry, data, onClose }: Props) {
  const structured = useMemo(() => {
    if (data.kind !== "text") return null;
    const p = entry.name.toLowerCase();
    if (p.endsWith(".json")) return parseJsonTree(data.content);
    if (p.endsWith(".yml") || p.endsWith(".yaml")) return parseYamlTree(data.content);
    return null;
  }, [entry.name, data]);

  // Structure par défaut quand elle est disponible : c'est plus lisible.
  const [asTree, setAsTree] = useState(
    structured !== null && typeof structured !== "string",
  );

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal preview-modal" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">Aperçu</p>
        <h2 className="modal-title">{entry.name}</h2>
        <p className="preview-meta">
          {formatSize(data.size)}
          {data.truncated && " — début du fichier seulement"}
        </p>

        {structured !== null && (
          <div className="settings-tabs" role="tablist">
            <button
              className={asTree ? "active" : ""}
              onClick={() => setAsTree(true)}
              disabled={typeof structured === "string"}
            >
              <Braces size={13} /> Structure
            </button>
            <button className={!asTree ? "active" : ""} onClick={() => setAsTree(false)}>
              <FileText size={13} /> Texte
            </button>
          </div>
        )}
        {typeof structured === "string" && <p className="sv-note">{structured}</p>}

        {data.kind === "image" ? (
          <div className="preview-image">
            <img src={`data:image/*;base64,${data.content}`} alt={entry.name} />
          </div>
        ) : data.kind === "binary" ? (
          <p className="hostkey-text">
            Fichier binaire — aucun aperçu texte possible. Utilisez « Télécharger » ou «
            Éditer ».
          </p>
        ) : asTree && structured !== null && typeof structured !== "string" ? (
          <div className="preview-text tv-wrap">
            <TreeView node={structured} />
          </div>
        ) : (
          <pre className="preview-text">{data.content}</pre>
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
