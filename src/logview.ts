export type Level = "error" | "warn" | "info" | "debug" | "plain";

export interface LogLine {
  n: number;
  text: string;
  level: Level;
}

const PATTERNS: Array<[Level, RegExp]> = [
  ["error", /\b(erreur|error|fatal|panic|critical|exception|failed|échec|refus)\b/i],
  ["warn", /\b(warn|warning|attention|deprecated|avertissement)\b/i],
  ["info", /\b(info|notice|started|listening|démarr)\b/i],
  ["debug", /\b(debug|trace|verbose)\b/i],
];

/** Devine le niveau d'une ligne de journal. */
export function levelOf(line: string): Level {
  for (const [level, re] of PATTERNS) {
    if (re.test(line)) return level;
  }
  return "plain";
}

/**
 * Ajoute un bloc reçu aux lignes existantes. Le dernier élément peut être
 * incomplet : on le complète plutôt que de créer une ligne coupée.
 */
export function appendChunk(
  lines: LogLine[],
  chunk: string,
  nextN: number,
  max: number,
): { lines: LogLine[]; nextN: number; partial: string } {
  const parts = chunk.split("\n");
  const partial = parts.pop() ?? "";
  let n = nextN;
  const added = parts
    .map((p) => p.replace(/\r$/, ""))
    .map((text) => ({ n: n++, text, level: levelOf(text) }));
  const all = [...lines, ...added];
  return {
    lines: all.length > max ? all.slice(all.length - max) : all,
    nextN: n,
    partial,
  };
}

/** Filtre par texte et par niveaux retenus. */
export function filterLog(
  lines: LogLine[],
  needle: string,
  levels: Set<Level>,
): LogLine[] {
  const q = needle.trim().toLowerCase();
  return lines.filter(
    (l) =>
      (levels.size === 0 || levels.has(l.level)) &&
      (q === "" || l.text.toLowerCase().includes(q)),
  );
}

/** Compte par niveau, pour l'affichage du résumé. */
export function countLevels(lines: LogLine[]): Record<Level, number> {
  const out: Record<Level, number> = {
    error: 0,
    warn: 0,
    info: 0,
    debug: 0,
    plain: 0,
  };
  for (const l of lines) out[l.level]++;
  return out;
}
