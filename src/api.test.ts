import { describe, expect, it } from "vitest";
import {
  formatPermissions,
  formatSize,
  joinPath,
  parentPath,
  parseHostKeyIssue,
} from "./api";

describe("chemins", () => {
  it("assemble sans doubler la barre oblique", () => {
    expect(joinPath("/home/marin", "a.txt")).toBe("/home/marin/a.txt");
    expect(joinPath("/home/marin/", "a.txt")).toBe("/home/marin/a.txt");
    expect(joinPath("/", "a.txt")).toBe("/a.txt");
  });

  it("remonte d'un niveau et s'arrête à la racine", () => {
    expect(parentPath("/home/marin/deploy")).toBe("/home/marin");
    expect(parentPath("/home")).toBe("/");
    expect(parentPath("/")).toBe("/");
    expect(parentPath("/home/marin/")).toBe("/home");
  });
});

describe("tailles", () => {
  it("passe des octets aux unités supérieures", () => {
    expect(formatSize(512)).toBe("512 o");
    expect(formatSize(2048)).toBe("2.0 Ko");
    expect(formatSize(1024 * 1024)).toBe("1.0 Mo");
    expect(formatSize(734003200)).toBe("700 Mo");
  });

  it("arrondit sans décimale au-delà de 100", () => {
    expect(formatSize(150 * 1024)).toBe("150 Ko");
  });
});

describe("droits", () => {
  it("traduit un mode octal en rwx", () => {
    expect(formatPermissions(0o644, false)).toBe("-rw-r--r--");
    expect(formatPermissions(0o755, true)).toBe("drwxr-xr-x");
    expect(formatPermissions(0o600, false)).toBe("-rw-------");
  });

  it("affiche un tiret quand le mode est inconnu", () => {
    expect(formatPermissions(null, false)).toBe("—");
  });
});

describe("alerte d'empreinte d'hôte", () => {
  it("reconnaît un hôte inconnu", () => {
    const issue = parseHostKeyIssue("UNKNOWN_HOST_KEY|ssh-ed25519|SHA256:abc");
    expect(issue).toEqual({
      kind: "unknown",
      algo: "ssh-ed25519",
      fingerprint: "SHA256:abc",
    });
  });

  it("reconnaît une clé changée", () => {
    expect(parseHostKeyIssue("HOST_KEY_CHANGED|ssh-rsa|SHA256:xyz")?.kind).toBe(
      "changed",
    );
  });

  it("renvoie null sur une erreur ordinaire", () => {
    expect(parseHostKeyIssue("Authentification refusée par le serveur")).toBeNull();
    expect(parseHostKeyIssue(new Error("réseau injoignable"))).toBeNull();
  });
});
