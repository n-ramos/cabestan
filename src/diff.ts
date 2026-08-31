/**
 * Diff ligne à ligne, utilisé avant tout écrasement d'un fichier distant.
 *
 * L'algorithme est un plus longue sous-séquence commune classique, précédé du
 * retrait des préfixes et suffixes identiques : sur un fichier de configuration
 * dont on change trois lignes, cela ramène la matrice à quelques cases. Au-delà
 * d'une taille déraisonnable on renonce à l'alignement fin et on présente le
 * bloc remplacé, plutôt que de figer l'interface.
 */

export type DiffRow =
  | { type: "eq"; a: number; b: number; text: string }
  | { type: "del"; a: number; text: string }
  | { type: "add"; b: number; text: string }
  /** Repli de N lignes identiques. */
  | { type: "skip"; count: number };

/** Au-delà de ce nombre de cases, on ne tente plus l'alignement fin. */
const MAX_CELLS = 2_000_000;

/**
 * Découpe en lignes en ignorant les fins de ligne Windows. Un fichier vide vaut
 * zéro ligne, pas une ligne vide : sinon un fichier créé de rien afficherait
 * une suppression fantôme.
 */
export function toLines(text: string): string[] {
  if (text === "") return [];
  return text.replace(/\r\n?/g, "\n").split("\n");
}

/** Les deux versions sont-elles identiques (fins de ligne mises à part) ? */
export function isIdentical(before: string, after: string): boolean {
  return before.replace(/\r\n?/g, "\n") === after.replace(/\r\n?/g, "\n");
}

function lcsRows(a: string[], b: string[], offA: number, offB: number): DiffRow[] {
  const n = a.length;
  const m = b.length;
  // Table des longueurs de la plus longue sous-séquence commune.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ type: "eq", a: offA + i + 1, b: offB + j + 1, text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ type: "del", a: offA + i + 1, text: a[i] });
      i++;
    } else {
      rows.push({ type: "add", b: offB + j + 1, text: b[j] });
      j++;
    }
  }
  while (i < n) rows.push({ type: "del", a: offA + i + 1, text: a[i++] });
  while (j < m) rows.push({ type: "add", b: offB + j + 1, text: b[j++] });
  return rows;
}

/** Diff unifié complet : chaque ligne des deux versions apparaît une fois. */
export function diffLines(before: string, after: string): DiffRow[] {
  const a = toLines(before);
  const b = toLines(after);

  // Préfixe commun.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  // Suffixe commun (sans empiéter sur le préfixe).
  let end = 0;
  while (
    end < a.length - start &&
    end < b.length - start &&
    a[a.length - 1 - end] === b[b.length - 1 - end]
  ) {
    end++;
  }

  const rows: DiffRow[] = [];
  for (let k = 0; k < start; k++) {
    rows.push({ type: "eq", a: k + 1, b: k + 1, text: a[k] });
  }

  const midA = a.slice(start, a.length - end);
  const midB = b.slice(start, b.length - end);
  if (midA.length || midB.length) {
    if ((midA.length + 1) * (midB.length + 1) > MAX_CELLS) {
      // Trop gros : on montre le bloc retiré puis le bloc ajouté.
      midA.forEach((t, k) => rows.push({ type: "del", a: start + k + 1, text: t }));
      midB.forEach((t, k) => rows.push({ type: "add", b: start + k + 1, text: t }));
    } else {
      rows.push(...lcsRows(midA, midB, start, start));
    }
  }

  for (let k = 0; k < end; k++) {
    rows.push({
      type: "eq",
      a: a.length - end + k + 1,
      b: b.length - end + k + 1,
      text: a[a.length - end + k],
    });
  }
  return rows;
}

/**
 * Replie les longues plages identiques en gardant `context` lignes autour de
 * chaque modification. Une plage de `context + 1` lignes n'est jamais repliée :
 * cacher une ligne pour en afficher un repli n'apporte rien.
 */
export function collapse(rows: DiffRow[], context = 3): DiffRow[] {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r.type === "eq") return;
    for (
      let k = Math.max(0, i - context);
      k <= Math.min(rows.length - 1, i + context);
      k++
    ) {
      keep[k] = true;
    }
  });
  const out: DiffRow[] = [];
  let hidden: DiffRow[] = [];
  const flush = () => {
    if (hidden.length === 0) return;
    // Replier une seule ligne n'économise rien : on la garde telle quelle.
    if (hidden.length === 1) out.push(hidden[0]);
    else out.push({ type: "skip", count: hidden.length });
    hidden = [];
  };
  rows.forEach((r, i) => {
    if (keep[i]) {
      flush();
      out.push(r);
    } else {
      hidden.push(r);
    }
  });
  flush();
  return out;
}

/** Nombre de lignes ajoutées et retirées. */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  return rows.reduce(
    (acc, r) => {
      if (r.type === "add") acc.added++;
      if (r.type === "del") acc.removed++;
      return acc;
    },
    { added: 0, removed: 0 },
  );
}
