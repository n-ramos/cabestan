import { beforeEach, describe, expect, it } from "vitest";
import { applyConfig, collectConfig, countExecutable, parseConfig } from "./config";

const valid = (entries: Record<string, unknown>) =>
  JSON.stringify({
    format: "cabestan-config",
    version: 1,
    exportedAt: "2026-01-01T00:00:00.000Z",
    entries,
  });

describe("collecte de la configuration", () => {
  beforeEach(() => localStorage.clear());

  it("rassemble les clés connues et les signets", () => {
    localStorage.setItem("cabestan.connections", JSON.stringify([{ id: "a" }]));
    localStorage.setItem("cabestan.settings", JSON.stringify({ termFontSize: 15 }));
    localStorage.setItem("cabestan.bookmarks.marin@h:22", JSON.stringify(["/tmp"]));
    const cfg = collectConfig();
    expect(Object.keys(cfg.entries).sort()).toEqual([
      "cabestan.bookmarks.marin@h:22",
      "cabestan.connections",
      "cabestan.settings",
    ]);
    expect(cfg.format).toBe("cabestan-config");
  });

  it("ignore une valeur illisible plutôt que d'échouer", () => {
    localStorage.setItem("cabestan.connections", "{ceci n'est pas du json");
    localStorage.setItem("cabestan.settings", JSON.stringify({ a: 1 }));
    const cfg = collectConfig();
    expect(cfg.entries["cabestan.connections"]).toBeUndefined();
    expect(cfg.entries["cabestan.settings"]).toEqual({ a: 1 });
  });

  it("n'exporte aucun mot de passe", () => {
    localStorage.setItem("cabestan.connections", JSON.stringify([{ id: "a" }]));
    expect(JSON.stringify(collectConfig()).toLowerCase()).not.toContain("password");
  });
});

describe("validation d'un fichier importé", () => {
  it("accepte un fichier conforme", () => {
    const res = parseConfig(valid({ "cabestan.settings": { termFontSize: 16 } }));
    expect(typeof res).toBe("object");
    expect(res).toHaveProperty("entries");
  });

  it("refuse un JSON invalide", () => {
    expect(parseConfig("pas du json")).toMatch(/JSON/);
  });

  it("refuse un fichier d'une autre application", () => {
    expect(
      parseConfig(JSON.stringify({ format: "autre", version: 1, entries: {} })),
    ).toMatch(/pas une configuration/);
  });

  it("refuse une version future", () => {
    expect(
      parseConfig(
        JSON.stringify({ format: "cabestan-config", version: 99, entries: {} }),
      ),
    ).toMatch(/trop récente/);
  });

  it("écarte les clés inconnues", () => {
    const res = parseConfig(
      valid({ "cabestan.settings": { a: 1 }, "autre.cle": { b: 2 } }),
    );
    if (typeof res === "string") throw new Error(res);
    expect(Object.keys(res.entries)).toEqual(["cabestan.settings"]);
  });

  it("refuse un fichier sans donnée exploitable", () => {
    expect(parseConfig(valid({ "autre.cle": 1 }))).toMatch(/Aucune donnée/);
  });
});

describe("application d'une configuration", () => {
  beforeEach(() => localStorage.clear());

  it("écrit les entrées dans le stockage local", () => {
    const n = applyConfig({ "cabestan.settings": { termFontSize: 18 } });
    expect(n).toBe(1);
    expect(JSON.parse(localStorage.getItem("cabestan.settings") ?? "{}")).toEqual({
      termFontSize: 18,
    });
  });

  it("fait un aller-retour fidèle", () => {
    localStorage.setItem(
      "cabestan.snippets",
      JSON.stringify([{ id: "s", label: "L", command: "df -h" }]),
    );
    const exported = JSON.stringify(collectConfig());
    localStorage.clear();
    const res = parseConfig(exported);
    if (typeof res === "string") throw new Error(res);
    applyConfig(res.entries);
    expect(JSON.parse(localStorage.getItem("cabestan.snippets") ?? "[]")).toEqual([
      { id: "s", label: "L", command: "df -h" },
    ]);
  });
});

describe("contenu exécutable d'un import", () => {
  it("compte les profils et les commandes", () => {
    const { profiles, snippets } = countExecutable({
      "cabestan.connections": [
        { id: "a", profile: ["cd /tmp", "tail -f x"] },
        { id: "b", profile: ["whoami"] },
        { id: "c" },
      ],
      "cabestan.snippets": [{ id: "s", label: "L", command: "df -h" }],
    });
    expect(profiles).toBe(3);
    expect(snippets).toBe(1);
  });

  it("ne compte rien quand il n'y a pas de commande", () => {
    expect(countExecutable({ "cabestan.settings": { a: 1 } })).toEqual({
      profiles: 0,
      snippets: 0,
    });
  });

  it("résiste à des données mal formées", () => {
    expect(
      countExecutable({
        "cabestan.connections": "pas un tableau",
        "cabestan.snippets": 42,
      }),
    ).toEqual({ profiles: 0, snippets: 0 });
  });
});
