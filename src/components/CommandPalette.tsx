import { useEffect, useMemo, useRef, useState } from "react";
import { CornerDownLeft } from "lucide-react";

export interface PaletteItem {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
}

interface Props {
  items: PaletteItem[];
  onClose: () => void;
}

export default function CommandPalette({ items, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items.slice(0, 40);
    // Correspondance simple par sous-séquence : "prdep" trouve "prod deploy".
    const score = (text: string) => {
      const t = text.toLowerCase();
      if (t.includes(q)) return 0;
      let i = 0;
      for (const ch of q) {
        i = t.indexOf(ch, i);
        if (i === -1) return null;
        i++;
      }
      return 1;
    };
    return items
      .map((it) => ({ it, s: score(`${it.label} ${it.hint ?? ""} ${it.group}`) }))
      .filter((x): x is { it: PaletteItem; s: number } => x.s !== null)
      .sort((a, b) => a.s - b.s)
      .slice(0, 40)
      .map((x) => x.it);
  }, [items, query]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-i="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[index];
      if (item) {
        onClose();
        item.run();
      }
    } else if (e.key === "Escape") {
      onClose();
    }
  };

  return (
    <div className="modal-backdrop palette-backdrop" onMouseDown={onClose}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Serveur, dossier, commande…"
          autoFocus
        />
        <div className="palette-list" ref={listRef}>
          {filtered.length === 0 ? (
            <p className="palette-empty">Aucune correspondance</p>
          ) : (
            filtered.map((item, i) => (
              <button
                key={item.id}
                data-i={i}
                className={`palette-item ${i === index ? "on" : ""}`}
                onMouseEnter={() => setIndex(i)}
                onClick={() => {
                  onClose();
                  item.run();
                }}
              >
                <span className="palette-group">{item.group}</span>
                <span className="palette-label">{item.label}</span>
                {item.hint && <span className="palette-hint">{item.hint}</span>}
                {i === index && <CornerDownLeft size={12} className="palette-enter" />}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
