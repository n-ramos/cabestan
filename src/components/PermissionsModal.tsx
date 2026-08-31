import { Fragment, useState } from "react";
import { FileEntry, formatPermissions } from "../api";

interface Props {
  entry: FileEntry;
  onApply: (mode: number) => void;
  onClose: () => void;
}

const ROWS: Array<{ label: string; bits: [number, number, number] }> = [
  { label: "Propriétaire", bits: [0o400, 0o200, 0o100] },
  { label: "Groupe", bits: [0o040, 0o020, 0o010] },
  { label: "Autres", bits: [0o004, 0o002, 0o001] },
];

export default function PermissionsModal({ entry, onApply, onClose }: Props) {
  const [mode, setMode] = useState(
    (entry.permissions ?? (entry.isDir ? 0o755 : 0o644)) & 0o7777,
  );
  const [octal, setOctal] = useState(
    ((entry.permissions ?? (entry.isDir ? 0o755 : 0o644)) & 0o7777)
      .toString(8)
      .padStart(3, "0"),
  );

  const setModeBoth = (m: number) => {
    setMode(m);
    setOctal(m.toString(8).padStart(3, "0"));
  };

  const toggle = (bit: number) => setModeBoth(mode ^ bit);

  const onOctalChange = (value: string) => {
    setOctal(value);
    if (/^[0-7]{3,4}$/.test(value)) {
      setMode(parseInt(value, 8) & 0o7777);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal perm-modal" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">Droits</p>
        <h2 className="modal-title mono-title">{entry.name}</h2>

        <div className="perm-grid">
          <span />
          <span className="perm-head">lecture</span>
          <span className="perm-head">écriture</span>
          <span className="perm-head">exécution</span>
          {ROWS.map((row) => (
            <Fragment key={row.label}>
              <span className="perm-row-label">{row.label}</span>
              {row.bits.map((bit) => (
                <label key={bit} className="perm-cell">
                  <input
                    type="checkbox"
                    checked={(mode & bit) !== 0}
                    onChange={() => toggle(bit)}
                  />
                </label>
              ))}
            </Fragment>
          ))}
        </div>

        <div className="perm-summary">
          <label className="field octal">
            <span>Octal</span>
            <input
              className="mono"
              value={octal}
              onChange={(e) => onOctalChange(e.target.value)}
              maxLength={4}
            />
          </label>
          <code className="perm-rwx">{formatPermissions(mode, entry.isDir)}</code>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Annuler
          </button>
          <button className="btn primary" onClick={() => onApply(mode)}>
            Appliquer
          </button>
        </div>
      </div>
    </div>
  );
}
