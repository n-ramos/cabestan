export type JobKind = "upload" | "download";

export interface Job {
  id: string;
  kind: JobKind;
  sessionId: string;
  /** Chemin local (source pour un envoi, destination pour un téléchargement). */
  localPath: string;
  remotePath: string;
  name: string;
  state: "attente" | "en cours" | "terminé" | "échec" | "annulé";
  error?: string;
  /** Nombre de reprises déjà tentées. */
  attempts: number;
}

export interface QueueState {
  jobs: Job[];
  paused: boolean;
  /** Transferts simultanés autorisés. */
  concurrency: number;
}

export const MAX_ATTEMPTS = 3;

export function makeJob(
  kind: JobKind,
  sessionId: string,
  localPath: string,
  remotePath: string,
): Job {
  const name =
    (kind === "upload" ? localPath : remotePath).replace(/\/+$/, "").split("/").pop() ??
    "";
  return {
    id: crypto.randomUUID(),
    kind,
    sessionId,
    localPath,
    remotePath,
    name,
    state: "attente",
    attempts: 0,
  };
}

/** Jobs à démarrer maintenant, en respectant pause et parallélisme. */
export function nextJobs(state: QueueState): Job[] {
  if (state.paused) return [];
  const running = state.jobs.filter((j) => j.state === "en cours").length;
  const free = Math.max(0, state.concurrency - running);
  if (free === 0) return [];
  return state.jobs.filter((j) => j.state === "attente").slice(0, free);
}

export function setJob(jobs: Job[], id: string, patch: Partial<Job>): Job[] {
  return jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
}

/** Un job échoué peut être repris tant que le plafond n'est pas atteint. */
export function canRetry(job: Job): boolean {
  return job.state === "échec" && job.attempts < MAX_ATTEMPTS;
}

/** Retire les jobs terminés depuis la file (garde échecs et annulations visibles). */
export function pruneDone(jobs: Job[]): Job[] {
  return jobs.filter((j) => j.state !== "terminé");
}

export function queueSummary(jobs: Job[]) {
  const by = (s: Job["state"]) => jobs.filter((j) => j.state === s).length;
  return {
    attente: by("attente"),
    enCours: by("en cours"),
    termine: by("terminé"),
    echec: by("échec"),
    annule: by("annulé"),
    total: jobs.length,
  };
}
