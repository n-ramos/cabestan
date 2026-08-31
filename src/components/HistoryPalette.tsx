import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft, History } from "lucide-react";

interface Props {
  commands: string[];
  loading: boolean;
  onPick: (cmd: string) => void;
  onClose: () => void;
}

export default function HistoryPalette({ commands, loading, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands.slice(0, 60);
    // Correspondance par sous-séquence : « dkps » trouve « docker ps ».
    return commands
      .filter((c) => {
        const t = c.toLowerCase();
        if (t.includes(q)) return true;
        let i = 0;
        for (const ch of q) {
          i = t.indexOf(ch, i);
          if (i === -1) return false;
          i++;
        }
        return true;
      })
      .slice(0, 60);
  }, [commands, query]);

  useEffect(() => setIndex(0), [query]);
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-i="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          value={query}
          placeholder={loading ? "Lecture de l'historique…" : "Historique du serveur…"}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setIndex((i) => Math.min(shown.length - 1, i + 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (shown[index]) {
                onClose();
                onPick(shown[index]);
              }
            } else if (e.key === "Escape") {
              onClose();
            }
          }}
        />
        <div className="palette-list" ref={listRef}>
          {shown.length === 0 ? (
            <p className="palette-empty">
              {loading ? "Lecture en cours…" : "Aucune commande trouvée."}
            </p>
          ) : (
            shown.map((c, i) => (
              <button
                key={`${c}-${i}`}
                data-i={i}
                className={`palette-item ${i === index ? "on" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  onClose();
                  onPick(c);
                }}
              >
                <History size={12} className="palette-group" />
                <span className="palette-hint mono">{c}</span>
                {i === index && <CornerDownLeft size={12} className="palette-enter" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
