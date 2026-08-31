export type SplitDir = "row" | "col";

export type PaneNode =
  | { type: "leaf"; paneId: string }
  | { type: "split"; dir: SplitDir; ratio: number; a: PaneNode; b: PaneNode };

export const leaf = (paneId: string): PaneNode => ({ type: "leaf", paneId });

/** Remplace la feuille `paneId` par un split contenant l'ancienne et une nouvelle feuille. */
export function splitPane(
  node: PaneNode,
  paneId: string,
  dir: SplitDir,
  newId: string,
): PaneNode {
  if (node.type === "leaf") {
    if (node.paneId !== paneId) return node;
    return { type: "split", dir, ratio: 0.5, a: node, b: leaf(newId) };
  }
  return {
    ...node,
    a: splitPane(node.a, paneId, dir, newId),
    b: splitPane(node.b, paneId, dir, newId),
  };
}

/** Retire une feuille ; le frère remonte. null si c'était la dernière. */
export function removePane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.type === "leaf") {
    return node.paneId === paneId ? null : node;
  }
  const a = removePane(node.a, paneId);
  const b = removePane(node.b, paneId);
  if (a && b) return { ...node, a, b };
  return a ?? b;
}

export function leavesOf(node: PaneNode): string[] {
  if (node.type === "leaf") return [node.paneId];
  return [...leavesOf(node.a), ...leavesOf(node.b)];
}

/** Met à jour le ratio du split désigné par un chemin de 'a'/'b'. */
export function setRatio(node: PaneNode, path: string, ratio: number): PaneNode {
  if (node.type === "leaf") return node;
  if (path === "") return { ...node, ratio };
  const head = path[0];
  const rest = path.slice(1);
  return head === "a"
    ? { ...node, a: setRatio(node.a, rest, ratio) }
    : { ...node, b: setRatio(node.b, rest, ratio) };
}
