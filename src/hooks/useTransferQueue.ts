import { useCallback, useEffect, useState } from "react";
import { sftpDownload, sftpUpload, transferCancel } from "../api";
import { Job, JobKind, makeJob, nextJobs, pruneDone, setJob } from "../queue";

/**
 * File de transferts : ordonnancement, pause, limite de parallélisme et
 * reprise. Une nouvelle tentative repart de l'offset déjà transféré.
 */
export function useTransferQueue() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [paused, setPaused] = useState(false);
  const [concurrency, setConcurrency] = useState(2);

  const enqueue = useCallback(
    (kind: JobKind, sessionId: string, localPath: string, remotePath: string) => {
      setJobs((prev) => [...prev, makeJob(kind, sessionId, localPath, remotePath)]);
    },
    [],
  );

  // Lance ce qui peut l'être dès qu'une place se libère.
  useEffect(() => {
    const ready = nextJobs({ jobs, paused, concurrency });
    if (ready.length === 0) return;
    for (const job of ready) {
      setJobs((prev) =>
        setJob(prev, job.id, {
          state: "en cours",
          attempts: job.attempts + 1,
          error: undefined,
        }),
      );
      const resume = job.attempts > 0;
      const run =
        job.kind === "upload"
          ? sftpUpload(job.sessionId, job.id, job.localPath, job.remotePath, resume)
          : sftpDownload(job.sessionId, job.id, job.remotePath, job.localPath, resume);
      run
        .then(() => {
          setJobs((prev) => setJob(prev, job.id, { state: "terminé" }));
          window.dispatchEvent(
            new CustomEvent("cabestan-transfer-done", {
              detail: { sessionId: job.sessionId },
            }),
          );
        })
        .catch((e: unknown) =>
          setJobs((prev) => setJob(prev, job.id, { state: "échec", error: String(e) })),
        );
    }
  }, [jobs, paused, concurrency]);

  const retry = useCallback((id: string) => {
    setJobs((prev) => setJob(prev, id, { state: "attente", error: undefined }));
  }, []);

  const cancel = useCallback((id: string) => {
    transferCancel(id).catch(() => {});
    setJobs((prev) => setJob(prev, id, { state: "annulé" }));
  }, []);

  const clear = useCallback(() => {
    // On garde les transferts en cours : les annuler serait une surprise.
    setJobs((prev) => pruneDone(prev).filter((j) => j.state === "en cours"));
  }, []);

  const pending = jobs.filter(
    (j) => j.state === "attente" || j.state === "en cours",
  ).length;

  return {
    jobs,
    paused,
    concurrency,
    pending,
    setPaused,
    setConcurrency,
    enqueue,
    retry,
    cancel,
    clear,
  };
}
