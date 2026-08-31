import { describe, expect, it } from "vitest";
import { parseJsonTree, parseYamlTree, toTree } from "./tree";

describe("arbre JSON", () => {
  it("décrit objets, listes et scalaires", () => {
    const t = toTree({ nom: "web", ports: [80, 443], actif: true, vide: null });
    expect(t.type).toBe("objet");
    const keys = t.children!.map((c) => c.key);
    expect(keys).toEqual(["nom", "ports", "actif", "vide"]);
    const ports = t.children!.find((c) => c.key === "ports")!;
    expect(ports.type).toBe("liste");
    expect(ports.children!.map((c) => c.value)).toEqual(["80", "443"]);
    expect(t.children!.find((c) => c.key === "actif")!.value).toBe("vrai");
    expect(t.children!.find((c) => c.key === "vide")!.type).toBe("vide");
  });

  it("annonce le nombre d'éléments", () => {
    expect(toTree({ a: 1, b: 2 }).value).toBe("2 clés");
    expect(toTree([1]).value).toBe("1 élément");
  });

  it("signale un JSON invalide sans lever d'exception", () => {
    const r = parseJsonTree("{ceci n'est pas du json");
    expect(typeof r).toBe("string");
    expect(r as string).toMatch(/JSON invalide/);
  });

  it("analyse un JSON valide", () => {
    const r = parseJsonTree('{"a": {"b": 1}}');
    expect(typeof r).toBe("object");
  });
});

describe("arbre YAML", () => {
  it("gère l'imbrication par indentation", () => {
    const yaml = [
      "services:",
      "  web:",
      "    image: nginx:1.27",
      "    ports:",
      "      - 80:80",
      "      - 443:443",
      "  api:",
      "    image: node:20",
    ].join("\n");
    const t = parseYamlTree(yaml);
    if (typeof t === "string") throw new Error(t);
    const services = t.children!.find((c) => c.key === "services")!;
    expect(services.children!.map((c) => c.key)).toEqual(["web", "api"]);
    const web = services.children![0];
    expect(web.children!.find((c) => c.key === "image")!.value).toBe("nginx:1.27");
    const ports = web.children!.find((c) => c.key === "ports")!;
    expect(ports.children!.map((c) => c.value)).toEqual(["80:80", "443:443"]);
  });

  it("ignore commentaires et séparateurs", () => {
    const t = parseYamlTree("# entête\n---\ncle: valeur\n");
    if (typeof t === "string") throw new Error(t);
    expect(t.children!.map((c) => c.key)).toEqual(["cle"]);
  });

  it("reconnaît nombres et booléens", () => {
    const t = parseYamlTree("port: 8080\nactif: true\nnom: web\n");
    if (typeof t === "string") throw new Error(t);
    const byKey = (k: string) => t.children!.find((c) => c.key === k)!;
    expect(byKey("port").type).toBe("nombre");
    expect(byKey("actif").type).toBe("booléen");
    expect(byKey("nom").type).toBe("texte");
  });

  it("retire les guillemets des valeurs", () => {
    const t = parseYamlTree('nom: "web front"\n');
    if (typeof t === "string") throw new Error(t);
    expect(t.children![0].value).toBe("web front");
  });

  it("signale un contenu vide", () => {
    expect(parseYamlTree("")).toMatch(/vide/);
    expect(parseYamlTree("# rien que des commentaires\n")).toMatch(/vide/);
  });
});
