import { describe, expect, it } from "vitest";
import {
  actionsFor,
  filterContainers,
  formatPort,
  groupByProject,
  isDisruptive,
  parseContainers,
  parseImages,
  parseJsonLines,
  parseLabels,
  parseNetworks,
  parsePercent,
  parsePorts,
  parseStats,
  parseVolumes,
  summarize,
  webUrl,
} from "./docker";

/** Sortie réelle de `docker ps --format '{{json .}}'`. */
const PS = [
  '{"Command":"\\"/docker-entrypoint.…\\"","CreatedAt":"2025-08-20 10:12:33 +0200 CEST","ID":"3f2a1b0c9d8e","Image":"nginx:alpine","Labels":"com.docker.compose.project=monapp,com.docker.compose.service=web,maintainer=NGINX Docker Maintainers","LocalVolumes":"0","Mounts":"","Names":"monapp-web-1","Networks":"monapp_default","Ports":"0.0.0.0:8080-\\u003e80/tcp, :::8080-\\u003e80/tcp","RunningFor":"2 hours ago","Size":"0B","State":"running","Status":"Up 2 hours"}',
  '{"Command":"\\"postgres\\"","CreatedAt":"2025-08-20 10:12:31 +0200 CEST","ID":"aa11bb22cc33","Image":"postgres:16","Labels":"com.docker.compose.project=monapp,com.docker.compose.service=db","LocalVolumes":"1","Mounts":"monapp_db","Names":"monapp-db-1","Networks":"monapp_default","Ports":"5432/tcp","RunningFor":"2 hours ago","Size":"0B","State":"running","Status":"Up 2 hours (healthy)"}',
  '{"Command":"\\"redis-server\\"","CreatedAt":"2025-08-19 09:00:00 +0200 CEST","ID":"dd44ee55ff66","Image":"redis:7","Labels":"","LocalVolumes":"0","Mounts":"","Names":"cache-perso","Networks":"bridge","Ports":"","RunningFor":"1 day ago","Size":"0B","State":"exited","Status":"Exited (0) 3 hours ago"}',
].join("\n");

describe("lecture des lignes JSON", () => {
  it("ignore le bruit et les lignes tronquées", () => {
    const brut = [
      "WARNING: quelque chose",
      '{"ID":"a"}',
      '{"ID":"b"',
      "",
      '   {"ID":"c"}  ',
    ].join("\n");
    expect(parseJsonLines(brut).map((o) => o.ID)).toEqual(["a", "c"]);
  });

  it("rend une liste vide sur une sortie vide", () => {
    expect(parseJsonLines("")).toEqual([]);
    expect(parseContainers("")).toEqual([]);
  });
});

describe("étiquettes", () => {
  it("découpe les paires clé=valeur", () => {
    expect(parseLabels("a=1,b=2")).toEqual({ a: "1", b: "2" });
  });

  it("rattache un fragment sans égal à l'étiquette précédente", () => {
    // Docker n'échappe pas les virgules d'une valeur.
    expect(parseLabels("desc=un, deux, trois,autre=x")).toEqual({
      desc: "un, deux, trois",
      autre: "x",
    });
  });

  it("supporte l'absence d'étiquette", () => {
    expect(parseLabels("")).toEqual({});
    expect(parseLabels(undefined)).toEqual({});
  });
});

describe("ports", () => {
  it("dédoublonne la publication IPv4 et IPv6", () => {
    const p = parsePorts("0.0.0.0:8080->80/tcp, :::8080->80/tcp");
    expect(p).toHaveLength(1);
    expect(p[0]).toEqual({
      hostIp: "0.0.0.0",
      hostPort: 8080,
      containerPort: 80,
      protocol: "tcp",
    });
  });

  it("distingue un port publié d'un port interne", () => {
    expect(parsePorts("5432/tcp")).toEqual([{ containerPort: 5432, protocol: "tcp" }]);
    expect(formatPort({ containerPort: 5432, protocol: "tcp" })).toBe("5432");
    expect(formatPort({ hostPort: 8080, containerPort: 80, protocol: "tcp" })).toBe(
      "8080 → 80",
    );
  });

  it("garde deux publications distinctes du même port conteneur", () => {
    expect(parsePorts("0.0.0.0:8080->80/tcp, 0.0.0.0:9090->80/tcp")).toHaveLength(2);
  });

  it("supporte UDP et l'absence de port", () => {
    expect(parsePorts("0.0.0.0:53->53/udp")[0].protocol).toBe("udp");
    expect(parsePorts("")).toEqual([]);
    expect(parsePorts(undefined)).toEqual([]);
  });

  it("ne propose une adresse web que pour un port TCP publié", () => {
    expect(
      webUrl({ hostPort: 8080, containerPort: 80, protocol: "tcp" }, "localhost"),
    ).toBe("http://localhost:8080");
    expect(webUrl({ hostPort: 8443, containerPort: 443, protocol: "tcp" }, "srv")).toBe(
      "https://srv:8443",
    );
    expect(webUrl({ containerPort: 80, protocol: "tcp" }, "srv")).toBeNull();
    expect(
      webUrl({ hostPort: 53, containerPort: 53, protocol: "udp" }, "srv"),
    ).toBeNull();
  });
});

describe("conteneurs", () => {
  const cs = parseContainers(PS);

  it("lit les champs essentiels", () => {
    expect(cs).toHaveLength(3);
    expect(cs[0].name).toBe("monapp-web-1");
    expect(cs[0].image).toBe("nginx:alpine");
    expect(cs[0].state).toBe("running");
    expect(cs[0].status).toBe("Up 2 hours");
    expect(cs[0].command).toBe("/docker-entrypoint.…");
    expect(cs[0].networks).toEqual(["monapp_default"]);
  });

  it("rattache les conteneurs à leur pile Compose", () => {
    expect(cs[0].project).toBe("monapp");
    expect(cs[0].service).toBe("web");
    expect(cs[2].project).toBeUndefined();
  });

  it("décode les ports au passage", () => {
    expect(cs[0].ports).toEqual([
      { hostIp: "0.0.0.0", hostPort: 8080, containerPort: 80, protocol: "tcp" },
    ]);
    expect(cs[2].ports).toEqual([]);
  });

  it("groupe par pile, les isolés en dernier", () => {
    const g = groupByProject(cs);
    expect(g.map((x) => x.project)).toEqual(["monapp", null]);
    expect(g[0].containers.map((c) => c.service)).toEqual(["db", "web"]);
    expect(g[1].containers.map((c) => c.name)).toEqual(["cache-perso"]);
  });

  it("résume l'ensemble", () => {
    expect(summarize(cs)).toEqual({
      total: 3,
      running: 2,
      stopped: 1,
      paused: 0,
      projects: 1,
    });
  });

  it("filtre sur le nom, l'image, la pile et les ports", () => {
    expect(filterContainers(cs, "nginx").map((c) => c.name)).toEqual(["monapp-web-1"]);
    expect(filterContainers(cs, "8080").map((c) => c.name)).toEqual(["monapp-web-1"]);
    expect(filterContainers(cs, "monapp")).toHaveLength(2);
    expect(filterContainers(cs, "  ")).toHaveLength(3);
    expect(filterContainers(cs, "introuvable")).toHaveLength(0);
  });
});

describe("actions selon l'état", () => {
  it("propose d'arrêter ce qui tourne, de démarrer ce qui est éteint", () => {
    expect(actionsFor("running")).toEqual(["stop", "restart", "pause", "kill"]);
    expect(actionsFor("exited")).toEqual(["start", "rm"]);
    expect(actionsFor("paused")).toEqual(["unpause", "stop", "kill"]);
    expect(actionsFor("created")).toEqual(["start", "rm"]);
  });

  it("marque les actions qui coupent un service", () => {
    expect(isDisruptive("stop")).toBe(true);
    expect(isDisruptive("kill")).toBe(true);
    expect(isDisruptive("rm")).toBe(true);
    expect(isDisruptive("restart")).toBe(true);
    expect(isDisruptive("start")).toBe(false);
    expect(isDisruptive("pause")).toBe(false);
  });
});

describe("mesures", () => {
  const STATS = [
    '{"BlockIO":"0B / 0B","CPUPerc":"0.42%","Container":"3f2a1b0c9d8e","ID":"3f2a1b0c9d8e","MemPerc":"0.28%","MemUsage":"21.8MiB / 7.653GiB","Name":"monapp-web-1","NetIO":"1.2kB / 0B","PIDs":"5"}',
    '{"BlockIO":"8.19kB / 0B","CPUPerc":"12,50%","Container":"aa11bb22cc33","ID":"aa11bb22cc33","MemPerc":"3.10%","MemUsage":"243MiB / 7.653GiB","Name":"monapp-db-1","NetIO":"0B / 0B","PIDs":"9"}',
  ].join("\n");

  it("convertit les pourcentages, virgule comprise", () => {
    const s = parseStats(STATS);
    expect(s[0].cpu).toBeCloseTo(0.42);
    expect(s[1].cpu).toBeCloseTo(12.5);
    expect(s[0].pids).toBe(5);
    expect(s[0].memUsage).toBe("21.8MiB / 7.653GiB");
  });

  it("ne casse pas sur une valeur illisible", () => {
    expect(parsePercent("--")).toBe(0);
    expect(parsePercent(undefined)).toBe(0);
  });
});

describe("images, volumes et réseaux", () => {
  it("repère les images orphelines et convertit leur taille", () => {
    const txt = [
      '{"Containers":"N/A","CreatedSince":"3 weeks ago","ID":"sha256:abc123def456789","Repository":"nginx","Size":"48.2MB","Tag":"alpine"}',
      '{"Containers":"N/A","CreatedSince":"2 days ago","ID":"sha256:999","Repository":"\\u003cnone\\u003e","Size":"1.1GB","Tag":"\\u003cnone\\u003e"}',
    ].join("\n");
    const im = parseImages(txt);
    expect(im[0].id).toBe("abc123def456");
    expect(im[0].dangling).toBe(false);
    expect(im[1].dangling).toBe(true);
    expect(im[1].sizeBytes).toBeGreaterThan(im[0].sizeBytes);
  });

  it("rattache volumes et réseaux à leur pile", () => {
    const v = parseVolumes(
      '{"Driver":"local","Labels":"com.docker.compose.project=monapp","Mountpoint":"/var/lib/docker/volumes/monapp_db/_data","Name":"monapp_db","Scope":"local"}',
    );
    expect(v[0].project).toBe("monapp");
    const n = parseNetworks(
      '{"Driver":"bridge","ID":"0123456789abcdef","Labels":"com.docker.compose.project=monapp","Name":"monapp_default","Scope":"local"}',
    );
    expect(n[0].id).toBe("0123456789ab");
    expect(n[0].project).toBe("monapp");
  });
});

describe("construction des commandes", () => {
  it("demande du JSON pour chaque liste", async () => {
    const m = await import("./docker");
    for (const args of [
      m.psArgs(false),
      m.statsArgs(),
      m.imagesArgs(),
      m.volumesArgs(),
      m.networksArgs(),
    ]) {
      expect(args).toContain("--format");
      expect(args).toContain("{{json .}}");
    }
    expect(m.psArgs(true)).toContain("-a");
    expect(m.psArgs(false)).not.toContain("-a");
  });

  it("borne le nombre de lignes de journal demandé", async () => {
    const { logsArgs } = await import("./docker");
    expect(logsArgs("abc", 100)).toEqual([
      "logs",
      "--tail",
      "100",
      "--timestamps",
      "abc",
    ]);
    expect(logsArgs("abc", 99999)[2]).toBe("5000");
    expect(logsArgs("abc", 0)[2]).toBe("1");
  });

  it("force la suppression, jamais le reste", async () => {
    const { actionArgs } = await import("./docker");
    expect(actionArgs("rm", "abc")).toEqual(["rm", "-f", "abc"]);
    expect(actionArgs("stop", "abc")).toEqual(["stop", "abc"]);
    expect(actionArgs("start", "abc")).toEqual(["start", "abc"]);
  });

  it("cite le conteneur dans la commande d'entrée", async () => {
    const { execCommand } = await import("./docker");
    expect(execCommand("mon app")).toContain("'mon app'");
    expect(execCommand("l'appli")).toContain(`'l'\\''appli'`);
  });
});

describe("volumes lisibles", () => {
  it("repère un volume anonyme à son nom", async () => {
    const m = await import("./docker");
    const anon = "a".repeat(64);
    expect(m.isAnonymousVolume(anon)).toBe(true);
    expect(m.isAnonymousVolume("monapp_db")).toBe(false);
    expect(m.isAnonymousVolume("a".repeat(63))).toBe(false);
    expect(m.volumeLabel(anon)).toBe("(anonyme) aaaaaaaaaaaa");
    expect(m.volumeLabel("monapp_db")).toBe("monapp_db");
  });

  it("rattache les volumes aux conteneurs qui les montent", async () => {
    const m = await import("./docker");
    const cs = m.parseContainers(
      [
        '{"ID":"1","Names":"web","Image":"nginx","State":"running","Status":"Up","Mounts":"monapp_db,logs"}',
        '{"ID":"2","Names":"worker","Image":"app","State":"running","Status":"Up","Mounts":"monapp_db"}',
      ].join("\n"),
    );
    const vs = m.parseVolumes(
      [
        '{"Name":"monapp_db","Driver":"local"}',
        '{"Name":"orphelin","Driver":"local"}',
      ].join("\n"),
    );
    const avec = m.attachVolumeUsage(vs, cs);
    expect(avec[0].usedBy).toEqual(["web", "worker"]);
    expect(avec[1].usedBy).toEqual([]);
  });

  it("montre les volumes nommés avant les anonymes", async () => {
    const m = await import("./docker");
    const noms = ["z_nomme", "b".repeat(64), "a_nomme"].map((name) => ({
      name,
      driver: "local",
      mountpoint: "",
      labels: {},
    }));
    expect(m.sortVolumes(noms).map((v) => v.name.slice(0, 8))).toEqual([
      "a_nomme",
      "z_nomme",
      "bbbbbbbb",
    ]);
  });
});

describe("lecture des journaux", () => {
  it("détache l'horodatage de Docker", async () => {
    const { parseLogLines } = await import("./docker");
    const l = parseLogLines("2025-08-28T09:12:01.221Z serveur démarré")[0];
    expect(l.time).toBe("2025-08-28T09:12:01.221Z");
    expect(l.text).toBe("serveur démarré");
  });

  it("laisse intacte une ligne sans horodatage", async () => {
    const { parseLogLines } = await import("./docker");
    const l = parseLogLines("2025 est une année")[0];
    expect(l.time).toBeNull();
    expect(l.text).toBe("2025 est une année");
  });

  it("détecte le niveau, en français comme en anglais", async () => {
    const { parseLogLines } = await import("./docker");
    const niveaux = parseLogLines(
      [
        "[error] échec du webhook",
        "[warn] latence élevée",
        "[info] serveur démarré",
        "[debug] trace interne",
        "une ligne quelconque",
        "connexion refusée : erreur réseau",
      ].join("\n"),
    ).map((l) => l.level);
    expect(niveaux).toEqual(["error", "warn", "info", "debug", null, "error"]);
  });

  it("donne la priorité au niveau le plus grave", async () => {
    const { parseLogLines } = await import("./docker");
    expect(parseLogLines("[info] error lors du traitement")[0].level).toBe("error");
  });
});

describe("piles Compose", () => {
  const avecLabels = (labels: string) =>
    `{"ID":"1","Names":"web","Image":"nginx","State":"running","Status":"Up","Labels":"${labels}"}`;

  it("retrouve nom, fichiers et dossier de la pile", async () => {
    const m = await import("./docker");
    const cs = m.parseContainers(
      avecLabels(
        "com.docker.compose.project=monapp,com.docker.compose.project.config_files=/srv/monapp/docker-compose.yml,com.docker.compose.project.working_dir=/srv/monapp",
      ),
    );
    expect(m.composeProjectOf(cs)).toEqual({
      name: "monapp",
      configFiles: ["/srv/monapp/docker-compose.yml"],
      workingDir: "/srv/monapp",
    });
  });

  it("gère plusieurs fichiers de surcharge", async () => {
    const m = await import("./docker");
    const cs = m.parseContainers(
      avecLabels(
        "com.docker.compose.project=monapp,com.docker.compose.project.config_files=/srv/a.yml,/srv/b.yml",
      ),
    );
    expect(m.composeProjectOf(cs)?.configFiles).toEqual(["/srv/a.yml", "/srv/b.yml"]);
  });

  it("ne rend rien sans les étiquettes de Compose", async () => {
    const m = await import("./docker");
    expect(m.composeProjectOf(m.parseContainers(avecLabels("")))).toBeNull();
    // Une pile connue de nom mais sans fichier n'est pas pilotable.
    expect(
      m.composeProjectOf(
        m.parseContainers(avecLabels("com.docker.compose.project=monapp")),
      ),
    ).toBeNull();
  });

  it("se rabat sur un conteneur qui porte l'information", async () => {
    const m = await import("./docker");
    const cs = m.parseContainers(
      [
        avecLabels("com.docker.compose.project=monapp"),
        avecLabels(
          "com.docker.compose.project=monapp,com.docker.compose.project.config_files=/srv/c.yml",
        ),
      ].join("\n"),
    );
    expect(m.composeProjectOf(cs)?.configFiles).toEqual(["/srv/c.yml"]);
  });

  it("nomme la pile explicitement dans la commande", async () => {
    const m = await import("./docker");
    const p = {
      name: "monapp",
      configFiles: ["/srv/a.yml", "/srv/b.yml"],
      workingDir: "/srv",
    };
    expect(m.composeArgs(p, "up")).toEqual([
      "compose",
      "-p",
      "monapp",
      "--project-directory",
      "/srv",
      "-f",
      "/srv/a.yml",
      "-f",
      "/srv/b.yml",
      "up",
      "-d",
    ]);
    expect(m.composeArgs(p, "down")).toContain("down");
    expect(m.composeArgs(p, "down")).not.toContain("-d");
  });

  it("omet le dossier quand Compose ne l'a pas indiqué", async () => {
    const m = await import("./docker");
    const args = m.composeArgs({ name: "x", configFiles: ["/a.yml"] }, "restart");
    expect(args).not.toContain("--project-directory");
    expect(args.slice(0, 3)).toEqual(["compose", "-p", "x"]);
  });

  it("marque les actions qui coupent la pile", async () => {
    const m = await import("./docker");
    expect(m.isComposeDisruptive("down")).toBe(true);
    expect(m.isComposeDisruptive("restart")).toBe(true);
    expect(m.isComposeDisruptive("up")).toBe(false);
    expect(m.isComposeDisruptive("pull")).toBe(false);
  });
});

describe("nettoyage", () => {
  it("cible la bonne catégorie", async () => {
    const m = await import("./docker");
    expect(m.pruneArgs("images")).toEqual(["image", "prune", "-f"]);
    expect(m.pruneArgs("volumes")).toEqual(["volume", "prune", "-f"]);
    expect(m.pruneArgs("networks")).toEqual(["network", "prune", "-f"]);
  });

  it("annonce ce qui partirait, avant d'agir", async () => {
    const m = await import("./docker");
    const data = {
      images: [
        {
          id: "a",
          repository: "<none>",
          tag: "<none>",
          size: "1GB",
          sizeBytes: 1024 ** 3,
          createdSince: "",
          dangling: true,
        },
        {
          id: "b",
          repository: "nginx",
          tag: "alpine",
          size: "48MB",
          sizeBytes: 48 * 1024 ** 2,
          createdSince: "",
          dangling: false,
        },
      ],
      volumes: [
        { name: "utilise", driver: "local", mountpoint: "", labels: {}, usedBy: ["web"] },
        { name: "libre", driver: "local", mountpoint: "", labels: {}, usedBy: [] },
      ],
      networks: [
        { id: "1", name: "bridge", driver: "bridge", scope: "local", labels: {} },
        { id: "2", name: "monapp_default", driver: "bridge", scope: "local", labels: {} },
      ],
    };
    expect(m.pruneImpact("images", data)).toEqual({
      count: 1,
      detail: "1 image(s), 1.0 Go libérés",
    });
    expect(m.pruneImpact("volumes", data).count).toBe(1);
    // bridge, host et none ne sont jamais retirés.
    expect(m.pruneImpact("networks", data).count).toBe(1);
  });

  it("le dit quand il n'y a rien à retirer", async () => {
    const m = await import("./docker");
    const vide = { images: [], volumes: [], networks: [] };
    for (const k of ["images", "volumes", "networks"] as const) {
      expect(m.pruneImpact(k, vide)).toEqual({ count: 0, detail: "rien à retirer" });
    }
  });

  it("met les tailles en unités lisibles", async () => {
    const { humanSize } = await import("./docker");
    expect(humanSize(0)).toBe("0 o");
    expect(humanSize(512)).toBe("512 o");
    expect(humanSize(1024)).toBe("1.0 Ko");
    expect(humanSize(1024 ** 3 * 2.5)).toBe("2.5 Go");
    expect(humanSize(NaN)).toBe("0 o");
  });
});
