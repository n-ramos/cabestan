import { describe, expect, it } from "vitest";
import {
  filterRows,
  findRecipe,
  parseAligned,
  parseTabs,
  sizeToNumber,
  cleanCaptured,
  looksTabular,
  sortRows,
  stripAnsi,
  toTsv,
} from "./tabulate";

describe("reconnaissance de commande", () => {
  it("reconnaît les commandes courantes", () => {
    expect(findRecipe("docker ps")?.id).toBe("docker-ps");
    expect(findRecipe("  docker ps -a  ")?.id).toBe("docker-ps");
    expect(findRecipe("docker images")?.id).toBe("docker-images");
    expect(findRecipe("df -h")?.id).toBe("df");
    expect(findRecipe("systemctl status nginx")?.id).toBe("systemctl");
    expect(findRecipe("ss -tlnp")?.id).toBe("ss");
  });

  it("ne confond pas une commande voisine", () => {
    expect(findRecipe("dockerd")).toBeNull();
    expect(findRecipe("psql")).toBeNull();
    expect(findRecipe("lsblk")).toBeNull();
    expect(findRecipe("echo docker ps")).toBeNull();
  });

  it("renvoie null pour l'inconnu", () => {
    expect(findRecipe("mon-script-maison --tout")).toBeNull();
    expect(findRecipe("")).toBeNull();
  });
});

describe("découpage par tabulations", () => {
  const headers = ["Nom", "État", "Image"];

  it("découpe et nettoie chaque cellule", () => {
    const t = parseTabs("web\trunning\tnginx:latest\napi\texited\tnode:20\n", headers);
    expect(t.rows).toEqual([
      ["web", "running", "nginx:latest"],
      ["api", "exited", "node:20"],
    ]);
  });

  it("complète les lignes trop courtes", () => {
    const t = parseTabs("web\trunning\n", headers);
    expect(t.rows[0]).toEqual(["web", "running", ""]);
  });

  it("tronque les lignes trop longues", () => {
    const t = parseTabs("a\tb\tc\td\te\n", headers);
    expect(t.rows[0]).toHaveLength(3);
  });

  it("ignore les lignes vides et les retours Windows", () => {
    const t = parseTabs("web\trunning\tnginx\r\n\n\n", headers);
    expect(t.rows).toHaveLength(1);
    expect(t.rows[0][2]).toBe("nginx");
  });
});

describe("découpage d'une sortie alignée", () => {
  it("utilise la première ligne comme en-tête quand c'est plausible", () => {
    const text = [
      "CONTAINER ID   IMAGE          STATUS",
      "abc123         nginx:latest   Up 3 hours",
      "def456         node:20        Exited (0)",
    ].join("\n");
    const t = parseAligned(text);
    expect(t.headers).toEqual(["CONTAINER ID", "IMAGE", "STATUS"]);
    expect(t.rows).toHaveLength(2);
    expect(t.rows[0][2]).toBe("Up 3 hours");
  });

  it("génère des en-têtes neutres quand la première ligne est une donnée", () => {
    const t = parseAligned("12  34  56\n78  90  12");
    expect(t.headers).toEqual(["Colonne 1", "Colonne 2", "Colonne 3"]);
    expect(t.rows).toHaveLength(2);
  });

  it("reste rectangulaire malgré des lignes inégales", () => {
    const t = parseAligned("A  B  C\n1  2\n3  4  5  6");
    const widths = new Set(t.rows.map((r) => r.length));
    expect(widths.size).toBe(1);
    expect(t.headers).toHaveLength([...widths][0]);
  });

  it("gère une sortie vide", () => {
    expect(parseAligned("")).toEqual({ headers: [], rows: [] });
    expect(parseAligned("   \n\n")).toEqual({ headers: [], rows: [] });
  });
});

describe("tailles et tri", () => {
  it("compare des tailles lisibles", () => {
    expect(sizeToNumber("1K")).toBe(1024);
    expect(sizeToNumber("2M")).toBe(2 * 1024 ** 2);
    expect(sizeToNumber("1.5G")).toBe(1.5 * 1024 ** 3);
    expect(sizeToNumber("93%")).toBe(93);
    expect(sizeToNumber("42")).toBe(42);
  });

  it("place les valeurs illisibles en dernier", () => {
    expect(sizeToNumber("n/a")).toBe(Number.NEGATIVE_INFINITY);
  });

  it("trie par taille et non par texte", () => {
    const rows = [
      ["a", "900M"],
      ["b", "1.5G"],
      ["c", "2K"],
    ];
    const sorted = sortRows(rows, 1, false, true);
    expect(sorted.map((r) => r[0])).toEqual(["b", "a", "c"]);
  });

  it("trie du texte en tenant compte des nombres", () => {
    const rows = [["fichier-10"], ["fichier-2"], ["fichier-1"]];
    expect(sortRows(rows, 0, true, false).map((r) => r[0])).toEqual([
      "fichier-1",
      "fichier-2",
      "fichier-10",
    ]);
  });
});

describe("filtre et copie", () => {
  const rows = [
    ["web", "running", "nginx"],
    ["api", "exited", "node"],
  ];

  it("filtre sur n'importe quelle colonne, sans casse", () => {
    expect(filterRows(rows, "NGINX")).toHaveLength(1);
    expect(filterRows(rows, "exit")).toHaveLength(1);
    expect(filterRows(rows, "")).toHaveLength(2);
    expect(filterRows(rows, "zzz")).toHaveLength(0);
  });

  it("exporte en colonnes tabulées, en-tête compris", () => {
    const tsv = toTsv({ headers: ["A", "B", "C"], rows });
    expect(tsv.split("\n")[0]).toBe("A\tB\tC");
    expect(tsv.split("\n")).toHaveLength(3);
  });
});

const ESC = "\u001b";
const BEL = "\u0007";

describe("nettoyage d'une sortie capturée", () => {
  it("retire les couleurs et les séquences de contrôle", () => {
    const raw = `${ESC}[32mweb${ESC}[0m\trunning${ESC}[K`;
    expect(stripAnsi(raw)).toBe("web\trunning");
  });

  it("retire les séquences OSC (titre de fenêtre)", () => {
    expect(stripAnsi(`${ESC}]0;marin@serveur${BEL}prêt`)).toBe("prêt");
  });

  it("écarte l'écho de la commande et l'invite finale", () => {
    const captured = [
      "marin@serveur:~$ docker ps",
      "web       running",
      "api       exited",
      "marin@serveur:~$ ",
    ].join("\n");
    expect(cleanCaptured(captured, "docker ps").split("\n")).toEqual([
      "web       running",
      "api       exited",
    ]);
  });

  it("fonctionne même sans écho détecté", () => {
    expect(cleanCaptured("a  b\nc  d", "commande-absente")).toBe("a  b\nc  d");
  });

  it("reconnaît une sortie tabulaire", () => {
    expect(looksTabular("web    running\napi    exited")).toBe(true);
    expect(looksTabular("web\trunning\napi\texited")).toBe(true);
  });

  it("écarte une sortie non tabulaire", () => {
    expect(looksTabular("bonjour")).toBe(false);
    expect(looksTabular("une seule ligne  avec colonnes")).toBe(false);
    expect(looksTabular("texte simple\nautre ligne")).toBe(false);
  });
});
