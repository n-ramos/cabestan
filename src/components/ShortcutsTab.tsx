import { useEffect, useState } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import {
  FIXED_SHORTCUTS,
  SHORTCUT_GROUPS,
  ShortcutAction,
  accelFromEvent,
  conflictsOf,
  prettyAccel,
  shortcutActions,
} from "../shortcuts";

interface Props {
  overrides: Record<string, string>;
  onChange: (overrides: Record<string, string>) => void;
}

export default function ShortcutsTab({ overrides, onChange }: Props) {
  const [actions, setActions] = useState<ShortcutAction[]>([]);
  const [recording, setRecording] = useState<string | null>(null);
  const [hint, setHint] = useState<string | null>(null);

  useEffect(() => {
    shortcutActions()
      .then(setActions)
      .catch(() => {});
  }, []);

  // Capture de la combinaison pendant l'enregistrement.
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecording(null);
        setHint(null);
        return;
      }
      const accel = accelFromEvent(e);
      if (!accel) {
        setHint("Ajoutez un modificateur (⌘, ⌃, ⌥ ou ⇧) à la touche.");
        return;
      }
      const action = actions.find((a) => a.id === recording);
      const next = { ...overrides };
      if (action && accel === action.defaultAccel) delete next[recording];
      else next[recording] = accel;
      onChange(next);
      setRecording(null);
      setHint(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording, actions, overrides, onChange]);

  const conflicts = conflictsOf(actions, overrides);
  const byId = new Map(actions.map((a) => [a.id, a]));
  const custom = Object.keys(overrides).length > 0;

  const accelOf = (a: ShortcutAction) => overrides[a.id] ?? a.defaultAccel;

  const clear = (id: string) => onChange({ ...overrides, [id]: "" });
  const reset = (id: string) => {
    const next = { ...overrides };
    delete next[id];
    onChange(next);
  };

  return (
    <>
      <p className="sc-intro">
        Cliquez sur un raccourci puis tapez la nouvelle combinaison. <kbd>Échap</kbd>{" "}
        annule.
      </p>

      {SHORTCUT_GROUPS.map((group) => (
        <div key={group.title}>
          <p className="settings-group">{group.title}</p>
          {group.ids.map((id) => {
            const action = byId.get(id);
            if (!action) return null;
            const accel = accelOf(action);
            const isDefault = !(id in overrides);
            return (
              <div key={id} className="sc-row">
                <span className="sc-label">
                  {action.label}
                  {conflicts.has(id) && (
                    <span className="sc-conflict" title="Raccourci en double">
                      <TriangleAlert size={12} /> doublon
                    </span>
                  )}
                </span>
                <button
                  className={`sc-key ${recording === id ? "recording" : ""} ${
                    conflicts.has(id) ? "conflict" : ""
                  }`}
                  onClick={() => {
                    setHint(null);
                    setRecording(recording === id ? null : id);
                  }}
                >
                  {recording === id ? "Tapez…" : prettyAccel(accel)}
                </button>
                <span className="sc-actions">
                  {!isDefault && (
                    <button
                      className="sc-mini"
                      title="Revenir au raccourci par défaut"
                      onClick={() => reset(id)}
                    >
                      <RotateCcw size={12} />
                    </button>
                  )}
                  {accel !== "" && (
                    <button
                      className="sc-mini"
                      title="Retirer le raccourci"
                      onClick={() => clear(id)}
                    >
                      ×
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </div>
      ))}

      {hint && <p className="sc-hint">{hint}</p>}

      <p className="settings-group">Non modifiables</p>
      {FIXED_SHORTCUTS.map((f) => (
        <div key={f.label} className="sc-row fixed">
          <span className="sc-label">{f.label}</span>
          <span className="sc-key static">
            {f.parts.map(prettyAccel).join(f.sep ?? " ")}
          </span>
        </div>
      ))}

      {custom && (
        <div className="modal-actions">
          <button className="btn" onClick={() => onChange({})}>
            <RotateCcw size={13} /> Tout réinitialiser
          </button>
        </div>
      )}
    </>
  );
}
