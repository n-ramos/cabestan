/**
 * Logique pure de l'interface Git : construction des arguments et décodage
 * des sorties `--porcelain`. Tout ce qui parle au binaire vit dans `api.ts`
 * (git_cli) ; ici, rien que du texte, donc tout est testable.
 */

// Séparateur de champs dans les formats de log/branche : un caractère qui
// n'apparaît jamais dans un message de commit.
const SEP = "\x1f";

// ─── Types ───────────────────────────────────────────────────────

export interface GitStatus {
  /** Nom de la branche courante, ou null en tête détachée. */
  branch: string | null;
  /** Branche amont ("origin/main"), si elle existe. */
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: GitEntry[];
}

export interface GitEntry {
  /** Colonne index (état "staged") du porcelain, " " si rien. */
  x: string;
  /** Colonne arbre de travail, " " si rien. */
  y: string;
  path: string;
  /** Ancien chemin pour un renommage. */
  from?: string;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  refs: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

// ─── Arguments ───────────────────────────────────────────────────

/** Racine du dépôt contenant le dossier — sert aussi de sonde. */
export const rootArgs = () => ["rev-parse", "--show-toplevel"];

export const statusArgs = () => ["status", "--porcelain=v1", "-b"];

export const logArgs = (limit = 100) => [
  "log",
  `--pretty=format:%H${SEP}%h${SEP}%an${SEP}%ad${SEP}%s${SEP}%D`,
  "--date=format:%d/%m/%Y %H:%M",
  "-n",
  String(limit),
];

export const branchArgs = () => [
  "branch",
  "-a",
  `--format=%(HEAD)${SEP}%(refname:short)${SEP}%(refname)`,
];

export const showArgs = (hash: string) => ["show", "--stat", "--patch", hash];

export const diffArgs = (path: string, staged: boolean) =>
  staged ? ["diff", "--staged", "--", path] : ["diff", "--", path];

export const stageArgs = (paths: string[]) => ["add", "--", ...paths];

export const unstageArgs = (paths: string[]) => ["restore", "--staged", "--", ...paths];

/** Abandonne les modifications locales d'un fichier suivi. Destructif. */
export const discardArgs = (paths: string[]) => ["restore", "--", ...paths];

export const commitArgs = (message: string) => ["commit", "-m", message];

export const pullArgs = () => ["pull", "--ff-only"];

export const pushArgs = () => ["push"];

/** Publie une branche qui n'a pas encore d'amont. */
export const pushSetUpstreamArgs = (branch: string) => [
  "push",
  "--set-upstream",
  "origin",
  branch,
];

export const fetchArgs = () => ["fetch", "--prune"];

export const switchArgs = (branch: string) => ["switch", branch];

export const createBranchArgs = (name: string) => ["switch", "-c", name];

// ─── Décodage ────────────────────────────────────────────────────

/** Décode `git status --porcelain=v1 -b`. */
export function parseStatus(out: string): GitStatus {
  const status: GitStatus = {
    branch: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    entries: [],
  };
  for (const line of out.split("\n")) {
    if (!line) continue;
    if (line.startsWith("## ")) {
      let head = line.slice(3);
      if (head.startsWith("HEAD (")) continue; // tête détachée
      if (head.startsWith("No commits yet on ")) {
        status.branch = head.slice("No commits yet on ".length);
        continue;
      }
      // "main...origin/main [ahead 1, behind 2]" ou juste "main".
      // Découpage manuel : un nom de branche peut contenir des points.
      const bracket = head.match(/ \[(.+)\]$/);
      if (bracket) {
        status.ahead = Number(bracket[1].match(/ahead (\d+)/)?.[1] ?? 0);
        status.behind = Number(bracket[1].match(/behind (\d+)/)?.[1] ?? 0);
        head = head.slice(0, -bracket[0].length);
      }
      const dots = head.indexOf("...");
      status.branch = dots >= 0 ? head.slice(0, dots) : head;
      status.upstream = dots >= 0 ? head.slice(dots + 3) : null;
      continue;
    }
    if (line.length < 4) continue;
    const x = line[0];
    const y = line[1];
    let path = line.slice(3);
    let from: string | undefined;
    const arrow = path.indexOf(" -> ");
    if (arrow >= 0) {
      from = path.slice(0, arrow);
      path = path.slice(arrow + 4);
    }
    // git cite les chemins contenant espaces ou accents : "sous \"quotes\"".
    if (path.startsWith('"') && path.endsWith('"')) {
      path = unquote(path);
    }
    if (from?.startsWith('"') && from.endsWith('"')) {
      from = unquote(from);
    }
    status.entries.push({ x, y, path, from });
  }
  return status;
}

/** Retire les quotes C de git (\" \\ \t \n et octales \303\251). */
function unquote(s: string): string {
  const inner = s.slice(1, -1);
  const bytes: number[] = [];
  let i = 0;
  while (i < inner.length) {
    const c = inner[i];
    if (c !== "\\") {
      // Le texte hors échappement est déjà en clair.
      for (const b of new TextEncoder().encode(c)) bytes.push(b);
      i++;
      continue;
    }
    const n = inner[i + 1];
    if (n >= "0" && n <= "7") {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 4;
    } else {
      const map: Record<string, string> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };
      for (const b of new TextEncoder().encode(map[n] ?? n)) bytes.push(b);
      i += 2;
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Libellé français d'un code d'état porcelain. */
export function statusLabel(code: string): string {
  const labels: Record<string, string> = {
    M: "modifié",
    T: "type changé",
    A: "ajouté",
    D: "supprimé",
    R: "renommé",
    C: "copié",
    U: "en conflit",
    "?": "non suivi",
    "!": "ignoré",
  };
  return labels[code] ?? code;
}

/** L'entrée a-t-elle quelque chose dans l'index (à décommiter) ? */
export const isStaged = (e: GitEntry) => e.x !== " " && e.x !== "?";

/** L'entrée a-t-elle des changements hors index (à indexer) ? */
export const isUnstaged = (e: GitEntry) => e.y !== " ";

export const isUntracked = (e: GitEntry) => e.x === "?" && e.y === "?";

export const isConflict = (e: GitEntry) =>
  e.x === "U" || e.y === "U" || (e.x === "A" && e.y === "A") || (e.x === "D" && e.y === "D");

/** Décode le log au format construit par `logArgs`. */
export function parseLog(out: string): GitCommit[] {
  const commits: GitCommit[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(SEP);
    if (parts.length < 5) continue;
    commits.push({
      hash: parts[0],
      shortHash: parts[1],
      author: parts[2],
      date: parts[3],
      subject: parts[4],
      refs: parts[5] ?? "",
    });
  }
  return commits;
}

/** Décode `git branch -a` au format construit par `branchArgs`. */
export function parseBranches(out: string): GitBranch[] {
  const branches: GitBranch[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split(SEP);
    if (parts.length < 2) continue;
    const name = parts[1].trim();
    // Le pointeur "origin/HEAD" n'est pas une branche sur laquelle basculer.
    if (!name || name.endsWith("/HEAD")) continue;
    branches.push({
      name,
      current: parts[0] === "*",
      remote: (parts[2] ?? "").startsWith("refs/remotes/"),
    });
  }
  return branches;
}

/** Résumé court de l'état : "2 indexés · 3 modifiés · 1 non suivi". */
export function summarizeStatus(entries: GitEntry[]): string {
  const staged = entries.filter(isStaged).length;
  const unstaged = entries.filter((e) => isUnstaged(e) && !isUntracked(e)).length;
  const untracked = entries.filter(isUntracked).length;
  const parts: string[] = [];
  if (staged) parts.push(`${staged} indexé${staged > 1 ? "s" : ""}`);
  if (unstaged) parts.push(`${unstaged} modifié${unstaged > 1 ? "s" : ""}`);
  if (untracked) parts.push(`${untracked} non suivi${untracked > 1 ? "s" : ""}`);
  return parts.length ? parts.join(" · ") : "rien à valider, arbre propre";
}
