/**
 * Actions proposées selon le type de fichier reconnu.
 *
 * Le module est volontairement sans dépendance : il transforme un chemin en une
 * liste de commandes prêtes à jouer, et rien de plus. Cela le rend testable et
 * évite qu'une commande soit construite par concaténation ailleurs dans l'app.
 */

/** Mode d'exécution d'une action. */
export type ActionMode =
  /** Exécuter et mettre en forme la sortie (tableau). */
  | "table"
  /** Envoyer au terminal actif : sortie longue, interactive ou qui dure. */
  | "term";

export interface FileAction {
  label: string;
  /**
   * Gabarit de commande. Marqueurs remplacés par des valeurs déjà citées :
   * {f} chemin du fichier, {d} son dossier, {b} son nom, {s} son nom sans
   * extension.
   */
  template: string;
  mode: ActionMode;
  /** Action qui modifie l'état du serveur : soumise au verrou de session. */
  writes?: boolean;
}

export interface FileKind {
  /** Libellé affiché en tête de section dans le menu contextuel. */
  kind: string;
  actions: FileAction[];
}

/** Cite une valeur pour un shell POSIX (guillemets simples). */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Dossier parent d'un chemin absolu (racine incluse). */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  if (i < 0) return ".";
  return i === 0 ? "/" : path.slice(0, i);
}

/** Nom de fichier d'un chemin. */
export function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

/** Nom sans sa dernière extension (« web.service » → « web »). */
export function stemOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? name : name.slice(0, i);
}

const COMPOSE = /^(docker-)?compose(\.[\w-]+)?\.ya?ml$/i;

const compose: FileAction[] = [
  {
    label: "Voir les conteneurs",
    template: "docker compose -f {f} ps",
    mode: "table",
  },
  {
    label: "Démarrer en arrière-plan",
    template: "docker compose -f {f} up -d",
    mode: "term",
    writes: true,
  },
  {
    label: "Arrêter la pile",
    template: "docker compose -f {f} down",
    mode: "term",
    writes: true,
  },
  {
    label: "Journaux (100 dernières lignes)",
    template: "docker compose -f {f} logs --tail 100",
    mode: "term",
  },
  {
    label: "Vérifier la configuration",
    template: "docker compose -f {f} config -q && echo 'compose valide'",
    mode: "term",
  },
];

/**
 * Reconnaît le type d'un fichier d'après son chemin et retourne les actions
 * associées, ou null si rien n'est proposé.
 *
 * Volontairement muet sur les fichiers de secrets (.env, clés privées) : leur
 * offrir une action reviendrait à proposer d'en afficher le contenu.
 */
export function detectKind(path: string): FileKind | null {
  const name = baseOf(path);
  const lower = name.toLowerCase();
  const dir = dirOf(path).toLowerCase();

  if (COMPOSE.test(lower)) return { kind: "Docker Compose", actions: compose };

  if (lower === "dockerfile" || lower.startsWith("dockerfile.")) {
    return {
      kind: "Dockerfile",
      actions: [
        {
          label: "Construire l'image",
          template: "docker build -f {f} {d}",
          mode: "term",
          writes: true,
        },
      ],
    };
  }

  if (lower === "nginx.conf" || (lower.endsWith(".conf") && dir.includes("/nginx"))) {
    return {
      kind: "nginx",
      actions: [
        {
          label: "Tester la configuration",
          template: "nginx -t",
          mode: "term",
        },
        {
          label: "Recharger nginx",
          template: "systemctl reload nginx && echo 'nginx rechargé'",
          mode: "term",
          writes: true,
        },
      ],
    };
  }

  if (lower === "package.json") {
    return {
      kind: "Node",
      actions: [
        {
          label: "Lister les scripts",
          template: "npm run --prefix {d}",
          mode: "term",
        },
        {
          label: "Installer les dépendances",
          template: "npm install --prefix {d}",
          mode: "term",
          writes: true,
        },
      ],
    };
  }

  if (lower.endsWith(".service") || lower.endsWith(".timer")) {
    return {
      kind: "systemd",
      actions: [
        {
          label: "État de l'unité",
          template: "systemctl status {b} --no-pager",
          mode: "term",
        },
        {
          label: "Journal de l'unité",
          template: "journalctl -u {s} -n 100 --no-pager",
          mode: "term",
        },
        {
          label: "Recharger systemd",
          template: "systemctl daemon-reload && echo 'unités rechargées'",
          mode: "term",
          writes: true,
        },
      ],
    };
  }

  if (lower.endsWith(".sh") || lower.endsWith(".bash")) {
    return {
      kind: "Script shell",
      actions: [
        {
          label: "Vérifier la syntaxe",
          template: "bash -n {f} && echo 'syntaxe correcte'",
          mode: "term",
        },
        {
          label: "Exécuter le script",
          template: "bash {f}",
          mode: "term",
          writes: true,
        },
      ],
    };
  }

  if (lower.endsWith(".py")) {
    return {
      kind: "Python",
      actions: [
        {
          label: "Vérifier la syntaxe",
          template: "python3 -m py_compile {f} && echo 'syntaxe correcte'",
          mode: "term",
        },
      ],
    };
  }

  if (lower.endsWith(".json")) {
    return {
      kind: "JSON",
      actions: [
        {
          label: "Vérifier la syntaxe",
          template: "python3 -m json.tool {f} > /dev/null && echo 'JSON valide'",
          mode: "term",
        },
      ],
    };
  }

  if (lower.endsWith(".yml") || lower.endsWith(".yaml")) {
    return {
      kind: "YAML",
      actions: [
        {
          label: "Vérifier la syntaxe",
          template:
            "python3 -c 'import sys,yaml; yaml.safe_load(open(sys.argv[1])); print(\"YAML valide\")' {f}",
          mode: "term",
        },
      ],
    };
  }

  if (lower === "crontab" || lower.endsWith(".cron")) {
    return {
      kind: "cron",
      actions: [
        {
          label: "Tâches de l'utilisateur",
          template: "crontab -l",
          mode: "term",
        },
      ],
    };
  }

  return null;
}

/** Remplit le gabarit d'une action avec les chemins cités du fichier visé. */
export function buildCommand(action: FileAction, path: string): string {
  const name = baseOf(path);
  return action.template
    .replace(/\{f\}/g, shQuote(path))
    .replace(/\{d\}/g, shQuote(dirOf(path)))
    .replace(/\{b\}/g, shQuote(name))
    .replace(/\{s\}/g, shQuote(stemOf(name)));
}
