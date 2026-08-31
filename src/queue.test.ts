import { describe, expect, it } from "vitest";
import {
  Job,
  MAX_ATTEMPTS,
  canRetry,
  makeJob,
  nextJobs,
  pruneDone,
  queueSummary,
  setJob,
} from "./queue";

const job = (state: Job["state"], attempts = 0): Job => ({
  ...makeJob("upload", "s0", "/local/a.txt", "/remote/a.txt"),
  state,
  attempts,
});

describe("création d'un travail", () => {
  it("déduit le nom du fichier selon le sens", () => {
    expect(makeJob("upload", "s0", "/local/rapport.pdf", "/remote/x.pdf").name).toBe(
      "rapport.pdf",
    );
    expect(makeJob("download", "s0", "/local/x.pdf", "/remote/rapport.pdf").name).toBe(
      "rapport.pdf",
    );
  });

  it("démarre en attente, sans tentative", () => {
    const j = makeJob("upload", "s0", "/a", "/b");
    expect(j.state).toBe("attente");
    expect(j.attempts).toBe(0);
  });
});

describe("ordonnancement", () => {
  it("démarre jusqu'à la limite de parallélisme", () => {
    const jobs = [job("attente"), job("attente"), job("attente")];
    expect(nextJobs({ jobs, paused: false, concurrency: 2 })).toHaveLength(2);
  });

  it("tient compte des transferts déjà en cours", () => {
    const jobs = [job("en cours"), job("attente"), job("attente")];
    expect(nextJobs({ jobs, paused: false, concurrency: 2 })).toHaveLength(1);
  });

  it("ne démarre rien quand la file est en pause", () => {
    const jobs = [job("attente"), job("attente")];
    expect(nextJobs({ jobs, paused: true, concurrency: 3 })).toHaveLength(0);
  });

  it("ne démarre rien quand la limite est atteinte", () => {
    const jobs = [job("en cours"), job("en cours"), job("attente")];
    expect(nextJobs({ jobs, paused: false, concurrency: 2 })).toHaveLength(0);
  });

  it("ignore les travaux terminés ou échoués", () => {
    const jobs = [job("terminé"), job("échec"), job("annulé")];
    expect(nextJobs({ jobs, paused: false, concurrency: 5 })).toHaveLength(0);
  });
});

describe("reprises", () => {
  it("autorise la reprise d'un échec sous le plafond", () => {
    expect(canRetry(job("échec", 0))).toBe(true);
    expect(canRetry(job("échec", MAX_ATTEMPTS - 1))).toBe(true);
  });

  it("refuse au-delà du plafond", () => {
    expect(canRetry(job("échec", MAX_ATTEMPTS))).toBe(false);
  });

  it("ne reprend pas un travail qui n'a pas échoué", () => {
    expect(canRetry(job("attente"))).toBe(false);
    expect(canRetry(job("terminé"))).toBe(false);
  });
});

describe("mise à jour et nettoyage", () => {
  it("modifie uniquement le travail visé", () => {
    const a = job("attente");
    const b = job("attente");
    const after = setJob([a, b], a.id, { state: "en cours" });
    expect(after[0].state).toBe("en cours");
    expect(after[1].state).toBe("attente");
  });

  it("retire les terminés mais garde les échecs", () => {
    const jobs = [job("terminé"), job("échec"), job("attente")];
    const after = pruneDone(jobs);
    expect(after.map((j) => j.state)).toEqual(["échec", "attente"]);
  });

  it("résume l'état de la file", () => {
    const s = queueSummary([
      job("attente"),
      job("en cours"),
      job("terminé"),
      job("échec"),
    ]);
    expect(s).toEqual({
      attente: 1,
      enCours: 1,
      termine: 1,
      echec: 1,
      annule: 0,
      total: 4,
    });
  });
});
