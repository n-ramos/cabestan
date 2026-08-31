import { useEffect, useRef, useState } from "react";
import { EditorView, basicSetup } from "codemirror";
import { EditorState } from "@codemirror/state";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { xml } from "@codemirror/lang-xml";
import { sql } from "@codemirror/lang-sql";
import { php } from "@codemirror/lang-php";
import { rust } from "@codemirror/lang-rust";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { toml } from "@codemirror/legacy-modes/mode/toml";
import { dockerFile } from "@codemirror/legacy-modes/mode/dockerfile";
import { nginx } from "@codemirror/legacy-modes/mode/nginx";
import { properties } from "@codemirror/legacy-modes/mode/properties";
import { lua } from "@codemirror/legacy-modes/mode/lua";
import { ruby } from "@codemirror/legacy-modes/mode/ruby";
import { go } from "@codemirror/legacy-modes/mode/go";
import { oneDark } from "@codemirror/theme-one-dark";
import { Save, X } from "lucide-react";
import { sftpReadText, sftpWriteText } from "../api";
import { isIdentical } from "../diff";
import DiffModal from "./DiffModal";

interface Props {
  sessionId: string;
  path: string;
  readOnly: boolean;
  onNotify: (kind: "ok" | "err", text: string) => void;
  onClose: () => void;
}

/** Extension de langage d'après l'extension (ou le nom) du fichier. */
function languageFor(path: string) {
  const p = path.toLowerCase();
  const nom = p.split("/").pop() ?? p;
  if (p.endsWith(".json")) return [json()];
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return [yaml()];
  if (/\.(js|jsx|ts|tsx|mjs|cjs)$/.test(p)) return [javascript()];
  if (p.endsWith(".py")) return [python()];
  if (p.endsWith(".md") || p.endsWith(".markdown")) return [markdown()];
  if (p.endsWith(".html") || p.endsWith(".htm") || p.endsWith(".vue")) return [html()];
  if (p.endsWith(".css") || p.endsWith(".scss") || p.endsWith(".less")) return [css()];
  if (p.endsWith(".xml") || p.endsWith(".svg") || p.endsWith(".plist")) return [xml()];
  if (p.endsWith(".sql")) return [sql()];
  if (p.endsWith(".php")) return [php()];
  if (p.endsWith(".rs")) return [rust()];
  if (p.endsWith(".lua")) return [StreamLanguage.define(lua)];
  if (p.endsWith(".rb")) return [StreamLanguage.define(ruby)];
  if (p.endsWith(".go")) return [StreamLanguage.define(go)];
  if (p.endsWith(".toml")) return [StreamLanguage.define(toml)];
  if (nom.startsWith("dockerfile")) return [StreamLanguage.define(dockerFile)];
  // nginx.conf, sites-available/… : la configuration nginx a sa coloration.
  if (nom.includes("nginx") && p.endsWith(".conf")) return [StreamLanguage.define(nginx)];
  if (
    /\.(sh|bash|zsh)$/.test(p) ||
    /^\.(bashrc|zshrc|profile|bash_profile|zprofile)$/.test(nom)
  ) {
    return [StreamLanguage.define(shell)];
  }
  // .env, .ini, .conf, .service (systemd) : format clé=valeur par sections.
  if (/\.(ini|env|properties|conf|service|timer)$/.test(p) || nom === ".env") {
    return [StreamLanguage.define(properties)];
  }
  return [];
}

export default function EditorModal({
  sessionId,
  path,
  readOnly,
  onNotify,
  onClose,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const originalRef = useRef("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Le fichier a changé sur le serveur depuis son chargement : diff à trancher. */
  const [conflict, setConflict] = useState<{
    remote: string;
    mine: string;
  } | null>(null);

  // Chargement puis construction de l'éditeur.
  useEffect(() => {
    let disposed = false;
    sftpReadText(sessionId, path)
      .then((content) => {
        if (disposed || !hostRef.current) return;
        originalRef.current = content;
        const view = new EditorView({
          state: EditorState.create({
            doc: content,
            extensions: [
              basicSetup,
              ...languageFor(path),
              oneDark,
              EditorView.editable.of(!readOnly),
              EditorView.updateListener.of((u) => {
                if (u.docChanged) {
                  setDirty(u.state.doc.toString() !== originalRef.current);
                }
              }),
            ],
          }),
          parent: hostRef.current,
        });
        viewRef.current = view;
        view.focus();
        setLoading(false);
      })
      .catch((e) => {
        if (!disposed) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
  }, [sessionId, path, readOnly]);

  /** Écrit sans plus rien vérifier : le conflit a déjà été tranché. */
  const write = async (content: string) => {
    setSaving(true);
    try {
      await sftpWriteText(sessionId, path, content);
      originalRef.current = content;
      setDirty(false);
      onNotify("ok", `« ${path.split("/").pop()} » enregistré sur le serveur.`);
    } catch (e) {
      onNotify("err", String(e));
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    const view = viewRef.current;
    if (!view || readOnly) return;
    const content = view.state.doc.toString();
    // Le fichier a-t-il bougé sur le serveur pendant l'édition ? Si oui on
    // montre le diff plutôt que d'écraser silencieusement le travail d'un autre.
    setSaving(true);
    let remote: string | null = null;
    try {
      remote = await sftpReadText(sessionId, path);
    } catch {
      // Relecture impossible (droits, fichier supprimé) : on écrit quand même,
      // l'erreur d'écriture sera plus parlante que celle de lecture.
    } finally {
      setSaving(false);
    }
    if (remote !== null && !isIdentical(remote, originalRef.current)) {
      setConflict({ remote, mine: content });
      return;
    }
    await write(content);
  };

  // ⌘S enregistre, Échap ferme (avec garde si modifié).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        save();
      } else if (e.key === "Escape") {
        e.preventDefault();
        tryClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, dirty]);

  const tryClose = () => {
    if (dirty && !window.confirm("Modifications non enregistrées. Fermer quand même ?")) {
      return;
    }
    onClose();
  };

  return (
    <>
      <div className="modal-backdrop" onMouseDown={tryClose}>
        <div className="modal editor-modal" onMouseDown={(e) => e.stopPropagation()}>
          <p className="modal-eyebrow">
            Édition {readOnly && "— lecture seule"}
            {dirty && " — modifié"}
          </p>
          <h2 className="modal-title mono editor-path">{path}</h2>

          {error && <div className="modal-error">{error}</div>}
          {loading && !error && <p className="saved-empty">Chargement…</p>}

          <div className="editor-host" ref={hostRef} />

          <div className="modal-actions">
            <button className="btn" onClick={tryClose}>
              <X size={13} /> Fermer
            </button>
            {!readOnly && (
              <button className="btn primary" onClick={save} disabled={saving || !dirty}>
                <Save size={13} /> {saving ? "Enregistrement…" : "Enregistrer (⌘S)"}
              </button>
            )}
          </div>
        </div>
      </div>

      {conflict && (
        <DiffModal
          path={path}
          beforeLabel="version du serveur"
          before={conflict.remote}
          afterLabel="votre version"
          after={conflict.mine}
          confirmLabel="Écraser le serveur"
          onConfirm={() => {
            const mine = conflict.mine;
            setConflict(null);
            void write(mine);
          }}
          onCancel={() => setConflict(null)}
        />
      )}
    </>
  );
}
