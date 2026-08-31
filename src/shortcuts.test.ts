import { beforeAll, describe, expect, it } from "vitest";
import { accelFromEvent, conflictsOf, prettyAccel } from "./shortcuts";

const key = (init: Partial<KeyboardEventInit> & { code: string }) =>
  new KeyboardEvent("keydown", init as KeyboardEventInit);

describe("capture d'un raccourci", () => {
  it("compose les modificateurs dans un ordre stable", () => {
    expect(accelFromEvent(key({ code: "KeyD", metaKey: true, shiftKey: true }))).toBe(
      "CmdOrCtrl+Shift+D",
    );
    expect(accelFromEvent(key({ code: "KeyK", metaKey: true }))).toBe("CmdOrCtrl+K");
    expect(accelFromEvent(key({ code: "Tab", ctrlKey: true, shiftKey: true }))).toBe(
      "Ctrl+Shift+Tab",
    );
  });

  it("gère chiffres, touches de fonction et ponctuation", () => {
    expect(accelFromEvent(key({ code: "Digit3", metaKey: true }))).toBe("CmdOrCtrl+3");
    expect(accelFromEvent(key({ code: "F5", metaKey: true }))).toBe("CmdOrCtrl+F5");
    expect(accelFromEvent(key({ code: "Comma", metaKey: true }))).toBe("CmdOrCtrl+Comma");
    expect(accelFromEvent(key({ code: "ArrowUp", altKey: true }))).toBe("Alt+ArrowUp");
  });

  it("refuse une touche sans modificateur (elle volerait les frappes du terminal)", () => {
    expect(accelFromEvent(key({ code: "KeyD" }))).toBeNull();
  });

  it("refuse une touche non prise en charge", () => {
    expect(accelFromEvent(key({ code: "CapsLock", metaKey: true }))).toBeNull();
    expect(accelFromEvent(key({ code: "ShiftLeft", metaKey: true }))).toBeNull();
  });
});

describe("affichage d'un raccourci", () => {
  // prettyAccel dépend de la plateforme : on simule macOS.
  beforeAll(() => {
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
  });

  it("remplace les modificateurs par leurs symboles", () => {
    expect(prettyAccel("CmdOrCtrl+Shift+D")).toBe("⌘⇧D");
    expect(prettyAccel("Ctrl+Shift+Tab")).toBe("⌃⇧⇥");
    expect(prettyAccel("CmdOrCtrl+Comma")).toBe("⌘,");
  });

  it("affiche un tiret quand le raccourci est retiré", () => {
    expect(prettyAccel("")).toBe("—");
  });

  it("utilise les libellés texte hors macOS", () => {
    Object.defineProperty(navigator, "platform", {
      value: "Linux x86_64",
      configurable: true,
    });
    expect(prettyAccel("CmdOrCtrl+Shift+D")).toBe("CtrlShiftD");
    Object.defineProperty(navigator, "platform", {
      value: "MacIntel",
      configurable: true,
    });
  });
});

describe("détection des doublons", () => {
  const actions = [
    { id: "a", label: "A", defaultAccel: "CmdOrCtrl+D" },
    { id: "b", label: "B", defaultAccel: "CmdOrCtrl+E" },
    { id: "c", label: "C", defaultAccel: "CmdOrCtrl+F" },
  ];

  it("ne signale rien quand tout est distinct", () => {
    expect(conflictsOf(actions, {}).size).toBe(0);
  });

  it("signale les deux actions qui partagent une combinaison", () => {
    const found = conflictsOf(actions, { b: "CmdOrCtrl+D" });
    expect([...found].sort()).toEqual(["a", "b"]);
  });

  it("ignore les raccourcis retirés", () => {
    const found = conflictsOf(actions, { a: "", b: "" });
    expect(found.size).toBe(0);
  });
});
