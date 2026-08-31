import { describe, expect, it } from "vitest";
import { appendChunk, countLevels, filterLog, levelOf, LogLine } from "./logview";

describe("détection du niveau", () => {
  it("repère les erreurs, en français comme en anglais", () => {
    expect(levelOf("ERROR: connexion refusée")).toBe("error");
    expect(levelOf("Une erreur est survenue")).toBe("error");
    expect(levelOf("panic: runtime")).toBe("error");
  });

  it("repère les avertissements et les informations", () => {
    expect(levelOf("WARN deprecated option")).toBe("warn");
    expect(levelOf("Attention : disque presque plein")).toBe("warn");
    expect(levelOf("INFO listening on :80")).toBe("info");
  });

  it("laisse le reste en texte simple", () => {
    expect(levelOf("192.168.1.1 - - [27/Aug/2026] GET /")).toBe("plain");
  });

  it("donne la priorité à l'erreur sur l'avertissement", () => {
    expect(levelOf("WARN: fatal error ahead")).toBe("error");
  });
});

describe("accumulation des blocs reçus", () => {
  it("découpe en lignes et numérote", () => {
    const r = appendChunk([], "une\ndeux\n", 1, 100);
    expect(r.lines.map((l) => l.text)).toEqual(["une", "deux"]);
    expect(r.nextN).toBe(3);
    expect(r.partial).toBe("");
  });

  it("garde la ligne incomplète de côté", () => {
    const r = appendChunk([], "complète\nincom", 1, 100);
    expect(r.lines).toHaveLength(1);
    expect(r.partial).toBe("incom");
  });

  it("recolle une ligne coupée entre deux blocs", () => {
    const a = appendChunk([], "début", 1, 100);
    expect(a.lines).toHaveLength(0);
    const b = appendChunk(a.lines, a.partial + "-fin\n", a.nextN, 100);
    expect(b.lines[0].text).toBe("début-fin");
  });

  it("respecte le plafond de lignes conservées", () => {
    let lines: LogLine[] = [];
    let n = 1;
    for (let i = 0; i < 50; i++) {
      const r = appendChunk(lines, `ligne ${i}\n`, n, 10);
      lines = r.lines;
      n = r.nextN;
    }
    expect(lines).toHaveLength(10);
    expect(lines[lines.length - 1].text).toBe("ligne 49");
  });

  it("retire les retours Windows", () => {
    const r = appendChunk([], "avec-cr\r\n", 1, 100);
    expect(r.lines[0].text).toBe("avec-cr");
  });
});

describe("filtre du journal", () => {
  const lines = appendChunk(
    [],
    "ERROR grosse panne\nWARN presque\nINFO tout va bien\naccès simple\n",
    1,
    100,
  ).lines;

  it("filtre par texte", () => {
    expect(filterLog(lines, "panne", new Set()).length).toBe(1);
  });

  it("filtre par niveau", () => {
    expect(filterLog(lines, "", new Set(["error"])).length).toBe(1);
    expect(filterLog(lines, "", new Set(["error", "warn"])).length).toBe(2);
  });

  it("combine texte et niveau", () => {
    expect(filterLog(lines, "presque", new Set(["error"])).length).toBe(0);
    expect(filterLog(lines, "presque", new Set(["warn"])).length).toBe(1);
  });

  it("compte par niveau", () => {
    const c = countLevels(lines);
    expect(c.error).toBe(1);
    expect(c.warn).toBe(1);
    expect(c.info).toBe(1);
    expect(c.plain).toBe(1);
  });
});
