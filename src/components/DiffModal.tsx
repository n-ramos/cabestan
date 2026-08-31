import { useMemo, useState } from "react";
import { GitCompare } from "lucide-react";
import { collapse, diffLines, diffStats } from "../diff";

interface Props {
  /** Chemin du fichier concerné. */
  path: string;
  /** Version en place sur le serveur. */
  beforeLabel: string;
  before: string;
  /** Version qui va l'écraser. */
  afterLabel: string;
  after: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function DiffModal({
  path,
  beforeLabel,
  before,
  afterLabel,
  after,
  confirmLabel,
  onConfirm,
  onCancel,
}: Props) {
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => diffLines(before, after), [before, after]);
  const shown = useMemo(() => (showAll ? rows : collapse(rows, 3)), [rows, showAll]);
  const stats = useMemo(() => diffStats(rows), [rows]);
  const replie = rows.length - shown.length;

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div className="modal diff-modal" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">Avant écrasement</p>
        <h2 className="modal-title">
          <GitCompare size={16} /> Différences
        </h2>
        <p className="hostkey-text">
          <code>{path}</code>
        </p>
        <div className="diff-legend">
          <span className="diff-del-tag">− {stats.removed} retirée(s)</span>
          <span className="diff-add-tag">+ {stats.added} ajoutée(s)</span>
          <span className="diff-side">
            − {beforeLabel} · + {afterLabel}
          </span>
        </div>

        <div className="diff-host">
          {shown.map((r, i) =>
            r.type === "skip" ? (
              <div key={i} className="diff-row diff-skip">
                <span className="diff-num" />
                <span className="diff-num" />
                <span className="diff-sign">⋯</span>
                <span className="diff-text">{r.count} lignes identiques</span>
              </div>
            ) : (
              <div key={i} className={`diff-row diff-${r.type}`}>
                <span className="diff-num">{r.type === "add" ? "" : r.a}</span>
                <span className="diff-num">{r.type === "del" ? "" : r.b}</span>
                <span className="diff-sign">
                  {r.type === "add" ? "+" : r.type === "del" ? "−" : " "}
                </span>
                <span className="diff-text">{r.text || " "}</span>
              </div>
            ),
          )}
        </div>

        {replie > 0 && (
          <button className="diff-more" onClick={() => setShowAll(true)}>
            Afficher les {replie} lignes repliées
          </button>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>
            Annuler
          </button>
          <button className="btn primary" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
