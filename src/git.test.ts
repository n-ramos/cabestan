import { describe, expect, it } from "vitest";
import {
  branchArgs,
  commitArgs,
  isConflict,
  isStaged,
  isUnstaged,
  isUntracked,
  logArgs,
  parseBranches,
  parseLog,
  parseStatus,
  statusLabel,
  summarizeStatus,
} from "./git";

const SEP = "\x1f";

describe("parseStatus", () => {
  it("lit la branche, l'amont et l'avance/le retard", () => {
    const s = parseStatus("## main...origin/main [ahead 2, behind 1]\n");
    expect(s.branch).toBe("main");
    expect(s.upstream).toBe("origin/main");
    expect(s.ahead).toBe(2);
    expect(s.behind).toBe(1);
  });

  it("lit une branche sans amont", () => {
    const s = parseStatus("## ma-branche\n");
    expect(s.branch).toBe("ma-branche");
    expect(s.upstream).toBeNull();
    expect(s.ahead).toBe(0);
  });

  it("laisse la branche nulle en tête détachée", () => {
    const s = parseStatus("## HEAD (no branch)\n?? truc.txt\n");
    expect(s.branch).toBeNull();
    expect(s.entries).toHaveLength(1);
  });

  it("décode les entrées classiques", () => {
    const s = parseStatus(
      [
        "## main",
        " M src/app.ts",
        "M  src/api.ts",
        "MM src/mixte.ts",
        "?? nouveau.txt",
        "D  parti.txt",
      ].join("\n"),
    );
    expect(s.entries).toHaveLength(5);
    const [modif, index, mixte, nouveau, supprime] = s.entries;
    expect(modif).toMatchObject({ x: " ", y: "M", path: "src/app.ts" });
    expect(isUnstaged(modif)).toBe(true);
    expect(isStaged(modif)).toBe(false);
    expect(index).toMatchObject({ x: "M", y: " ", path: "src/api.ts" });
    expect(isStaged(index)).toBe(true);
    expect(isUnstaged(index)).toBe(false);
    expect(isStaged(mixte) && isUnstaged(mixte)).toBe(true);
    expect(isUntracked(nouveau)).toBe(true);
    expect(isStaged(nouveau)).toBe(false);
    expect(supprime).toMatchObject({ x: "D", path: "parti.txt" });
  });

  it("décode un renommage", () => {
    const s = parseStatus("## main\nR  ancien.txt -> nouveau.txt\n");
    expect(s.entries[0]).toMatchObject({
      x: "R",
      path: "nouveau.txt",
      from: "ancien.txt",
    });
  });

  it("décode les chemins cités (espaces, accents)", () => {
    const s = parseStatus('## main\n?? "mon fichier.txt"\n?? "caf\\303\\251.txt"\n');
    expect(s.entries[0].path).toBe("mon fichier.txt");
    expect(s.entries[1].path).toBe("café.txt");
  });

  it("repère les conflits", () => {
    const s = parseStatus("## main\nUU fusion.ts\nAA double.ts\n M normal.ts\n");
    expect(isConflict(s.entries[0])).toBe(true);
    expect(isConflict(s.entries[1])).toBe(true);
    expect(isConflict(s.entries[2])).toBe(false);
  });
});

describe("parseLog", () => {
  it("décode les commits au format attendu", () => {
    const out = [
      `abc123${SEP}abc${SEP}Nathalie${SEP}01/02/2026 10:00${SEP}fix: la voile${SEP}HEAD -> main, origin/main`,
      `def456${SEP}def${SEP}Marin${SEP}31/01/2026 09:00${SEP}feat: le mât${SEP}`,
    ].join("\n");
    const commits = parseLog(out);
    expect(commits).toHaveLength(2);
    expect(commits[0]).toMatchObject({
      hash: "abc123",
      shortHash: "abc",
      author: "Nathalie",
      subject: "fix: la voile",
      refs: "HEAD -> main, origin/main",
    });
    expect(commits[1].refs).toBe("");
  });

  it("survit aux sujets contenant des caractères spéciaux", () => {
    const out = `a${SEP}a${SEP}x${SEP}d${SEP}sujet avec "quotes" et -> flèche${SEP}`;
    expect(parseLog(out)[0].subject).toBe('sujet avec "quotes" et -> flèche');
  });

  it("borne le nombre de commits demandés", () => {
    expect(logArgs(50)).toContain("50");
  });
});

describe("parseBranches", () => {
  it("distingue courante, locales et distantes", () => {
    const out = [
      `*${SEP}main${SEP}refs/heads/main`,
      ` ${SEP}dev${SEP}refs/heads/dev`,
      ` ${SEP}origin/main${SEP}refs/remotes/origin/main`,
      ` ${SEP}origin/HEAD${SEP}refs/remotes/origin/HEAD`,
    ].join("\n");
    const branches = parseBranches(out);
    expect(branches).toHaveLength(3); // origin/HEAD écarté
    expect(branches[0]).toMatchObject({ name: "main", current: true, remote: false });
    expect(branches[1]).toMatchObject({ name: "dev", current: false, remote: false });
    expect(branches[2]).toMatchObject({ name: "origin/main", remote: true });
  });

  it("construit un format stable", () => {
    expect(branchArgs()[0]).toBe("branch");
  });
});

describe("libellés et résumé", () => {
  it("traduit les codes porcelain", () => {
    expect(statusLabel("M")).toBe("modifié");
    expect(statusLabel("?")).toBe("non suivi");
    expect(statusLabel("Z")).toBe("Z");
  });

  it("résume l'état de l'arbre", () => {
    expect(summarizeStatus([])).toBe("rien à valider, arbre propre");
    expect(
      summarizeStatus(
        parseStatus("## m\nM  a.ts\nM  b.ts\n M c.ts\n?? d.txt\n").entries,
      ),
    ).toBe("2 indexés · 1 modifié · 1 non suivi");
  });

  it("passe le message de commit en un seul argument", () => {
    expect(commitArgs("fix: espace et 'quotes'")).toEqual([
      "commit",
      "-m",
      "fix: espace et 'quotes'",
    ]);
  });
});
