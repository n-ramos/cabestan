import { describe, expect, it } from "vitest";
import { PaneNode, leaf, leavesOf, removePane, setRatio, splitPane } from "./panes";

describe("arbre de panneaux", () => {
  it("scinde une feuille en deux", () => {
    const tree = splitPane(leaf("a"), "a", "row", "b");
    expect(tree.type).toBe("split");
    expect(leavesOf(tree)).toEqual(["a", "b"]);
  });

  it("scinde récursivement un panneau déjà scindé", () => {
    let tree: PaneNode = splitPane(leaf("a"), "a", "row", "b");
    tree = splitPane(tree, "b", "col", "c");
    expect(leavesOf(tree)).toEqual(["a", "b", "c"]);
  });

  it("ignore une cible inconnue", () => {
    const before = leaf("a");
    expect(splitPane(before, "zzz", "row", "b")).toEqual(before);
  });

  it("fait remonter le frère quand on retire une feuille", () => {
    const tree = splitPane(leaf("a"), "a", "row", "b");
    const after = removePane(tree, "a");
    expect(after).toEqual(leaf("b"));
  });

  it("renvoie null quand la dernière feuille est retirée", () => {
    expect(removePane(leaf("a"), "a")).toBeNull();
  });

  it("retire au bon niveau dans un arbre profond", () => {
    let tree: PaneNode = splitPane(leaf("a"), "a", "row", "b");
    tree = splitPane(tree, "b", "col", "c");
    const after = removePane(tree, "c");
    expect(after && leavesOf(after)).toEqual(["a", "b"]);
  });

  it("modifie le ratio du split désigné par son chemin", () => {
    let tree: PaneNode = splitPane(leaf("a"), "a", "row", "b");
    tree = splitPane(tree, "b", "col", "c");
    const changed = setRatio(tree, "", 0.3);
    expect(changed.type === "split" && changed.ratio).toBe(0.3);
    // Le split imbriqué (branche b) garde son ratio par défaut.
    const nested = setRatio(tree, "b", 0.8);
    expect(nested.type === "split" && nested.b.type === "split" && nested.b.ratio).toBe(
      0.8,
    );
    expect(nested.type === "split" && nested.ratio).toBe(0.5);
  });

  it("laisse une feuille intacte quand on change un ratio", () => {
    expect(setRatio(leaf("a"), "", 0.9)).toEqual(leaf("a"));
  });
});
