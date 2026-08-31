import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  Download,
  FolderTree,
  Keyboard,
  SquareTerminal,
  Sparkles,
  Upload,
  X,
  Zap,
} from "lucide-react";
import { configImport } from "../api";
import { applyConfig, countExecutable, exportConfigTo, parseConfig } from "../config";
import { Settings } from "../settings";
import { TERM_THEMES } from "../themes";
import ShortcutsTab from "./ShortcutsTab";
import SnippetsTab from "./SnippetsTab";
import RecipesTab from "./RecipesTab";
import { CustomRecipe, loadCustomRecipes, saveCustomRecipes } from "../tabulate";
import { Snippet } from "../snippets";

type TabId = "terminal" | "files" | "snippets" | "recipes" | "shortcuts";

const TABS: Array<{ id: TabId; label: string; icon: typeof Keyboard }> = [
  { id: "terminal", label: "Terminal", icon: SquareTerminal },
  { id: "files", label: "Explorateur", icon: FolderTree },
  { id: "snippets", label: "Commandes", icon: Zap },
  { id: "recipes", label: "Recettes", icon: Sparkles },
  { id: "shortcuts", label: "Raccourcis", icon: Keyboard },
];

interface Props {
  settings: Settings;
  onChange: (s: Settings) => void;
  snippets: Snippet[];
  onSnippets: (list: Snippet[]) => void;
  onKnownHosts: () => void;
  onNotify: (kind: "ok" | "err", text: string) => void;
  onClose: () => void;
}

export default function SettingsModal({
  settings,
  onChange,
  snippets,
  onSnippets,
  onKnownHosts,
  onNotify,
  onClose,
}: Props) {
  const [tab, setTab] = useState<TabId>("terminal");
  const [recipes, setRecipes] = useState<CustomRecipe[]>(loadCustomRecipes);
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value });

  const doExport = async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const dest = await save({
      title: "Exporter la configuration",
      defaultPath: `cabestan-config-${new Date().toISOString().slice(0, 10)}.json`,
    });
    if (!dest) return;
    try {
      const n = await exportConfigTo(dest);
      onNotify("ok", `Configuration exportée (${n} entrées) vers ${dest}.`);
    } catch (e) {
      onNotify("err", String(e));
    }
  };

  const doImport = async () => {
    const { open, ask } = await import("@tauri-apps/plugin-dialog");
    const src = await open({ title: "Importer une configuration" });
    if (typeof src !== "string") return;

    // On lit et valide AVANT de demander confirmation, pour pouvoir annoncer
    // ce que le fichier contient — notamment les commandes qui s'exécuteraient.
    let text: string;
    try {
      text = await configImport(src);
    } catch (e) {
      onNotify("err", String(e));
      return;
    }
    const parsed = parseConfig(text);
    if (typeof parsed === "string") {
      onNotify("err", parsed);
      return;
    }
    const exec = countExecutable(parsed.entries);
    const warning =
      exec.profiles + exec.snippets > 0
        ? `\n\nAttention : ce fichier contient ${exec.profiles} commande(s) jouée(s) automatiquement à la connexion et ${exec.snippets} commande(s) enregistrée(s). Elles s'exécuteront sur vos serveurs. N'importez que des fichiers dont vous connaissez l'origine.`
        : "";
    const ok = await ask(
      `Importer remplacera vos connexions, réglages, commandes et signets actuels.${warning}\n\nContinuer ?`,
      { title: "Importer la configuration", kind: "warning" },
    );
    if (!ok) return;
    const count = applyConfig(parsed.entries);
    onNotify("ok", `Configuration importée (${count} entrées). Rechargement…`);
    // Le plus simple et le plus sûr : repartir sur l'état importé.
    setTimeout(() => location.reload(), 900);
  };

  /** Ouvre le Finder sur /Applications pour choisir l'éditeur. */
  const chooseEditor = async () => {
    const picked = await openDialog({
      title: "Choisir l'application d'édition",
      defaultPath: "/Applications",
      // Sur macOS un .app est un paquet : le filtre le rend sélectionnable.
      filters: [{ name: "Applications", extensions: ["app"] }],
    });
    if (typeof picked !== "string") return;
    // On garde le nom lisible ; « open -a » le résout aussi bien qu'un chemin.
    const name =
      picked
        .split("/")
        .pop()
        ?.replace(/\.app$/i, "") ?? picked;
    set("editorApp", name);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal settings-modal" onMouseDown={(e) => e.stopPropagation()}>
        <p className="modal-eyebrow">Réglages</p>
        <h2 className="modal-title">Cabestan</h2>

        <div className="settings-tabs" role="tablist">
          {TABS.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                className={tab === t.id ? "active" : ""}
                onClick={() => setTab(t.id)}
              >
                <Icon size={13} /> {t.label}
              </button>
            );
          })}
        </div>

        {tab === "snippets" && <SnippetsTab snippets={snippets} onChange={onSnippets} />}

        {tab === "recipes" && (
          <RecipesTab
            recipes={recipes}
            onChange={(list) => {
              setRecipes(list);
              saveCustomRecipes(list);
            }}
          />
        )}

        {tab === "shortcuts" && (
          <ShortcutsTab
            overrides={settings.shortcuts}
            onChange={(shortcuts) => onChange({ ...settings, shortcuts })}
          />
        )}

        {tab === "terminal" && (
          <>
            <p className="settings-group">Terminal</p>
            <div className="field-row">
              <label className="field grow">
                <span>Taille de police</span>
                <input
                  type="number"
                  min={10}
                  max={22}
                  value={settings.termFontSize}
                  onChange={(e) =>
                    set(
                      "termFontSize",
                      Math.min(22, Math.max(10, Number(e.target.value) || 13)),
                    )
                  }
                  className="mono"
                />
              </label>
              <label className="field grow">
                <span>Historique (lignes)</span>
                <input
                  type="number"
                  min={1000}
                  max={100000}
                  step={1000}
                  value={settings.termScrollback}
                  onChange={(e) =>
                    set(
                      "termScrollback",
                      Math.min(100000, Math.max(1000, Number(e.target.value) || 8000)),
                    )
                  }
                  className="mono"
                />
              </label>
            </div>
            <label className="field">
              <span>Police (doit être installée sur ce Mac)</span>
              <input
                value={settings.termFontFamily}
                onChange={(e) => set("termFontFamily", e.target.value)}
                className="mono"
                placeholder="JetBrains Mono"
              />
            </label>
            <label className="field">
              <span>Thème</span>
              <select
                className="mono"
                value={settings.termTheme}
                onChange={(e) => set("termTheme", e.target.value)}
              >
                {TERM_THEMES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.termCursorBlink}
                onChange={(e) => set("termCursorBlink", e.target.checked)}
              />
              <span>Curseur clignotant</span>
            </label>
          </>
        )}

        {tab === "files" && (
          <>
            <p className="settings-group">Explorateur</p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.hideHidden}
                onChange={(e) => set("hideHidden", e.target.checked)}
              />
              <span>Masquer les fichiers cachés (noms commençant par un point)</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.useTrash}
                onChange={(e) => set("useTrash", e.target.checked)}
              />
              <span>
                Mettre à la corbeille du serveur au lieu de supprimer
                <small>Les éléments partent dans ~/.cabestan-corbeille.</small>
              </span>
            </label>
            <label className="field">
              <span>Application d'édition (vide = celle du système)</span>
              <div className="field-row">
                <input
                  className="grow"
                  value={settings.editorApp}
                  onChange={(e) => set("editorApp", e.target.value)}
                  placeholder="Celle du système"
                />
                <button className="btn" onClick={chooseEditor}>
                  Choisir…
                </button>
                {settings.editorApp && (
                  <button
                    className="btn"
                    title="Revenir à l'application par défaut"
                    onClick={() => set("editorApp", "")}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            </label>

            <p className="settings-group">Nouvelles sessions</p>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.filesDefault}
                onChange={(e) => set("filesDefault", e.target.checked)}
              />
              <span>Explorateur visible à l'ouverture</span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.syncDefault}
                onChange={(e) => set("syncDefault", e.target.checked)}
              />
              <span>
                Suivre le dossier du terminal
                <small>
                  L'explorateur suit vos cd ; naviguer dans l'explorateur fait cd.
                </small>
              </span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.autoReconnect}
                onChange={(e) => set("autoReconnect", e.target.checked)}
              />
              <span>
                Reconnecter automatiquement une session tombée
                <small>Jusqu'à 5 tentatives espacées de 2 s à 30 s.</small>
              </span>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={settings.restoreTabs}
                onChange={(e) => set("restoreTabs", e.target.checked)}
              />
              <span>
                Rouvrir les sessions au démarrage
                <small>Reconnecte les serveurs gardés qui étaient ouverts.</small>
              </span>
            </label>

            <p className="settings-group">Sécurité</p>
            <div className="settings-row-action">
              <span>Empreintes mémorisées des serveurs</span>
              <button className="btn" onClick={onKnownHosts}>
                Gérer les hôtes connus…
              </button>
            </div>

            <p className="settings-group">Configuration</p>
            <p className="sc-intro">
              Connexions, groupes, réglages, commandes et signets. Les mots de passe ne
              sont jamais exportés : ils restent dans le Trousseau macOS.
            </p>
            <div className="settings-row-action">
              <span>Sauvegarder ou transférer sur un autre Mac</span>
              <span className="config-actions">
                <button className="btn" onClick={doExport}>
                  <Download size={13} /> Exporter…
                </button>
                <button className="btn" onClick={doImport}>
                  <Upload size={13} /> Importer…
                </button>
              </span>
            </div>
          </>
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
