import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Pause, Play, Search, ScrollText, Trash2 } from "lucide-react";
import { followStart, followStop } from "../api";
import { Level, LogLine, appendChunk, countLevels, filterLog } from "../logview";

interface Props {
  sessionId: string;
  path: string;
  onNotify: (kind: "ok" | "err", text: string) => void;
  onClose: () => void;
}

const LEVELS: Array<{ id: Level; label: string }> = [
  { id: "error", label: "erreurs" },
  { id: "warn", label: "alertes" },
  { id: "info", label: "infos" },
  { id: "debug", label: "debug" },
];

const MAX_LINES = 5000;

export default function LogViewModal({ sessionId, path, onNotify, onClose }: Props) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [levels, setLevels] = useState<Set<Level>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState(0);

  const keyRef = useRef(`follow-${crypto.randomUUID()}`);
  const partialRef = useRef("");
  const nextNRef = useRef(1);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const bufferRef = useRef<string>("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const stampsRef = useRef<number[]>([]);

  // Abonnement puis démarrage du suivi.
  useEffect(() => {
    const key = keyRef.current;
    let un: (() => void) | undefined;
    let unEnd: (() => void) | undefined;
    let disposed = false;

    (async () => {
      un = await listen<string>(`follow-${key}`, (e) => {
        // En pause, on accumule sans afficher : rien n'est perdu.
        if (pausedRef.current) {
          bufferRef.current += e.payload;
          return;
        }
        const r = appendChunk(
          [],
          partialRef.current + e.payload,
          nextNRef.current,
          MAX_LINES,
        );
        partialRef.current = r.partial;
        nextNRef.current = r.nextN;
        stampsRef.current.push(...r.lines.map(() => Date.now()));
        setLines((prev) => {
          const all = [...prev, ...r.lines];
          return all.length > MAX_LINES ? all.slice(all.length - MAX_LINES) : all;
        });
      });
      unEnd = await listen(`follow-end-${key}`, () =>
        setError("Le suivi s'est arrêté (fichier absent ou session fermée)."),
      );
      if (disposed) return;
      try {
        await followStart(sessionId, key, path, 200);
      } catch (e) {
        setError(String(e));
      }
    })();

    return () => {
      disposed = true;
      un?.();
      unEnd?.();
      followStop(key).catch(() => {});
    };
  }, [sessionId, path]);

  // Reprise : on déverse ce qui a été mis de côté.
  useEffect(() => {
    if (paused || bufferRef.current === "") return;
    const chunk = bufferRef.current;
    bufferRef.current = "";
    const r = appendChunk([], partialRef.current + chunk, nextNRef.current, MAX_LINES);
    partialRef.current = r.partial;
    nextNRef.current = r.nextN;
    setLines((prev) => {
      const all = [...prev, ...r.lines];
      return all.length > MAX_LINES ? all.slice(all.length - MAX_LINES) : all;
    });
  }, [paused]);

  // Cadence : lignes reçues sur la dernière minute.
  useEffect(() => {
    const t = setInterval(() => {
      const cutoff = Date.now() - 60000;
      stampsRef.current = stampsRef.current.filter((s) => s > cutoff);
      setRate(stampsRef.current.length);
    }, 2000);
    return () => clearInterval(t);
  }, []);

  const shown = filterLog(lines, filter, levels);
  const counts = countLevels(lines);

  // Défilement automatique tant qu'on n'est pas en pause.
  useEffect(() => {
    if (!paused) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [shown.length, paused]);

  const toggleLevel = (l: Level) =>
    setLevels((prev) => {
      const next = new Set(prev);
      if (next.has(l)) next.delete(l);
      else next.add(l);
      return next;
    });

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal logview-modal" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">Suivi de journal</p>
        <h2 className="modal-title mono editor-path">
          <ScrollText size={15} /> {path}
        </h2>

        <div className="lv-tools">
          <button className="btn" onClick={() => setPaused((v) => !v)}>
            {paused ? (
              <>
                <Play size={13} /> Reprendre
              </>
            ) : (
              <>
                <Pause size={13} /> Pause
              </>
            )}
          </button>
          <div className="filter-wrap">
            <Search size={12} />
            <input
              className="filter-input"
              value={filter}
              placeholder="Filtrer…"
              onChange={(e) => setFilter(e.target.value)}
            />
          </div>
          {LEVELS.map((l) => (
            <button
              key={l.id}
              className={`lv-chip ${l.id} ${levels.has(l.id) ? "on" : ""}`}
              onClick={() => toggleLevel(l.id)}
              title={`Ne garder que : ${l.label}`}
            >
              {l.label} {counts[l.id] > 0 && <b>{counts[l.id]}</b>}
            </button>
          ))}
          <span className="status-spacer" />
          <span className="lv-rate">{rate}/min</span>
          <button
            className="btn icon"
            title="Vider l'affichage"
            onClick={() => setLines([])}
          >
            <Trash2 size={14} />
          </button>
        </div>

        {error && <div className="modal-error">{error}</div>}

        <div className="lv-lines">
          {shown.length === 0 ? (
            <p className="saved-empty">
              {lines.length === 0
                ? "En attente de lignes…"
                : "Aucune ligne ne correspond."}
            </p>
          ) : (
            shown.map((l) => (
              <div key={l.n} className={`lv-line ${l.level}`}>
                <span className="lv-n">{l.n}</span>
                <span className="lv-text">{l.text}</span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>

        <div className="modal-actions">
          <button
            className="btn"
            onClick={() => {
              navigator.clipboard
                ?.writeText(shown.map((l) => l.text).join("\n"))
                .then(() => onNotify("ok", `${shown.length} lignes copiées.`))
                .catch(() => onNotify("err", "Copie impossible."));
            }}
          >
            Copier l'affichage
          </button>
          <button className="btn primary" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
}
