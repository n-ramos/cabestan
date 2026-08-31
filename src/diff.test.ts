import { describe, expect, it } from "vitest";
import { DiffRow, collapse, diffLines, diffStats, isIdentical, toLines } from "./diff";

/** Rend un diff sous forme compacte, pour des attentes lisibles. */
const show = (rows: DiffRow[]) =>
  rows.map((r) =>
    r.type === "skip"
      ? `… ${r.count}`
      : `${r.type === "eq" ? " " : r.type === "add" ? "+" : "-"}${r.text}`,
  );

describe("découpage en lignes", () => {
  it("normalise les fins de ligne Windows", () => {
    expect(toLines("a\r\nb\rc\nd")).toEqual(["a", "b", "c", "d"]);
    expect(toLines("")).toEqual([]);
  });

  it("compare en ignorant le style de fin de ligne", () => {
    expect(isIdentical("a\r\nb", "a\nb")).toBe(true);
    expect(isIdentical("a\nb", "a\nc")).toBe(false);
  });
});

describe("diff ligne à ligne", () => {
  it("ne signale rien sur deux textes identiques", () => {
    const rows = diffLines("a\nb\nc", "a\nb\nc");
    expect(rows.every((r) => r.type === "eq")).toBe(true);
    expect(diffStats(rows)).toEqual({ added: 0, removed: 0 });
  });

  it("repère une ligne modifiée au milieu", () => {
    expect(show(diffLines("a\nb\nc", "a\nB\nc"))).toEqual([" a", "-b", "+B", " c"]);
  });

  it("repère un ajout et une suppression", () => {
    expect(show(diffLines("a\nc", "a\nb\nc"))).toEqual([" a", "+b", " c"]);
    expect(show(diffLines("a\nb\nc", "a\nc"))).toEqual([" a", "-b", " c"]);
  });

  it("aligne sur la plus longue sous-séquence commune", () => {
    expect(show(diffLines("a\nb\nc\nd", "a\nx\nc\ny\nd"))).toEqual([
      " a",
      "-b",
      "+x",
      " c",
      "+y",
      " d",
    ]);
  });

  it("numérote les lignes de chaque côté", () => {
    const rows = diffLines("a\nb\nc", "a\nB\nc");
    expect(rows[0]).toEqual({ type: "eq", a: 1, b: 1, text: "a" });
    expect(rows[1]).toEqual({ type: "del", a: 2, text: "b" });
    expect(rows[2]).toEqual({ type: "add", b: 2, text: "B" });
    expect(rows[3]).toEqual({ type: "eq", a: 3, b: 3, text: "c" });
  });

  it("gère un fichier vide de chaque côté", () => {
    expect(diffStats(diffLines("", "a\nb"))).toEqual({ added: 2, removed: 0 });
    expect(diffStats(diffLines("a\nb", ""))).toEqual({ added: 0, removed: 2 });
  });

  it("compte correctement les lignes touchées", () => {
    const avant = "server {\n  listen 80;\n  root /var/www;\n}";
    const apres = "server {\n  listen 443 ssl;\n  root /var/www;\n  index index.html;\n}";
    expect(diffStats(diffLines(avant, apres))).toEqual({ added: 2, removed: 1 });
  });

  it("reste rapide sur un gros fichier peu modifié", () => {
    const base = Array.from({ length: 20000 }, (_, i) => `ligne ${i}`).join("\n");
    const modifie = base.replace("ligne 10000", "LIGNE MODIFIÉE");
    const t0 = performance.now();
    const rows = diffLines(base, modifie);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(diffStats(rows)).toEqual({ added: 1, removed: 1 });
  });

  it("renonce à l'alignement fin sur deux gros fichiers sans rien de commun", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join("\n");
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join("\n");
    const rows = diffLines(a, b);
    expect(diffStats(rows)).toEqual({ added: 3000, removed: 3000 });
    // Bloc retiré puis bloc ajouté, sans entrelacement.
    const premierAjout = rows.findIndex((r) => r.type === "add");
    expect(rows.slice(0, premierAjout).every((r) => r.type === "del")).toBe(true);
  });
});

describe("repli des plages identiques", () => {
  it("garde le contexte autour d'une modification", () => {
    const lignes = (n: number, p = "l") =>
      Array.from({ length: n }, (_, i) => `${p}${i}`).join("\n");
    const rows = diffLines(lignes(20), lignes(20).replace("l10", "MODIF"));
    const out = collapse(rows, 2);
    expect(show(out)).toEqual([
      "… 8",
      " l8",
      " l9",
      "-l10",
      "+MODIF",
      " l11",
      " l12",
      "… 7",
    ]);
  });

  it("ne replie pas une plage d'une seule ligne", () => {
    const rows: DiffRow[] = [
      { type: "add", b: 1, text: "x" },
      { type: "eq", a: 1, b: 2, text: "m" },
      { type: "add", b: 3, text: "y" },
    ];
    expect(collapse(rows, 0)).toEqual(rows);
  });

  it("laisse intact un diff sans ligne identique", () => {
    const rows = diffLines("a", "b");
    expect(collapse(rows)).toEqual(rows);
  });

  it("replie tout quand rien ne change", () => {
    const rows = diffLines("a\nb\nc", "a\nb\nc");
    expect(collapse(rows)).toEqual([{ type: "skip", count: 3 }]);
  });
});
