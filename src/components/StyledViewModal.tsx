import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ClipboardCopy,
  Play,
  RotateCw,
  Search,
  Sparkles,
  Square,
  Table2,
} from "lucide-react";
import { remoteRun, remoteServiceAction } from "../api";
import {
  allRecipes,
  Recipe,
  Table,
  filterRows,
  findRecipe,
  parseAligned,
  parseTabs,
  sortRows,
  toTsv,
} from "../tabulate";

interface Props {
  sessionId: string;
  sessionLabel: string;
  /** Commande pré-remplie (depuis la palette ou le terminal). */
  initialCommand?: string;
  /** Sortie déjà capturée dans le terminal : évite de relancer la commande. */
  initialOutput?: string;
  onNotify: (kind: "ok" | "err", text: string) => void;
  onClose: () => void;
}

export default function StyledViewModal({
  sessionId,
  sessionLabel,
  initialCommand = "",
  initialOutput,
  onNotify,
  onClose,
}: Props) {
  const [input, setInput] = useState(initialCommand);
  const [table, setTable] = useState<Table | null>(null);
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [sortCol, setSortCol] = useState<number | null>(null);
  const [sortAsc, setSortAsc] = useState(true);
  const [showRaw, setShowRaw] = useState(false);
  const [fromCapture, setFromCapture] = useState(false);

  /** Met en forme une sortie déjà obtenue, sans rien exécuter. */
  const useOutput = useCallback((command: string, output: string) => {
    const found = findRecipe(command);
    setRecipe(found);
    setRaw(output);
    // La sortie vient du terminal : ses colonnes sont alignées, pas tabulées.
    setTable(parseAligned(output));
    setSortCol(null);
    setFromCapture(true);
    setError(null);
  }, []);

  const run = useCallback(
    async (command: string) => {
      const cmd = command.trim();
      if (!cmd) return;
      setBusy(true);
      setError(null);
      setTable(null);
      setFromCapture(false);
      const found = findRecipe(cmd);
      setRecipe(found);
      try {
        // Pour une commande reconnue, on exécute une variante qui sort en
        // colonnes tabulées : bien plus fiable à découper.
        const output = await remoteRun(sessionId, found ? found.command : cmd, 45);
        setRaw(output);
        setTable(found ? parseTabs(output, found.headers) : parseAligned(output));
        setSortCol(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [sessionId],
  );

  // À l'ouverture : on réutilise la sortie capturée si on en a une,
  // sinon on exécute la commande fournie.
  useEffect(() => {
    if (initialOutput && initialCommand.trim()) {
      useOutput(initialCommand, initialOutput);
    } else if (initialCommand.trim()) {
      run(initialCommand);
    }
  }, [initialCommand, initialOutput, run, useOutput]);

  const shown = useMemo(() => {
    if (!table) return null;
    let rows = filterRows(table.rows, filter);
    if (sortCol !== null) {
      rows = sortRows(rows, sortCol, sortAsc, !!recipe?.numeric?.includes(sortCol));
    }
    return { headers: table.headers, rows };
  }, [table, filter, sortCol, sortAsc, recipe]);

  const act = async (name: string, action: "start" | "stop" | "restart") => {
    if (!recipe?.actions) return;
    try {
      const out = await remoteServiceAction(sessionId, recipe.actions, name, action);
      onNotify("ok", `${action} ${name} : ${out.trim().slice(0, 100) || "ok"}`);
      run(input);
    } catch (e) {
      onNotify("err", String(e));
    }
  };

  const copy = () => {
    if (!shown) return;
    navigator.clipboard
      ?.writeText(toTsv(shown))
      .then(() => onNotify("ok", "Tableau copié (collable dans un tableur)."))
      .catch(() => onNotify("err", "Copie impossible."));
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal styled-view" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">Vue structurée</p>
        <h2 className="modal-title">
          <Sparkles size={16} /> {sessionLabel}
        </h2>

        <div className="sv-bar">
          <input
            className="mono sv-input"
            value={input}
            placeholder="docker ps, df -h, systemctl, ou n'importe quelle commande…"
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") run(input);
            }}
            autoFocus
          />
          <button className="btn primary" onClick={() => run(input)} disabled={busy}>
            <Play size={13} /> {busy ? "…" : "Afficher"}
          </button>
        </div>

        <div className="sv-chips">
          {allRecipes().map((r) => (
            <button
              key={r.id}
              className={`bm-chip ${recipe?.id === r.id ? "on" : ""}`}
              onClick={() => {
                setInput(r.example);
                run(r.example);
              }}
            >
              {r.label}
            </button>
          ))}
        </div>

        {error && <div className="modal-error">{error}</div>}

        {fromCapture && !error && (
          <p className="sv-note">
            Sortie reprise du terminal — la commande n'a pas été relancée. « Relancer »
            exécutera la version optimisée pour la lisibilité.
          </p>
        )}
        {!fromCapture && recipe && !error && (
          <p className="sv-note">
            Commande reconnue — sortie remise en colonnes. La commande réellement exécutée
            est adaptée pour être lisible.
          </p>
        )}
        {!fromCapture && !recipe && table && !error && (
          <p className="sv-note">
            Commande inconnue — colonnes devinées d'après l'alignement.
          </p>
        )}

        {shown && shown.rows.length > 0 && (
          <>
            <div className="sv-tools">
              <div className="filter-wrap">
                <Search size={12} />
                <input
                  className="filter-input"
                  value={filter}
                  placeholder="Filtrer…"
                  onChange={(e) => setFilter(e.target.value)}
                />
              </div>
              <span className="sv-count">
                {shown.rows.length} ligne{shown.rows.length > 1 ? "s" : ""}
                {filter.trim() && table && ` sur ${table.rows.length}`}
              </span>
              <span className="status-spacer" />
              <button className="btn icon" title="Relancer" onClick={() => run(input)}>
                <RotateCw size={14} />
              </button>
              <button className="btn icon" title="Copier le tableau" onClick={copy}>
                <ClipboardCopy size={14} />
              </button>
              <button
                className={`btn icon ${showRaw ? "starred" : ""}`}
                title="Voir la sortie brute"
                onClick={() => setShowRaw((v) => !v)}
              >
                <Table2 size={14} />
              </button>
            </div>

            {showRaw ? (
              <pre className="preview-text">{raw}</pre>
            ) : (
              <div className="sv-table-wrap">
                <table className="sv-table">
                  <thead>
                    <tr>
                      {shown.headers.map((h, i) => (
                        <th key={i}>
                          <button
                            className={`col-sort ${sortCol === i ? "on" : ""}`}
                            onClick={() => {
                              if (sortCol === i) setSortAsc((v) => !v);
                              else {
                                setSortCol(i);
                                setSortAsc(true);
                              }
                            }}
                          >
                            {h}
                            {sortCol === i && (
                              <span className="sort-arrow">{sortAsc ? "▲" : "▼"}</span>
                            )}
                          </button>
                        </th>
                      ))}
                      {recipe?.actions && !fromCapture && (
                        <th className="sv-actions-head" />
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {shown.rows.map((r, ri) => (
                      <tr key={ri}>
                        {r.map((c, ci) => (
                          <td key={ci} title={c}>
                            {ci === 1 && recipe?.actions && !fromCapture ? (
                              <span
                                className={`svc-state ${
                                  /running|active/i.test(c) ? "up" : "down"
                                }`}
                              >
                                {c || "—"}
                              </span>
                            ) : (
                              c || "—"
                            )}
                          </td>
                        ))}
                        {recipe?.actions && !fromCapture && (
                          <td className="sv-row-actions">
                            <button
                              className="sc-mini"
                              title="Démarrer"
                              onClick={() => act(r[0], "start")}
                            >
                              <Play size={11} />
                            </button>
                            <button
                              className="sc-mini"
                              title="Redémarrer"
                              onClick={() => act(r[0], "restart")}
                            >
                              <RotateCw size={11} />
                            </button>
                            <button
                              className="sc-mini"
                              title="Arrêter"
                              onClick={() => act(r[0], "stop")}
                            >
                              <Square size={11} />
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {shown && shown.rows.length === 0 && !busy && !error && (
          <p className="saved-empty">Aucune ligne à afficher.</p>
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
