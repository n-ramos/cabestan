export interface TreeNode {
  key: string;
  /** Valeur affichée pour une feuille. */
  value?: string;
  /** Type, pour la coloration. */
  type: "objet" | "liste" | "texte" | "nombre" | "booléen" | "vide";
  children?: TreeNode[];
}

/** Construit un arbre affichable depuis une valeur JSON déjà analysée. */
export function toTree(value: unknown, key = "racine"): TreeNode {
  if (value === null || value === undefined) {
    return { key, type: "vide", value: "null" };
  }
  if (Array.isArray(value)) {
    return {
      key,
      type: "liste",
      value: `${value.length} élément${value.length > 1 ? "s" : ""}`,
      children: value.map((v, i) => toTree(v, String(i))),
    };
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return {
      key,
      type: "objet",
      value: `${entries.length} clé${entries.length > 1 ? "s" : ""}`,
      children: entries.map(([k, v]) => toTree(v, k)),
    };
  }
  if (typeof value === "number") return { key, type: "nombre", value: String(value) };
  if (typeof value === "boolean") {
    return { key, type: "booléen", value: value ? "vrai" : "faux" };
  }
  return { key, type: "texte", value: String(value) };
}

/** Analyse du JSON ; renvoie l'arbre ou un message d'erreur. */
export function parseJsonTree(text: string): TreeNode | string {
  try {
    return toTree(JSON.parse(text));
  } catch (e) {
    return `JSON invalide : ${e instanceof Error ? e.message : String(e)}`;
  }
}

/**
 * Analyse d'un YAML simple (indentation à espaces, clés, listes, valeurs
 * scalaires). Suffisant pour lire un docker-compose ou une config ; ne gère
 * pas les ancres, blocs multi-lignes et flux JSON en ligne.
 */
export function parseYamlTree(text: string): TreeNode | string {
  interface Frame {
    indent: number;
    node: TreeNode;
  }
  const root: TreeNode = { key: "racine", type: "objet", children: [] };
  const stack: Frame[] = [{ indent: -1, node: root }];

  const lines = text.split("\n");
  for (const raw of lines) {
    const noComment = raw.replace(/\s+#.*$/, "");
    if (noComment.trim() === "" || noComment.trim() === "---") continue;
    const indent = noComment.length - noComment.trimStart().length;
    const line = noComment.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const parent = stack[stack.length - 1].node;
    parent.children ??= [];

    // Élément de liste
    if (line.startsWith("- ") || line === "-") {
      const rest = line.slice(1).trim();
      const idx = String(parent.children.length);
      if (parent.type !== "liste") parent.type = "liste";
      // Paire clé/valeur seulement si la clé est un identifiant suivi d'un
      // espace : « - image: nginx » oui, « - 80:80 » non (c'est un scalaire).
      const pair = rest.match(/^([A-Za-z_][\w.-]*):(?:\s+(.*))?$/);
      if (pair) {
        const node: TreeNode = { key: idx, type: "objet", children: [] };
        parent.children.push(node);
        stack.push({ indent, node });
        const val = (pair[2] ?? "").trim();
        node.children!.push(
          val === ""
            ? { key: pair[1], type: "objet", children: [] }
            : { key: pair[1], type: "texte", value: val.replace(/^["']|["']$/g, "") },
        );
      } else {
        parent.children.push({
          key: idx,
          type: "texte",
          value: rest.replace(/^["']|["']$/g, ""),
        });
      }
      continue;
    }

    // Paire clé / valeur
    const sep = line.indexOf(":");
    if (sep < 0) continue;
    const k = line.slice(0, sep).trim();
    const v = line.slice(sep + 1).trim();
    if (v === "") {
      const node: TreeNode = { key: k, type: "objet", children: [] };
      parent.children.push(node);
      stack.push({ indent, node });
    } else {
      const numeric = /^-?\d+(\.\d+)?$/.test(v);
      const bool = /^(true|false|yes|no)$/i.test(v);
      parent.children.push({
        key: k,
        type: numeric ? "nombre" : bool ? "booléen" : "texte",
        value: v.replace(/^["']|["']$/g, ""),
      });
    }
  }

  if (!root.children || root.children.length === 0) {
    return "YAML vide ou non reconnu.";
  }
  root.value = `${root.children.length} clé${root.children.length > 1 ? "s" : ""}`;
  return root;
}
