export type WorkerProgressStatus = "done" | "failed" | "skipped";

export interface WorkerProgressSnapshot {
  claimed: number;
  done: number;
  failed: number;
  skipped: number;
  inFlight: number;
}

export function createProgressTracker() {
  const snapshot: WorkerProgressSnapshot = {
    claimed: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    inFlight: 0,
  };

  return {
    claimed() {
      snapshot.claimed++;
      snapshot.inFlight++;
    },
    completed(status: WorkerProgressStatus) {
      if (snapshot.inFlight > 0) snapshot.inFlight--;
      snapshot[status]++;
    },
    snapshot(): WorkerProgressSnapshot {
      return { ...snapshot };
    },
    format(): string {
      return `[worker] progress source=memory claimed=${snapshot.claimed} done=${snapshot.done} failed=${snapshot.failed} skipped=${snapshot.skipped} inFlight=${snapshot.inFlight}`;
    },
  };
}
