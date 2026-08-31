export interface Table {
  headers: string[];
  rows: string[][];
}

/**
 * Recette d'embellissement : une commande reconnue, réécrite pour produire
 * une sortie séparée par des tabulations (bien plus fiable qu'un découpage
 * de colonnes alignées), avec des en-têtes lisibles.
 */
export interface Recipe {
  id: string;
  /** Libellé proposé dans l'interface. */
  label: string;
  /** Motif reconnu dans ce que tape l'utilisateur. */
  match: RegExp;
  /** Commande réellement exécutée. */
  command: string;
  /** Ce que l'utilisateur taperait : sert au bouton de raccourci. */
  example: string;
  headers: string[];
  /** Colonnes numériques ou de taille, pour un tri pertinent. */
  numeric?: number[];
  /** Actions proposées sur une ligne (Docker, systemd…). */
  actions?: "docker" | "systemd";
}

const TAB = "\\t";

export const RECIPES: Recipe[] = [
  {
    id: "docker-ps",
    example: "docker ps",
    label: "Conteneurs Docker",
    match: /^docker\s+ps(\s|$)/,
    command: `docker ps -a --format '{{.Names}}${TAB}{{.State}}${TAB}{{.Image}}${TAB}{{.Status}}${TAB}{{.Ports}}'`,
    headers: ["Nom", "État", "Image", "Statut", "Ports"],
    actions: "docker",
  },
  {
    id: "docker-images",
    example: "docker images",
    label: "Images Docker",
    match: /^docker\s+images(\s|$)/,
    command: `docker images --format '{{.Repository}}${TAB}{{.Tag}}${TAB}{{.Size}}${TAB}{{.CreatedSince}}'`,
    headers: ["Dépôt", "Étiquette", "Taille", "Créée"],
    numeric: [2],
  },
  {
    id: "df",
    example: "df -h",
    label: "Espace disque",
    match: /^df(\s|$)/,
    command:
      'df -hP | tail -n +2 | awk \'{printf "%s\\t%s\\t%s\\t%s\\t%s\\t", $1, $2, $3, $4, $5; for(i=6;i<=NF;i++) printf "%s%s", $i, (i<NF?" ":""); print ""}\'',
    headers: ["Système", "Taille", "Utilisé", "Libre", "%", "Monté sur"],
    numeric: [1, 2, 3, 4],
  },
  {
    id: "ps",
    example: "ps",
    label: "Processus",
    match: /^(ps|top)(\s|$)/,
    command:
      'ps -eo pid,pcpu,pmem,user,comm --sort=-pcpu | tail -n +2 | head -n 40 | awk \'{print $1"\\t"$2"\\t"$3"\\t"$4"\\t"$5}\'',
    headers: ["PID", "% CPU", "% mém", "Utilisateur", "Commande"],
    numeric: [0, 1, 2],
  },
  {
    id: "systemctl",
    example: "systemctl",
    label: "Services systemd",
    match: /^systemctl(\s|$)/,
    command:
      'systemctl list-units --type=service --all --no-legend --no-pager | awk \'{name=$1; load=$2; active=$3; sub=$4; $1=$2=$3=$4=""; sub(/^ +/,""); print name"\\t"active"\\t"sub"\\t"$0}\' | head -n 80',
    headers: ["Service", "État", "Sous-état", "Description"],
    actions: "systemd",
  },
  {
    id: "ss",
    example: "ss -tlnp",
    label: "Ports en écoute",
    match: /^(ss|netstat|lsof)(\s|$)/,
    command:
      '(ss -tlnpH 2>/dev/null || netstat -tlnp 2>/dev/null | tail -n +3) | awk \'{print $4"\\t"$1"\\t"$NF}\'',
    headers: ["Adresse locale", "Protocole", "Processus"],
  },
  {
    id: "ls",
    example: "ls -l",
    label: "Contenu d'un dossier",
    match: /^ls(\s|$)/,
    command:
      'ls -lAh --time-style=long-iso 2>/dev/null || ls -lAh | tail -n +2 | awk \'{printf "%s\\t%s\\t%s\\t%s\\t", $1, $3, $5, $6" "$7" "$8; for(i=9;i<=NF;i++) printf "%s%s", $i, (i<NF?" ":""); print ""}\'',
    headers: ["Droits", "Propriétaire", "Taille", "Modifié", "Nom"],
  },
];

/** Recette définie par l'utilisateur, telle qu'elle est enregistrée. */
export interface CustomRecipe {
  id: string;
  label: string;
  /** Motif de reconnaissance, saisi en texte (préfixe de commande). */
  prefix: string;
  command: string;
  /** En-têtes séparés par des virgules. */
  headers: string;
}

const CUSTOM_KEY = "cabestan.recipes";

export function loadCustomRecipes(): CustomRecipe[] {
  try {
    const raw = JSON.parse(localStorage.getItem(CUSTOM_KEY) ?? "[]");
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveCustomRecipes(list: CustomRecipe[]) {
  localStorage.setItem(CUSTOM_KEY, JSON.stringify(list));
}

/** Convertit une recette utilisateur en recette exploitable. */
export function toRecipe(c: CustomRecipe): Recipe {
  const escaped = c.prefix.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return {
    id: c.id,
    label: c.label || c.prefix,
    example: c.prefix.trim(),
    match: new RegExp(`^${escaped}(\\s|$)`),
    command: c.command,
    headers: c.headers
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
  };
}

/** Toutes les recettes : celles de l'utilisateur d'abord (elles priment). */
export function allRecipes(): Recipe[] {
  const custom = loadCustomRecipes()
    .filter((c) => c.prefix.trim() && c.command.trim() && c.headers.trim())
    .map(toRecipe);
  return [...custom, ...RECIPES];
}

/** Recette correspondant à ce que l'utilisateur a tapé, si elle existe. */
export function findRecipe(input: string): Recipe | null {
  const cmd = input.trim();
  return allRecipes().find((r) => r.match.test(cmd)) ?? null;
}

/** Découpe une sortie séparée par des tabulations. */
export function parseTabs(text: string, headers: string[]): Table {
  const rows = text
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const cells = l.split("\t");
      // On complète ou tronque pour rester rectangulaire.
      while (cells.length < headers.length) cells.push("");
      return cells.slice(0, headers.length).map((c) => c.trim());
    });
  return { headers, rows };
}

/**
 * Sortie inconnue : on devine les colonnes. La première ligne sert d'en-tête
 * si elle ne ressemble pas à une donnée, et les colonnes sont séparées par
 * deux espaces ou plus (convention des sorties alignées).
 */
export function parseAligned(text: string): Table {
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trimEnd())
    .filter((l) => l.trim() !== "");
  if (lines.length === 0) return { headers: [], rows: [] };

  const split = (l: string) =>
    l
      .trim()
      .split(/\s{2,}|\t+/)
      .map((c) => c.trim());
  const first = split(lines[0]);
  const rest = lines.slice(1).map(split);

  // En-tête probable : que des mots, sans chiffre seul, et largeur cohérente.
  const looksLikeHeader =
    lines.length > 1 &&
    first.every((c) => c !== "" && !/^[\d.,%/-]+$/.test(c)) &&
    rest.some((r) => r.length === first.length);

  const width = Math.max(first.length, ...rest.map((r) => r.length), 1);
  const pad = (cells: string[]) => {
    const out = [...cells];
    while (out.length < width) out.push("");
    return out.slice(0, width);
  };

  if (looksLikeHeader) {
    return { headers: pad(first), rows: rest.map(pad) };
  }
  return {
    headers: Array.from({ length: width }, (_, i) => `Colonne ${i + 1}`),
    rows: [first, ...rest].map(pad),
  };
}

/** Convertit une taille lisible ("1.5G", "700 Mo", "42%") en nombre comparable. */
export function sizeToNumber(value: string): number {
  const v = value.trim().replace(",", ".");
  const m = v.match(/^([\d.]+)\s*([KMGTP]?)(i?[Bo])?%?$/i);
  if (!m) {
    const plain = parseFloat(v);
    return Number.isFinite(plain) ? plain : Number.NEGATIVE_INFINITY;
  }
  const n = parseFloat(m[1]);
  const unit = (m[2] || "").toUpperCase();
  const factor: Record<string, number> = {
    "": 1,
    K: 1024,
    M: 1024 ** 2,
    G: 1024 ** 3,
    T: 1024 ** 4,
    P: 1024 ** 5,
  };
  return n * (factor[unit] ?? 1);
}

/** Trie les lignes sur une colonne ; `numeric` force la comparaison chiffrée. */
export function sortRows(
  rows: string[][],
  col: number,
  asc: boolean,
  numeric: boolean,
): string[][] {
  const dir = asc ? 1 : -1;
  return [...rows].sort((a, b) => {
    const x = a[col] ?? "";
    const y = b[col] ?? "";
    if (numeric) return (sizeToNumber(x) - sizeToNumber(y)) * dir;
    return x.localeCompare(y, "fr", { numeric: true }) * dir;
  });
}

/** Filtre les lignes contenant le texte (insensible à la casse). */
export function filterRows(rows: string[][], needle: string): string[][] {
  const q = needle.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.some((c) => c.toLowerCase().includes(q)));
}

/** Rend le tableau copiable (format tableur). */
export function toTsv(table: Table): string {
  return [table.headers, ...table.rows].map((r) => r.join("\t")).join("\n");
}

const ESC = "\u001b";

/**
 * Retire les séquences de contrôle d'une sortie de terminal : couleurs,
 * déplacements de curseur, séquences OSC. Indispensable avant de découper
 * une sortie capturée dans un shell interactif.
 */
export function stripAnsi(text: string): string {
  return (
    text
      // OSC : ESC ] … terminé par BEL ou ESC antislash
      .replace(new RegExp(`${ESC}\\][^\\u0007${ESC}]*(?:\\u0007|${ESC}\\\\)`, "g"), "")
      // CSI : ESC [ … lettre finale
      .replace(new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g"), "")
      // Séquences courtes (jeux de caractères, mode clavier)
      .replace(new RegExp(`${ESC}[()#][0-9A-Za-z]`, "g"), "")
      .replace(new RegExp(`${ESC}[=>]`, "g"), "")
      // Retour chariot seul (réécriture de ligne) et cloche
      .replace(/\r(?!\n)/g, "\n")
      .replace(/\u0007/g, "")
  );
}

/**
 * Nettoie une sortie capturée dans le terminal : contrôles retirés, écho de
 * la commande et invite finale écartés.
 */
export function cleanCaptured(text: string, command: string): string {
  const lines = stripAnsi(text).split("\n");
  const cmd = command.trim();

  // L'écho de la commande ouvre généralement la capture : on écarte tout
  // jusqu'à cette ligne incluse.
  const echo = cmd === "" ? -1 : lines.findIndex((l) => l.includes(cmd));
  const body = lines.slice(echo >= 0 ? echo + 1 : 0);

  // On coupe à l'invite suivante (ligne courte terminée par $, # ou >).
  const promptAt = body.findIndex((l) => /(^|\s)\S*[$#>]\s*$/.test(l) && l.length < 120);
  const kept = promptAt >= 0 ? body.slice(0, promptAt) : body;

  return kept
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** La sortie a-t-elle une allure tabulaire exploitable ? */
export function looksTabular(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return false;
  const columns = lines.slice(0, 8).map((l) => l.trim().split(/\s{2,}|\t+/).length);
  return columns.filter((n) => n >= 2).length >= Math.ceil(columns.length / 2);
}
