import { describe, expect, it } from "vitest";
import { fillPlaceholders, placeholdersOf } from "./snippets";

describe("placeholdersOf", () => {
  it("relève les variables personnalisées, sans doublon, dans l'ordre", () => {
    expect(placeholdersOf("systemctl {{action}} {{service}} && echo {{action}}")).toEqual(
      ["action", "service"],
    );
  });

  it("ignore les variables automatiques", () => {
    expect(placeholdersOf("ssh {{user}}@{{host}} -p {{port}}")).toEqual(["port"]);
  });

  it("tolère les espaces intérieurs et les tirets", () => {
    expect(placeholdersOf("echo {{ nom-du-site }}")).toEqual(["nom-du-site"]);
  });

  it("rend une liste vide sans variable", () => {
    expect(placeholdersOf("df -h")).toEqual([]);
  });
});

describe("fillPlaceholders", () => {
  it("remplace toutes les occurrences", () => {
    expect(
      fillPlaceholders("systemctl {{action}} {{svc}} ; echo {{action}}", {
        action: "restart",
        svc: "nginx",
      }),
    ).toBe("systemctl restart nginx ; echo restart");
  });

  it("laisse intactes les variables sans valeur (les automatiques)", () => {
    expect(fillPlaceholders("ssh {{user}}@{{host}} -p {{port}}", { port: "2222" })).toBe(
      "ssh {{user}}@{{host}} -p 2222",
    );
  });

  it("accepte une valeur vide", () => {
    expect(fillPlaceholders("tail {{opts}} f.log", { opts: "" })).toBe("tail  f.log");
  });
});
