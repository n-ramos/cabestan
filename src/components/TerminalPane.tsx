import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  ArrowDown,
  ArrowUp,
  CircleDot,
  Maximize2,
  Sparkles,
  SplitSquareHorizontal,
  SplitSquareVertical,
  Trash2,
  X,
} from "lucide-react";
import { themeById } from "../themes";
import { cleanCaptured, findRecipe, looksTabular } from "../tabulate";
import { listen } from "@tauri-apps/api/event";
import {
  TermTarget,
  logStart,
  logStop,
  logWrite,
  termEvents,
  termOpen,
  termResize,
  termWrite,
} from "../api";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import "@xterm/xterm/css/xterm.css";

interface Props {
  target: TermTarget;
  visible: boolean;
  focused: boolean;
  fontSize: number;
  fontFamily: string;
  cursorBlink: boolean;
  scrollback: number;
  theme: string;
  /** false quand l'explorateur a la main sur ⌘F. */
  searchEnabled?: boolean;
  /** Diffusion : la saisie part aussi vers les autres panneaux de l'onglet. */
  broadcast?: boolean;
  onShellPid?: (pid: number) => void;
  onClosed?: () => void;
  onFocus?: () => void;
  /** Actions du menu contextuel du panneau. */
  onSplit?: (dir: "row" | "col") => void;
  onZoom?: () => void;
  onClosePane?: () => void;
  /** Ouvre la vue structurée, éventuellement avec la sortie déjà capturée. */
  onStyledView?: (cmd: string, captured?: string) => void;
}

export default function TerminalPane({
  target,
  visible,
  focused,
  fontSize,
  fontFamily,
  cursorBlink,
  scrollback,
  theme,
  searchEnabled = true,
  broadcast = false,
  onShellPid,
  onClosed,
  onFocus,
  onSplit,
  onZoom,
  onClosePane,
  onStyledView,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const onShellPidRef = useRef(onShellPid);
  onShellPidRef.current = onShellPid;
  const onClosedRef = useRef(onClosed);
  onClosedRef.current = onClosed;
  const targetRef = useRef(target);
  targetRef.current = target;
  const broadcastRef = useRef(broadcast);
  broadcastRef.current = broadcast;
  const searchRef = useRef<SearchAddon | null>(null);
  const [searchOn, setSearchOn] = useState(false);
  const [needle, setNeedle] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Proposition d'affichage en tableau, après une commande reconnue.
  const [offer, setOffer] = useState<{ cmd: string; text: string; lines: number } | null>(
    null,
  );
  // Ligne en cours de frappe : sert uniquement à identifier la commande, et
  // elle est jetée dès la validation si elle ne correspond à aucune recette.
  const typedRef = useRef("");
  const captureRef = useRef<{ cmd: string; buf: string; timer?: number } | null>(null);
  const [logging, setLogging] = useState<string | null>(null);
  // Clé d'enregistrement, lue par le flux de données sans le recréer.
  const logKeyRef = useRef<string | null>(null);

  // Échap ferme le menu du panneau.
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [menu]);

  const targetKey =
    target.kind === "ssh" ? `${target.sessionId}/${target.shellId}` : target.termId;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const t = targetRef.current;

    const term = new Terminal({
      fontFamily: `"${fontFamily}", "JetBrains Mono", Menlo, monospace`,
      fontSize,
      lineHeight: 1.25,
      cursorBlink,
      scrollback,
      macOptionIsMeta: true,
      theme: themeById(theme).colors,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.loadAddon(new WebLinksAddon());
    searchRef.current = search;
    // Marqueur invisible émis par le wrapper de shell : PID du shell distant.
    term.parser.registerOscHandler(777, (data) => {
      const m = data.match(/^cabestan-pid=(\d+)$/);
      if (m) {
        onShellPidRef.current?.(Number(m[1]));
        return true;
      }
      return false;
    });
    term.open(el);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    let disposed = false;
    const unlisteners: Array<() => void> = [];
    const events = termEvents(t);

    (async () => {
      const unData = await listen<string>(events.data, (e) => {
        const bytes = Uint8Array.from(atob(e.payload), (c) => c.charCodeAt(0));
        term.write(bytes);
        const decoded = new TextDecoder().decode(bytes);
        const key = logKeyRef.current;
        if (key) {
          logWrite(key, decoded).catch(() => {});
        }

        // Capture en cours : on accumule, et on conclut après un silence.
        const cap = captureRef.current;
        if (cap) {
          cap.buf += decoded;
          if (cap.timer) window.clearTimeout(cap.timer);
          cap.timer = window.setTimeout(() => {
            const cleaned = cleanCaptured(cap.buf, cap.cmd);
            captureRef.current = null;
            const lines = cleaned.split("\n").filter((l) => l.trim() !== "").length;
            if (lines >= 1 && looksTabular(cleaned)) {
              setOffer({ cmd: cap.cmd, text: cleaned, lines });
            }
          }, 600);
        }
      });
      const unClosed = await listen(events.closed, () => {
        onClosedRef.current?.();
      });
      unlisteners.push(unData, unClosed);
      if (disposed) {
        unlisteners.forEach((u) => u());
        return;
      }
      try {
        await termOpen(t, term.cols, term.rows);
      } catch (err) {
        term.write(`\r\n\x1b[31m${String(err)}\x1b[0m\r\n`);
      }
    })();

    const dataSub = term.onData((data) => {
      termWrite(targetRef.current, data).catch(() => {});

      // Reconstitution de la ligne tapée, pour reconnaître la commande.
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") {
          const cmd = typedRef.current.trim();
          typedRef.current = "";
          // On ne capture que pour les commandes que l'on sait mettre en forme :
          // tout autre contenu (mot de passe compris) est aussitôt oublié.
          if (findRecipe(cmd)) {
            captureRef.current = { cmd, buf: "" };
            setOffer(null);
          } else {
            captureRef.current = null;
          }
        } else if (ch === "\u007f" || ch === "\b") {
          typedRef.current = typedRef.current.slice(0, -1);
        } else if (ch === "\u0003" || ch === "\u0015") {
          typedRef.current = "";
          captureRef.current = null;
        } else if (ch >= " ") {
          typedRef.current += ch;
        }
      }
      // Diffusion : les autres panneaux reçoivent la même frappe.
      if (broadcastRef.current) {
        window.dispatchEvent(
          new CustomEvent("cabestan-broadcast", {
            detail: { from: targetRef.current, data },
          }),
        );
      }
    });

    // Réception d'une frappe diffusée par un autre panneau.
    const onBroadcast = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as {
        from: TermTarget;
        data: string;
      };
      const me = targetRef.current;
      const same =
        me.kind === "ssh" && detail.from.kind === "ssh"
          ? me.sessionId === detail.from.sessionId && me.shellId === detail.from.shellId
          : me.kind === "local" && detail.from.kind === "local"
            ? me.termId === detail.from.termId
            : false;
      if (!same) termWrite(me, detail.data).catch(() => {});
    };
    window.addEventListener("cabestan-broadcast", onBroadcast);
    unlisteners.push(() => window.removeEventListener("cabestan-broadcast", onBroadcast));

    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const observer = new ResizeObserver(() => {
      if (!el.offsetParent) return; // hidden
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fit.fit();
        termResize(targetRef.current, term.cols, term.rows).catch(() => {});
      }, 60);
    });
    observer.observe(el);

    term.focus();

    return () => {
      disposed = true;
      observer.disconnect();
      dataSub.dispose();
      unlisteners.forEach((u) => u());
      if (captureRef.current?.timer) window.clearTimeout(captureRef.current.timer);
      captureRef.current = null;
      if (logKeyRef.current) {
        logStop(logKeyRef.current).catch(() => {});
        logKeyRef.current = null;
      }
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);

  // Réglages appliqués à chaud sans recréer le terminal.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = fontSize;
    term.options.fontFamily = `"${fontFamily}", "JetBrains Mono", Menlo, monospace`;
    term.options.cursorBlink = cursorBlink;
    term.options.scrollback = scrollback;
    term.options.theme = themeById(theme).colors;
    requestAnimationFrame(() => {
      fitRef.current?.fit();
      if (termRef.current) {
        termResize(targetRef.current, termRef.current.cols, termRef.current.rows).catch(
          () => {},
        );
      }
    });
  }, [fontSize, fontFamily, cursorBlink, scrollback, theme]);

  // ⌘F : recherche dans le terminal du panneau actif.
  useEffect(() => {
    if (!visible || !focused || !searchEnabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && !e.ctrlKey && !e.altKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        e.stopPropagation();
        setSearchOn(true);
        requestAnimationFrame(() => searchInputRef.current?.select());
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [visible, focused, searchEnabled]);

  const find = (dir: "next" | "prev") => {
    const s = searchRef.current;
    if (!s || !needle) return;
    const opts = { decorations: undefined };
    if (dir === "next") s.findNext(needle, opts);
    else s.findPrevious(needle, opts);
  };

  const toggleLogging = async () => {
    if (logKeyRef.current) {
      await logStop(logKeyRef.current).catch(() => {});
      logKeyRef.current = null;
      setLogging(null);
      return;
    }
    const t = targetRef.current;
    const label = t.kind === "ssh" ? t.sessionId : "local";
    const dest = await saveDialog({
      title: "Enregistrer la session dans…",
      defaultPath: `cabestan-${label}-${new Date().toISOString().slice(0, 10)}.log`,
    });
    if (!dest) return;
    const key = t.kind === "ssh" ? `${t.sessionId}|${t.shellId}` : `local|${t.termId}`;
    try {
      await logStart(key, dest);
      logKeyRef.current = key;
      setLogging(dest);
    } catch (e) {
      termRef.current?.write(`\r\n\x1b[31m${String(e)}\x1b[0m\r\n`);
    }
  };

  const closeSearch = () => {
    setSearchOn(false);
    searchRef.current?.clearDecorations?.();
    termRef.current?.focus();
  };

  // Refit + focus quand le panneau redevient visible ou prend le focus.
  useEffect(() => {
    if (visible && fitRef.current && termRef.current) {
      requestAnimationFrame(() => {
        fitRef.current!.fit();
        termResize(targetRef.current, termRef.current!.cols, termRef.current!.rows).catch(
          () => {},
        );
        if (focused) termRef.current!.focus();
      });
    }
  }, [visible, focused]);

  return (
    <div
      className={`terminal-pane-wrap ${focused ? "focused" : ""}`}
      onMouseDownCapture={() => onFocus?.()}
      onContextMenu={(e) => {
        // Le menu n'a d'intérêt que s'il y a des actions à proposer.
        if (!onSplit && !onZoom && !onClosePane) return;
        e.preventDefault();
        onFocus?.();
        setMenu({
          x: Math.min(e.clientX, window.innerWidth - 230),
          y: Math.min(e.clientY, window.innerHeight - 200),
        });
      }}
    >
      {searchOn && (
        <div className="term-search">
          <input
            ref={searchInputRef}
            value={needle}
            placeholder="Rechercher…"
            onChange={(e) => {
              setNeedle(e.target.value);
              requestAnimationFrame(() => {
                if (e.target.value) searchRef.current?.findNext(e.target.value);
              });
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") find(e.shiftKey ? "prev" : "next");
              if (e.key === "Escape") closeSearch();
            }}
          />
          <button title="Précédent (⇧↩)" onClick={() => find("prev")}>
            <ArrowUp size={12} />
          </button>
          <button title="Suivant (↩)" onClick={() => find("next")}>
            <ArrowDown size={12} />
          </button>
          <button title="Fermer (Échap)" onClick={closeSearch}>
            <X size={12} />
          </button>
        </div>
      )}
      {offer && onStyledView && (
        <div className="offer-bar">
          <Sparkles size={12} />
          <span className="offer-text">
            <code>{offer.cmd}</code> — {offer.lines} ligne
            {offer.lines > 1 ? "s" : ""}
          </span>
          <button
            className="offer-go"
            onClick={() => {
              onStyledView(offer.cmd, offer.text);
              setOffer(null);
            }}
          >
            Afficher en tableau
          </button>
          <button className="offer-close" title="Masquer" onClick={() => setOffer(null)}>
            <X size={11} />
          </button>
        </div>
      )}

      {logging && (
        <span className="log-badge" title={`Enregistrement vers ${logging}`}>
          <CircleDot size={10} /> REC
        </span>
      )}

      {onClosePane && !searchOn && (
        <button
          className="pane-close"
          title="Fermer le panneau (⌘⇧W)"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onClosePane();
          }}
        >
          <X size={12} />
        </button>
      )}

      <div className="terminal-pane" ref={containerRef} />

      {menu && (
        <>
          <div className="ctx-backdrop" onMouseDown={() => setMenu(null)} />
          <div
            className="ctx-menu"
            style={{ left: menu.x, top: menu.y }}
            onContextMenu={(e) => e.preventDefault()}
          >
            {onSplit && (
              <>
                <button
                  className="ctx-item"
                  onClick={() => {
                    setMenu(null);
                    onSplit("row");
                  }}
                >
                  <SplitSquareHorizontal size={14} /> Scinder à droite
                  <span className="ctx-accel">⌘D</span>
                </button>
                <button
                  className="ctx-item"
                  onClick={() => {
                    setMenu(null);
                    onSplit("col");
                  }}
                >
                  <SplitSquareVertical size={14} /> Scinder en dessous
                  <span className="ctx-accel">⌘⇧D</span>
                </button>
              </>
            )}
            {onZoom && (
              <button
                className="ctx-item"
                onClick={() => {
                  setMenu(null);
                  onZoom();
                }}
              >
                <Maximize2 size={14} /> Agrandir / réduire
                <span className="ctx-accel">⌘⇧Z</span>
              </button>
            )}
            <div className="ctx-sep" />
            <button
              className="ctx-item"
              onClick={() => {
                setMenu(null);
                searchRef.current && setSearchOn(true);
              }}
            >
              <ArrowDown size={14} /> Rechercher…
              <span className="ctx-accel">⌘F</span>
            </button>
            {onStyledView && (
              <button
                className="ctx-item"
                onClick={() => {
                  setMenu(null);
                  // La sélection courante sert de commande si elle existe.
                  const sel = termRef.current?.getSelection()?.trim() ?? "";
                  // La dernière capture évite de relancer la commande.
                  if (!sel && offer) onStyledView(offer.cmd, offer.text);
                  else onStyledView(sel);
                }}
              >
                <Sparkles size={14} /> Vue structurée…
                <span className="ctx-accel">⌘⇧K</span>
              </button>
            )}
            <button
              className="ctx-item"
              onClick={() => {
                setMenu(null);
                toggleLogging();
              }}
            >
              <CircleDot size={14} />{" "}
              {logging ? "Arrêter l'enregistrement" : "Enregistrer la session…"}
            </button>
            {onClosePane && (
              <>
                <div className="ctx-sep" />
                <button
                  className="ctx-item danger"
                  onClick={() => {
                    setMenu(null);
                    onClosePane();
                  }}
                >
                  <Trash2 size={14} /> Fermer le panneau
                  <span className="ctx-accel">⌘⇧W</span>
                </button>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
