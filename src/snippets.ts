export interface Snippet {
  id: string;
  label: string;
  command: string;
}

const KEY = "cabestan.snippets";

const DEFAULTS: Snippet[] = [
  { id: "s1", label: "Espace disque", command: "df -h" },
  { id: "s2", label: "Processus gourmands", command: "ps aux --sort=-%cpu | head -15" },
  { id: "s3", label: "Écoute réseau", command: "ss -tlnp || netstat -tlnp" },
  { id: "s4", label: "Journal système", command: "journalctl -n 50 --no-pager" },
];

export function loadSnippets(): Snippet[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : DEFAULTS;
  } catch {
    return DEFAULTS;
  }
}

export function saveSnippets(list: Snippet[]) {
  localStorage.setItem(KEY, JSON.stringify(list));
}

/** Variables remplies automatiquement au moment de l'envoi. */
export const BUILTIN_VARS = ["host", "user", "path"] as const;

/**
 * Variables à demander à l'utilisateur : tous les {{nom}} de la commande qui
 * ne sont pas des variables automatiques, sans doublon, dans l'ordre.
 */
export function placeholdersOf(command: string): string[] {
  const names: string[] = [];
  for (const m of command.matchAll(/\{\{\s*([A-Za-zÀ-ÿ0-9_-]+)\s*\}\}/g)) {
    const name = m[1];
    if ((BUILTIN_VARS as readonly string[]).includes(name)) continue;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** Remplace chaque {{nom}} par sa valeur ; les variables absentes restent. */
export function fillPlaceholders(
  command: string,
  values: Record<string, string>,
): string {
  return command.replace(/\{\{\s*([A-Za-zÀ-ÿ0-9_-]+)\s*\}\}/g, (whole, name) =>
    name in values ? values[name] : whole,
  );
}
