import { configExport, configImport } from "./api";

/** Clés du stockage local qui composent la configuration exportable. */
const KEYS = [
  "cabestan.connections",
  "cabestan.settings",
  "cabestan.snippets",
  "cabestan.workspaces",
];

const BOOKMARK_PREFIX = "cabestan.bookmarks.";
const FORMAT = "cabestan-config";
const VERSION = 1;

export interface ConfigFile {
  format: string;
  version: number;
  exportedAt: string;
  entries: Record<string, unknown>;
}

/** Rassemble la configuration courante (mots de passe exclus : ils restent au Trousseau). */
export function collectConfig(): ConfigFile {
  const entries: Record<string, unknown> = {};
  for (const key of KEYS) {
    const raw = localStorage.getItem(key);
    if (raw === null) continue;
    try {
      entries[key] = JSON.parse(raw);
    } catch {
      // Valeur illisible : on l'ignore plutôt que de casser l'export.
    }
  }
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(BOOKMARK_PREFIX)) continue;
    try {
      entries[key] = JSON.parse(localStorage.getItem(key) ?? "[]");
    } catch {
      // idem
    }
  }
  return {
    format: FORMAT,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    entries,
  };
}

export async function exportConfigTo(path: string): Promise<number> {
  const config = collectConfig();
  await configExport(path, JSON.stringify(config, null, 2));
  return Object.keys(config.entries).length;
}

/** Valide un fichier importé ; renvoie les entrées ou un message d'erreur. */
export function parseConfig(text: string): { entries: Record<string, unknown> } | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "Fichier illisible : ce n'est pas du JSON.";
  }
  if (typeof parsed !== "object" || parsed === null) {
    return "Fichier illisible : contenu inattendu.";
  }
  const cfg = parsed as Partial<ConfigFile>;
  if (cfg.format !== FORMAT) {
    return "Ce fichier n'est pas une configuration Cabestan.";
  }
  if (typeof cfg.version !== "number" || cfg.version > VERSION) {
    return `Configuration trop récente (version ${String(cfg.version)}) pour cette version de l'app.`;
  }
  if (typeof cfg.entries !== "object" || cfg.entries === null) {
    return "Configuration vide ou corrompue.";
  }
  // On n'accepte que les clés que l'on sait gérer.
  const entries: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg.entries)) {
    if (KEYS.includes(key) || key.startsWith(BOOKMARK_PREFIX)) {
      entries[key] = value;
    }
  }
  if (Object.keys(entries).length === 0) {
    return "Aucune donnée exploitable dans ce fichier.";
  }
  return { entries };
}

/**
 * Compte les commandes qui s'exécuteraient depuis un fichier importé :
 * profils de connexion (joués à l'ouverture) et commandes enregistrées.
 * Sert à avertir l'utilisateur avant d'écraser sa configuration.
 */
export function countExecutable(entries: Record<string, unknown>): {
  profiles: number;
  snippets: number;
} {
  let profiles = 0;
  const conns = entries["cabestan.connections"];
  if (Array.isArray(conns)) {
    for (const c of conns) {
      const p = (c as { profile?: unknown }).profile;
      if (Array.isArray(p)) profiles += p.length;
    }
  }
  const snips = entries["cabestan.snippets"];
  const snippets = Array.isArray(snips) ? snips.length : 0;
  return { profiles, snippets };
}

/** Applique une configuration importée. Renvoie le nombre de clés écrites. */
export function applyConfig(entries: Record<string, unknown>): number {
  for (const [key, value] of Object.entries(entries)) {
    localStorage.setItem(key, JSON.stringify(value));
  }
  return Object.keys(entries).length;
}

export async function importConfigFrom(
  path: string,
): Promise<{ count: number } | { error: string }> {
  const text = await configImport(path);
  const result = parseConfig(text);
  if (typeof result === "string") return { error: result };
  return { count: applyConfig(result.entries) };
}
