/**
 * Décodage de la sortie du client Docker.
 *
 * Le backend n'exécute que `docker … --format '{{json .}}'` et rend le texte
 * tel quel : une ligne JSON par objet. Tout le travail d'interprétation est
 * ici, où il se teste sans démon Docker ni serveur.
 *
 * Les champs de Docker sont tous des chaînes, y compris les nombres et les
 * pourcentages ; les convertir est donc une étape à part entière.
 */

import { sizeToNumber } from "./tabulate";

export interface Container {
  id: string;
  name: string;
  image: string;
  /** running · exited · paused · created · restarting · dead */
  state: string;
  /** Texte lisible : « Up 2 hours », « Exited (0) 3 minutes ago ». */
  status: string;
  ports: PortMap[];
  runningFor: string;
  command: string;
  networks: string[];
  /** Volumes montés, tels que listés par `docker ps`. */
  mounts: string[];
  labels: Record<string, string>;
  /** Pile Compose d'appartenance, si le conteneur en fait partie. */
  project?: string;
  service?: string;
}

export interface PortMap {
  hostIp?: string;
  hostPort?: number;
  containerPort: number;
  protocol: string;
}

export interface Stat {
  id: string;
  name: string;
  /** Pourcentage de CPU, 100 = un cœur saturé. */
  cpu: number;
  memPercent: number;
  memUsage: string;
  netIO: string;
  blockIO: string;
  pids: number;
}

export interface DockerImage {
  id: string;
  repository: string;
  tag: string;
  size: string;
  sizeBytes: number;
  createdSince: string;
  dangling: boolean;
}

export interface Volume {
  name: string;
  driver: string;
  mountpoint: string;
  labels: Record<string, string>;
  project?: string;
  /** Conteneurs qui montent ce volume, renseigné par `attachVolumeUsage`. */
  usedBy?: string[];
}

export interface Network {
  id: string;
  name: string;
  driver: string;
  scope: string;
  labels: Record<string, string>;
  project?: string;
}

/** Découpe une sortie JSON-par-ligne en objets, en ignorant les lignes cassées. */
export function parseJsonLines(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const o = JSON.parse(t);
      if (o && typeof o === "object") out.push(o);
    } catch {
      // Ligne tronquée (sortie coupée par la limite de taille) : on la laisse.
    }
  }
  return out;
}

/**
 * Décode la liste d'étiquettes de Docker : « k=v,k2=v2 ».
 *
 * Docker n'échappe pas les virgules contenues dans une valeur ; le découpage
 * est donc au mieux approximatif. On rattache un fragment sans « = » à
 * l'étiquette précédente plutôt que de le perdre.
 */
export function parseLabels(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  let last = "";
  for (const part of raw.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) {
      last = part.slice(0, i);
      out[last] = part.slice(i + 1);
    } else if (last) {
      out[last] += `,${part}`;
    }
  }
  return out;
}

/**
 * Décode la colonne des ports : « 0.0.0.0:8080->80/tcp, :::8080->80/tcp ».
 *
 * Docker publie souvent deux fois le même port, en IPv4 puis en IPv6 : on ne
 * garde qu'une entrée par couple (port hôte, port conteneur).
 */
export function parsePorts(raw: string | undefined): PortMap[] {
  if (!raw?.trim()) return [];
  const vus = new Set<string>();
  const out: PortMap[] = [];
  for (const part of raw.split(",")) {
    const t = part.trim();
    if (!t) continue;
    const publie = t.match(/^(.*):(\d+)->(\d+)\/(\w+)$/);
    const interne = t.match(/^(\d+)\/(\w+)$/);
    let p: PortMap | null = null;
    if (publie) {
      p = {
        hostIp: publie[1],
        hostPort: Number(publie[2]),
        containerPort: Number(publie[3]),
        protocol: publie[4],
      };
    } else if (interne) {
      p = { containerPort: Number(interne[1]), protocol: interne[2] };
    }
    if (!p) continue;
    const cle = `${p.hostPort ?? ""}:${p.containerPort}/${p.protocol}`;
    if (vus.has(cle)) continue;
    vus.add(cle);
    out.push(p);
  }
  return out;
}

/** Forme lisible d'un port : « 8080 → 80 » ou « 5432 » pour un port interne. */
export function formatPort(p: PortMap): string {
  return p.hostPort ? `${p.hostPort} → ${p.containerPort}` : `${p.containerPort}`;
}

/** L'adresse à ouvrir dans un navigateur, si le port est publié et paraît web. */
export function webUrl(p: PortMap, host: string): string | null {
  if (!p.hostPort || p.protocol !== "tcp") return null;
  const scheme = p.containerPort === 443 || p.hostPort === 443 ? "https" : "http";
  return `${scheme}://${host}:${p.hostPort}`;
}

export function parseContainers(text: string): Container[] {
  return parseJsonLines(text).map((o) => {
    const labels = parseLabels(o.Labels);
    return {
      id: o.ID ?? "",
      // Un conteneur peut porter plusieurs noms ; le premier est le principal.
      name: (o.Names ?? "").split(",")[0],
      image: o.Image ?? "",
      state: (o.State ?? "").toLowerCase(),
      status: o.Status ?? "",
      ports: parsePorts(o.Ports),
      runningFor: o.RunningFor ?? "",
      command: (o.Command ?? "").replace(/^"|"$/g, ""),
      networks: (o.Networks ?? "").split(",").filter(Boolean),
      mounts: (o.Mounts ?? "").split(",").filter(Boolean),
      labels,
      project: labels["com.docker.compose.project"] || undefined,
      service: labels["com.docker.compose.service"] || undefined,
    };
  });
}

/** Convertit « 12.34% » en 12.34 ; rend 0 sur une valeur illisible. */
export function parsePercent(raw: string | undefined): number {
  const n = parseFloat((raw ?? "").replace("%", "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

export function parseStats(text: string): Stat[] {
  return parseJsonLines(text).map((o) => ({
    id: o.ID ?? o.Container ?? "",
    name: o.Name ?? "",
    cpu: parsePercent(o.CPUPerc),
    memPercent: parsePercent(o.MemPerc),
    memUsage: o.MemUsage ?? "",
    netIO: o.NetIO ?? "",
    blockIO: o.BlockIO ?? "",
    pids: parseInt(o.PIDs ?? "0", 10) || 0,
  }));
}

export function parseImages(text: string): DockerImage[] {
  return parseJsonLines(text).map((o) => ({
    id: (o.ID ?? "").replace(/^sha256:/, "").slice(0, 12),
    repository: o.Repository ?? "",
    tag: o.Tag ?? "",
    size: o.Size ?? "",
    sizeBytes: sizeToNumber(o.Size ?? ""),
    createdSince: o.CreatedSince ?? "",
    dangling: (o.Repository ?? "") === "<none>" || (o.Tag ?? "") === "<none>",
  }));
}

/**
 * Un volume anonyme est nommé d'après son propre identifiant : l'afficher tel
 * quel remplit la colonne de 64 caractères illisibles.
 */
export function isAnonymousVolume(name: string): boolean {
  return /^[0-9a-f]{64}$/.test(name);
}

/** Nom présentable : les volumes anonymes sont abrégés et annoncés comme tels. */
export function volumeLabel(name: string): string {
  return isAnonymousVolume(name) ? `(anonyme) ${name.slice(0, 12)}` : name;
}

/**
 * Rattache chaque volume aux conteneurs qui le montent, d'après la colonne
 * `Mounts` de `docker ps` : c'est ce qui rend un volume anonyme identifiable.
 */
export function attachVolumeUsage(volumes: Volume[], containers: Container[]): Volume[] {
  const usage = new Map<string, string[]>();
  for (const c of containers) {
    for (const m of c.mounts) {
      const l = usage.get(m);
      if (l) l.push(c.name);
      else usage.set(m, [c.name]);
    }
  }
  return volumes.map((v) => ({ ...v, usedBy: usage.get(v.name) ?? [] }));
}

/** Volumes nommés d'abord, anonymes ensuite, chaque groupe par ordre alphabétique. */
export function sortVolumes(volumes: Volume[]): Volume[] {
  return [...volumes].sort((a, b) => {
    const aa = isAnonymousVolume(a.name);
    const bb = isAnonymousVolume(b.name);
    if (aa !== bb) return aa ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

export function parseVolumes(text: string): Volume[] {
  return parseJsonLines(text).map((o) => {
    const labels = parseLabels(o.Labels);
    return {
      name: o.Name ?? "",
      driver: o.Driver ?? "",
      mountpoint: o.Mountpoint ?? "",
      labels,
      project: labels["com.docker.compose.project"] || undefined,
    };
  });
}

export function parseNetworks(text: string): Network[] {
  return parseJsonLines(text).map((o) => {
    const labels = parseLabels(o.Labels);
    return {
      id: (o.ID ?? "").slice(0, 12),
      name: o.Name ?? "",
      driver: o.Driver ?? "",
      scope: o.Scope ?? "",
      labels,
      project: labels["com.docker.compose.project"] || undefined,
    };
  });
}

/** Groupe les conteneurs par pile Compose ; les isolés arrivent en dernier. */
export function groupByProject(
  containers: Container[],
): Array<{ project: string | null; containers: Container[] }> {
  const piles = new Map<string, Container[]>();
  const isoles: Container[] = [];
  for (const c of containers) {
    if (c.project) {
      const l = piles.get(c.project);
      if (l) l.push(c);
      else piles.set(c.project, [c]);
    } else {
      isoles.push(c);
    }
  }
  const tri = (l: Container[]) =>
    [...l].sort((a, b) => (a.service ?? a.name).localeCompare(b.service ?? b.name));
  const out = [...piles.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([project, l]) => ({
      project: project as string | null,
      containers: tri(l),
    }));
  if (isoles.length) out.push({ project: null, containers: tri(isoles) });
  return out;
}

/** Un conteneur est-il en marche ? (les états « paused » et « restarting » aussi) */
export function isUp(c: Container): boolean {
  return c.state === "running" || c.state === "restarting";
}

/** Actions proposées pour un conteneur selon son état. */
export type ContainerAction =
  "start" | "stop" | "restart" | "pause" | "unpause" | "kill" | "rm";

export function actionsFor(state: string): ContainerAction[] {
  switch (state) {
    case "running":
      return ["stop", "restart", "pause", "kill"];
    case "paused":
      return ["unpause", "stop", "kill"];
    case "restarting":
      return ["stop", "kill"];
    default:
      return ["start", "rm"];
  }
}

/** Les actions qui coupent un service en marche méritent une confirmation. */
export function isDisruptive(action: ContainerAction): boolean {
  return (
    action === "stop" || action === "kill" || action === "rm" || action === "restart"
  );
}

export const ACTION_LABELS: Record<ContainerAction, string> = {
  start: "Démarrer",
  stop: "Arrêter",
  restart: "Redémarrer",
  pause: "Suspendre",
  unpause: "Reprendre",
  kill: "Tuer",
  rm: "Supprimer",
};

/** Compte rendu d'ensemble, affiché en tête de la vue. */
export function summarize(containers: Container[]): {
  total: number;
  running: number;
  stopped: number;
  paused: number;
  projects: number;
} {
  const projects = new Set(containers.map((c) => c.project).filter(Boolean));
  return {
    total: containers.length,
    running: containers.filter((c) => c.state === "running").length,
    stopped: containers.filter((c) => c.state === "exited" || c.state === "created")
      .length,
    paused: containers.filter((c) => c.state === "paused").length,
    projects: projects.size,
  };
}

/** Filtre libre sur le nom, l'image, la pile et les ports. */
export function filterContainers(containers: Container[], query: string): Container[] {
  const q = query.trim().toLowerCase();
  if (!q) return containers;
  return containers.filter((c) =>
    [c.name, c.image, c.project ?? "", c.service ?? "", c.state, c.status]
      .concat(c.ports.map((p) => `${p.hostPort ?? ""} ${p.containerPort}`))
      .join(" ")
      .toLowerCase()
      .includes(q),
  );
}

/** Niveau détecté dans une ligne de journal, pour la colorer. */
export type LogLevel = "error" | "warn" | "info" | "debug" | null;

export interface LogLine {
  /** Horodatage ajouté par `docker logs --timestamps`, s'il est présent. */
  time: string | null;
  text: string;
  level: LogLevel;
}

const NIVEAUX: Array<[LogLevel, RegExp]> = [
  ["error", /\b(error|erreur|fatal|panic|critical|exception|failed|échec)\b/i],
  ["warn", /\b(warn|warning|attention|deprecated)\b/i],
  ["info", /\b(info|notice)\b/i],
  ["debug", /\b(debug|trace|verbose)\b/i],
];

/**
 * Découpe une sortie de journal en lignes horodatées et typées.
 *
 * L'horodatage est celui de Docker (`--timestamps`), toujours en tête et au
 * format RFC 3339 ; on ne le détache que s'il en a bien la forme, pour ne pas
 * amputer une ligne applicative qui commencerait par autre chose.
 */
export function parseLogLines(text: string): LogLine[] {
  return text.split("\n").map((raw) => {
    const m = raw.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\s(.*)$/);
    const time = m ? m[1] : null;
    const body = m ? m[2] : raw;
    const level = NIVEAUX.find(([, re]) => re.test(body))?.[0] ?? null;
    return { time, text: body, level };
  });
}

// ─── Construction des commandes ──────────────────────────────────────
//
// Les arguments sont construits ici, sous forme de tableau : le backend les
// passe tels quels au client Docker, sans shell en local et cités à distance.
// Les garder purs permet de les vérifier par des tests.

const JSON_FMT = ["--format", "{{json .}}"];

export const psArgs = (all: boolean): string[] => [
  "ps",
  ...(all ? ["-a"] : []),
  ...JSON_FMT,
];

export const statsArgs = (): string[] => ["stats", "--no-stream", ...JSON_FMT];

export const imagesArgs = (): string[] => ["images", ...JSON_FMT];

export const volumesArgs = (): string[] => ["volume", "ls", ...JSON_FMT];

export const networksArgs = (): string[] => ["network", "ls", ...JSON_FMT];

export const logsArgs = (id: string, tail: number): string[] => [
  "logs",
  "--tail",
  String(Math.max(1, Math.min(tail, 5000))),
  "--timestamps",
  id,
];

export const inspectArgs = (id: string): string[] => ["inspect", id];

export const actionArgs = (action: ContainerAction, id: string): string[] =>
  action === "rm" ? ["rm", "-f", id] : [action, id];

/**
 * Ce qu'il faut pour piloter une pile Compose : son nom et ses fichiers.
 *
 * Compose inscrit ces informations en étiquettes sur chaque conteneur qu'il
 * crée ; sans elles on saurait qu'une pile existe sans pouvoir agir dessus.
 */
export interface ComposeProject {
  name: string;
  configFiles: string[];
  workingDir?: string;
}

/** Retrouve la pile d'un groupe de conteneurs, ou null si Compose n'a rien laissé. */
export function composeProjectOf(containers: Container[]): ComposeProject | null {
  for (const c of containers) {
    const name = c.labels["com.docker.compose.project"];
    const files = c.labels["com.docker.compose.project.config_files"];
    if (!name || !files) continue;
    const configFiles = files
      .split(",")
      .map((f) => f.trim())
      .filter(Boolean);
    if (!configFiles.length) continue;
    return {
      name,
      configFiles,
      workingDir: c.labels["com.docker.compose.project.working_dir"] || undefined,
    };
  }
  return null;
}

export type ComposeAction = "up" | "down" | "restart" | "pull";

export const COMPOSE_LABELS: Record<ComposeAction, string> = {
  up: "Démarrer la pile",
  down: "Arrêter et retirer la pile",
  restart: "Redémarrer la pile",
  pull: "Récupérer les images",
};

/** Une action Compose qui interrompt le service demande confirmation. */
export function isComposeDisruptive(action: ComposeAction): boolean {
  return action === "down" || action === "restart";
}

/**
 * Commande Compose pour une pile donnée.
 *
 * Le nom du projet est passé explicitement : sans `-p`, Compose le déduit du
 * dossier courant et pourrait piloter une autre pile que celle affichée.
 */
export function composeArgs(p: ComposeProject, action: ComposeAction): string[] {
  const args = ["compose", "-p", p.name];
  if (p.workingDir) args.push("--project-directory", p.workingDir);
  for (const f of p.configFiles) args.push("-f", f);
  args.push(action);
  if (action === "up") args.push("-d");
  return args;
}

/** Nettoyages proposés, tous limités aux objets qui ne servent plus. */
export type PruneKind = "images" | "volumes" | "networks";

export const PRUNE_LABELS: Record<PruneKind, string> = {
  images: "Supprimer les images orphelines",
  volumes: "Supprimer les volumes inutilisés",
  networks: "Supprimer les réseaux inutilisés",
};

export function pruneArgs(kind: PruneKind): string[] {
  const cible = kind === "images" ? "image" : kind === "volumes" ? "volume" : "network";
  return [cible, "prune", "-f"];
}

/** Taille lisible, à partir d'un nombre d'octets. */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 o";
  const u = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

/**
 * Ce qu'un nettoyage retirerait, calculé sur les données déjà affichées.
 *
 * Docker n'offre pas de simulation ; annoncer le décompte avant d'agir évite
 * de demander une confirmation à l'aveugle.
 */
export function pruneImpact(
  kind: PruneKind,
  data: { images: DockerImage[]; volumes: Volume[]; networks: Network[] },
): { count: number; detail: string } {
  if (kind === "images") {
    const l = data.images.filter((i) => i.dangling);
    const octets = l.reduce(
      (a, i) => a + (Number.isFinite(i.sizeBytes) ? i.sizeBytes : 0),
      0,
    );
    return {
      count: l.length,
      detail: l.length
        ? `${l.length} image(s), ${humanSize(octets)} libérés`
        : "rien à retirer",
    };
  }
  if (kind === "volumes") {
    const l = data.volumes.filter((v) => !v.usedBy?.length);
    return {
      count: l.length,
      detail: l.length ? `${l.length} volume(s) inutilisé(s)` : "rien à retirer",
    };
  }
  // Les réseaux par défaut de Docker ne sont jamais retirés par un prune.
  const defauts = ["bridge", "host", "none"];
  const l = data.networks.filter((n) => !defauts.includes(n.name));
  return {
    count: l.length,
    detail: l.length ? `jusqu'à ${l.length} réseau(x) sans conteneur` : "rien à retirer",
  };
}

/** Commande d'entrée dans un conteneur, à jouer dans un terminal. */
export function execCommand(container: string, shell = "sh"): string {
  const q = `'${container.replace(/'/g, `'\\''`)}'`;
  // On tente bash puis on retombe sur sh : la plupart des images minimales
  // n'ont que sh, et l'inverse est frustrant à découvrir après coup.
  return `docker exec -it ${q} ${shell === "sh" ? "sh -c 'command -v bash >/dev/null && exec bash || exec sh'" : shell}`;
}
