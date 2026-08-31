import { describe, expect, it } from "vitest";
import { SavedConnection } from "./api";
import { confirmMatches, isSensitive, needsStrongConfirm } from "./guards";

const conn = (over: Partial<SavedConnection> = {}): SavedConnection => ({
  id: "a@b:22",
  name: "Serveur",
  host: "b",
  port: 22,
  username: "a",
  auth: "key",
  ...over,
});

describe("détection d'une connexion sensible", () => {
  it("repère la couleur rouge", () => {
    expect(isSensitive(conn({ color: "#e06c5a" }))).toBe(true);
    expect(isSensitive(conn({ color: "#63b3a1" }))).toBe(false);
  });

  it("repère le mot prod dans le nom ou le groupe", () => {
    expect(isSensitive(conn({ name: "Prod web" }))).toBe(true);
    expect(isSensitive(conn({ group: "Production" }))).toBe(true);
    expect(isSensitive(conn({ name: "préprod-reproduction" }))).toBe(false);
  });

  it("ne se déclenche pas sans indice", () => {
    expect(isSensitive(conn())).toBe(false);
    expect(isSensitive(undefined)).toBe(false);
  });
});

describe("confirmation renforcée", () => {
  it("s'applique sur un dossier d'une connexion sensible", () => {
    expect(needsStrongConfirm(true, [{ isDir: true }])).toBe(true);
  });

  it("s'applique sur une sélection multiple", () => {
    expect(needsStrongConfirm(true, [{ isDir: false }, { isDir: false }])).toBe(true);
  });

  it("ne s'applique pas sur un fichier unique", () => {
    expect(needsStrongConfirm(true, [{ isDir: false }])).toBe(false);
  });

  it("ne s'applique jamais hors connexion sensible", () => {
    expect(needsStrongConfirm(false, [{ isDir: true }, { isDir: true }])).toBe(false);
  });
});

describe("saisie de confirmation", () => {
  it("accepte le nom exact, espaces tolérés", () => {
    expect(confirmMatches("Prod web", "Prod web")).toBe(true);
    expect(confirmMatches("  Prod web  ", "Prod web")).toBe(true);
  });

  it("refuse une saisie différente ou vide", () => {
    expect(confirmMatches("prod web", "Prod web")).toBe(false);
    expect(confirmMatches("", "Prod web")).toBe(false);
    expect(confirmMatches("x", "")).toBe(false);
  });
});
