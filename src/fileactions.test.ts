import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { baseOf, buildCommand, detectKind, dirOf, shQuote, stemOf } from "./fileactions";

describe("découpage de chemin", () => {
  it("sépare dossier et nom", () => {
    expect(dirOf("/etc/nginx/nginx.conf")).toBe("/etc/nginx");
    expect(baseOf("/etc/nginx/nginx.conf")).toBe("nginx.conf");
  });

  it("gère la racine et les chemins nus", () => {
    expect(dirOf("/fichier")).toBe("/");
    expect(dirOf("fichier")).toBe(".");
    expect(baseOf("fichier")).toBe("fichier");
  });

  it("retire la dernière extension seulement", () => {
    expect(stemOf("web.service")).toBe("web");
    expect(stemOf("mon.app.service")).toBe("mon.app");
    expect(stemOf(".bashrc")).toBe(".bashrc");
    expect(stemOf("sansext")).toBe("sansext");
  });
});

describe("citation shell", () => {
  it("protège espaces et apostrophes", () => {
    expect(shQuote("/tmp/mon dossier")).toBe("'/tmp/mon dossier'");
    expect(shQuote("/tmp/l'été")).toBe(`'/tmp/l'\\''été'`);
  });
});

describe("reconnaissance des types", () => {
  it("repère les fichiers compose sous leurs différents noms", () => {
    for (const n of [
      "docker-compose.yml",
      "docker-compose.yaml",
      "compose.yml",
      "compose.yaml",
      "docker-compose.override.yml",
      "compose.prod.yaml",
    ]) {
      expect(detectKind(`/srv/app/${n}`)?.kind, n).toBe("Docker Compose");
    }
  });

  it("repère un Dockerfile et ses variantes", () => {
    expect(detectKind("/srv/Dockerfile")?.kind).toBe("Dockerfile");
    expect(detectKind("/srv/Dockerfile.prod")?.kind).toBe("Dockerfile");
  });

  it("ne prend un .conf pour nginx que si le contexte le dit", () => {
    expect(detectKind("/etc/nginx/nginx.conf")?.kind).toBe("nginx");
    expect(detectKind("/etc/nginx/conf.d/site.conf")?.kind).toBe("nginx");
    expect(detectKind("/opt/app/nginx.conf")?.kind).toBe("nginx");
    expect(detectKind("/etc/apache2/site.conf")).toBeNull();
  });

  it("distingue package.json d'un JSON quelconque", () => {
    expect(detectKind("/srv/app/package.json")?.kind).toBe("Node");
    expect(detectKind("/srv/app/tsconfig.json")?.kind).toBe("JSON");
  });

  it("ne confond pas un YAML quelconque avec un compose", () => {
    expect(detectKind("/srv/playbook.yml")?.kind).toBe("YAML");
  });

  it("couvre systemd, shell, python et cron", () => {
    expect(detectKind("/etc/systemd/system/web.service")?.kind).toBe("systemd");
    expect(detectKind("/etc/systemd/system/backup.timer")?.kind).toBe("systemd");
    expect(detectKind("/root/deploy.sh")?.kind).toBe("Script shell");
    expect(detectKind("/root/tache.py")?.kind).toBe("Python");
    expect(detectKind("/var/spool/cron/crontab")?.kind).toBe("cron");
  });

  it("reste muet sur les secrets et les fichiers inconnus", () => {
    expect(detectKind("/srv/app/.env")).toBeNull();
    expect(detectKind("/root/.ssh/id_ed25519")).toBeNull();
    expect(detectKind("/srv/notes.txt")).toBeNull();
  });
});

describe("construction des commandes", () => {
  it("cite le chemin du fichier", () => {
    const kind = detectKind("/srv/mon app/docker-compose.yml")!;
    const ps = kind.actions.find((a) => a.mode === "table")!;
    expect(buildCommand(ps, "/srv/mon app/docker-compose.yml")).toBe(
      "docker compose -f '/srv/mon app/docker-compose.yml' ps",
    );
  });

  it("remplit dossier, nom et nom sans extension", () => {
    const node = detectKind("/srv/app/package.json")!;
    expect(buildCommand(node.actions[0], "/srv/app/package.json")).toBe(
      "npm run --prefix '/srv/app'",
    );
    const unit = detectKind("/etc/systemd/system/web.service")!;
    expect(buildCommand(unit.actions[0], "/etc/systemd/system/web.service")).toBe(
      "systemctl status 'web.service' --no-pager",
    );
    expect(buildCommand(unit.actions[1], "/etc/systemd/system/web.service")).toBe(
      "journalctl -u 'web' -n 100 --no-pager",
    );
  });

  it("ne laisse aucun marqueur non remplacé", () => {
    const chemins = [
      "/srv/docker-compose.yml",
      "/srv/Dockerfile",
      "/etc/nginx/nginx.conf",
      "/srv/package.json",
      "/etc/systemd/system/web.service",
      "/root/deploy.sh",
      "/root/t.py",
      "/srv/a.json",
      "/srv/a.yml",
      "/var/spool/cron/crontab",
    ];
    for (const p of chemins) {
      for (const a of detectKind(p)!.actions) {
        expect(buildCommand(a, p), `${p} / ${a.label}`).not.toMatch(/\{[fdbs]\}/);
      }
    }
  });

  it("un vrai shell restitue le chemin à l'identique", () => {
    // Le test décisif : bash -n ne verrait pas une injection (elle est du shell
    // parfaitement valide). Ici on vérifie que le shell rend exactement le
    // chemin donné, donc qu'aucun caractère n'a été interprété.
    const tordus = [
      "/srv/mon app/fichier",
      "/srv/l'ete/fichier",
      "/srv/a;rm -rf b",
      "/etc/nginx/site $(whoami).conf",
      '/srv/app "guillemets"',
      "/etc/systemd/system/web`id`.service",
      "/root/deploy & sleep 9",
      "/srv/a|b",
      "/srv/a\\b",
      "/srv/$HOME/*",
      "/srv/été à l'œuvre",
    ];
    for (const chemin of tordus) {
      const rendu = execFileSync("bash", ["-c", `printf '%s' ${shQuote(chemin)}`], {
        encoding: "utf8",
      });
      expect(rendu, chemin).toBe(chemin);
    }
  });

  it("produit du shell syntaxiquement valide, chemins tordus compris", () => {
    // « bash -n » analyse sans exécuter : un gabarit mal cité échoue ici.
    const tordus = [
      "/srv/mon app/docker-compose.yml",
      "/srv/l'ete/compose.yaml",
      "/srv/a;rm -rf b/Dockerfile",
      "/etc/nginx/site $(whoami).conf",
      '/srv/app "guillemets"/package.json',
      "/etc/systemd/system/web`id`.service",
      "/root/deploy & sleep 9.sh",
      "/srv/a|b.json",
      "/srv/a\\b.yml",
    ];
    for (const chemin of tordus) {
      const kind = detectKind(chemin);
      expect(kind, chemin).not.toBeNull();
      for (const a of kind!.actions) {
        const cmd = buildCommand(a, chemin);
        expect(
          () => execFileSync("bash", ["-n", "-c", cmd], { stdio: "pipe" }),
          `${chemin} / ${a.label} -> ${cmd}`,
        ).not.toThrow();
      }
    }
  });

  it("marque comme écriture les actions qui changent l'état du serveur", () => {
    const c = detectKind("/srv/docker-compose.yml")!;
    expect(c.actions.find((a) => a.label.startsWith("Voir"))!.writes).toBeUndefined();
    expect(c.actions.find((a) => a.label.startsWith("Démarrer"))!.writes).toBe(true);
    expect(c.actions.find((a) => a.label.startsWith("Arrêter"))!.writes).toBe(true);
  });
});
