// @ts-check

import { readStoredJob } from "./job-control.mjs";
import { isActiveJobStatus, sameOwnedWorkerGeneration } from "./job-lifecycle.mjs";
import {
  captureOwnedWorkerIdentity,
  isProcessAlive,
  stopOwnedWorkerTree
} from "./process.mjs";
import {
  mutateJobIf,
  preserveLaunchCleanupJob
} from "./state.mjs";
import {
  DEFAULT_WORKER_CLAIM_POLL_MS,
  DEFAULT_WORKER_CLAIM_TIMEOUT_MS
} from "./runtime-config.mjs";

/**
 * @typedef {import("./reliability-contracts").JobRecord} JobRecord
 * @typedef {import("./reliability-contracts").OwnedWorker} OwnedWorker
 * @typedef {(cwd: string, jobId: string, predicate: (job: JobRecord) => boolean, mutate: (job: JobRecord) => Partial<JobRecord> | null) => { matched: boolean, job: JobRecord | null }} MutateJobIf
 * @typedef {(cwd: string, job: JobRecord) => { preserved: boolean, job: JobRecord }} PreserveRecovery
 */

/** @param {JobRecord | null} current @param {string} jobId @param {string} launchToken */
function inspectClaim(current, jobId, launchToken) {
  if (current?.launchToken !== launchToken) {
    throw new Error(`Background worker manifest ${jobId} was replaced during launch.`);
  }
  if (current.startedAt) {
    return current;
  }
  if (current.status === "failed") {
    throw new Error(current.errorMessage ?? `Background worker ${jobId} failed during launch.`);
  }
  return null;
}

/**
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {string} launchToken
 * @param {{ worker?: OwnedWorker | null, timeoutMs?: number, pollMs?: number, now?: () => number, sleep?: (durationMs: number) => Promise<void> }} options
 * @returns {Promise<JobRecord>}
 */
export async function waitForWorkerClaim(
  workspaceRoot,
  jobId,
  launchToken,
  options = {}
) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKER_CLAIM_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_WORKER_CLAIM_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  const deadline = now() + timeoutMs;

  while (true) {
    const current = readStoredJob(workspaceRoot, jobId);
    const claimed = inspectClaim(current, jobId, launchToken);
    if (claimed) {
      return claimed;
    }

    const remainingMs = deadline - now();
    if (remainingMs <= 0) {
      break;
    }
    await sleep(Math.min(pollMs, remainingMs));
  }

  const errorMessage = `Background worker ${jobId} did not claim its manifest within ${timeoutMs}ms.`;
  const timeoutReservation = mutateJobIf(
    workspaceRoot,
    jobId,
    /** @param {JobRecord} current */
    (current) =>
      current.status === "queued" &&
      current.launchToken === launchToken &&
      (options.worker == null
        ? current.worker == null
        : sameOwnedWorkerGeneration(current.worker, options.worker)),
    () => ({
      status: "cancelling",
      phase: "claim-timeout",
      errorMessage
    })
  );
  if (timeoutReservation.matched) {
    throw new Error(errorMessage);
  }

  const current = readStoredJob(workspaceRoot, jobId);
  const claimed = inspectClaim(current, jobId, launchToken);
  if (claimed) {
    return claimed;
  }
  throw new Error(`Background worker manifest ${jobId} changed during timeout handling.`);
}

/**
 * @param {number | null | undefined} pid
 * @param {string} launchToken
 * @param {{
 *   captureOwnedWorkerIdentityImpl?: (pid: number, token: string) => OwnedWorker,
 *   isProcessAliveImpl?: (pid: number) => boolean
 * }} options
 * @returns {OwnedWorker | null}
 */
function captureUnclaimedWorker(pid, launchToken, options = {}) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  const captureOwnedWorkerIdentityImpl =
    options.captureOwnedWorkerIdentityImpl ?? captureOwnedWorkerIdentity;
  const isProcessAliveImpl = options.isProcessAliveImpl ?? isProcessAlive;

  try {
    return captureOwnedWorkerIdentityImpl(pid, launchToken);
  } catch (error) {
    if (!isProcessAliveImpl(pid)) {
      return null;
    }
    throw error;
  }
}

/** @param {JobRecord | null} current @param {string} launchToken */
function isClaimedTerminal(current, launchToken) {
  return (
    current?.launchToken === launchToken &&
    current.startedAt &&
    current.worker == null &&
    !isActiveJobStatus(current.status)
  );
}

export function recordSpawnedWorker(
  /** @type {string} */
  workspaceRoot,
  /** @type {string} */
  jobId,
  /** @type {number} */
  pid,
  /** @type {string} */
  launchToken,
  /** @type {{ captureUnclaimedWorkerImpl?: (pid: number, token: string) => OwnedWorker | null, mutateJobIfImpl?: MutateJobIf }} */
  options = {}
) {
  const captureUnclaimedWorkerImpl =
    options.captureUnclaimedWorkerImpl ?? captureUnclaimedWorker;
  const mutateJobIfImpl = options.mutateJobIfImpl ?? mutateJobIf;
  const worker = captureUnclaimedWorkerImpl(pid, launchToken);
  if (!worker) {
    const current = readStoredJob(workspaceRoot, jobId);
    return isClaimedTerminal(current, launchToken)
      ? { recorded: true, job: current, worker: null }
      : { recorded: false, job: current, worker: null };
  }

  const recording = mutateJobIfImpl(
    workspaceRoot,
    jobId,
    /** @param {JobRecord} current */
    (current) =>
      current.launchToken === launchToken &&
      (current.status === "queued" || current.status === "cancelling") &&
      (current.worker == null ||
        sameOwnedWorkerGeneration(current.worker, worker)),
    /** @param {JobRecord} current */
    (current) => ({
      pid: worker.pid,
      worker,
      launcher: null,
      phase: current.status === "queued" ? "claiming" : current.phase
    })
  );
  if (recording.matched) {
    return { recorded: true, job: recording.job, worker };
  }

  const current = readStoredJob(workspaceRoot, jobId);
  if (
    current?.launchToken === launchToken &&
    current.startedAt &&
    (sameOwnedWorkerGeneration(current.worker, worker) ||
      isClaimedTerminal(current, launchToken))
  ) {
    return { recorded: true, job: current, worker };
  }
  return { recorded: false, job: current, worker };
}

/** @param {unknown} value */
function toError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * @param {JobRecord} job
 * @param {string} launchToken
 * @param {number | null | undefined} pid
 * @param {OwnedWorker | null} worker
 * @param {string} phase
 * @param {string} errorMessage
 * @returns {JobRecord}
 */
function buildRecoveryJob(job, launchToken, pid, worker, phase, errorMessage) {
  return {
    ...job,
    status: "cancelling",
    phase,
    launchToken,
    pid: worker?.pid ?? pid ?? job.pid ?? null,
    worker,
    launcher: null,
    errorMessage
  };
}

function tryPreserveRecovery(
  /** @type {PreserveRecovery} */
  preserveLaunchCleanupJobImpl,
  /** @type {string} */
  workspaceRoot,
  /** @type {JobRecord} */
  recoveryJob
) {
  try {
    const result = preserveLaunchCleanupJobImpl(workspaceRoot, recoveryJob);
    if (!result.preserved) {
      return new Error(
        `Background worker ${recoveryJob.id} belongs to a different launch generation.`
      );
    }
    return null;
  } catch (error) {
    return toError(error);
  }
}

export async function cleanupFailedWorkerLaunch(
  /** @type {string} */
  workspaceRoot,
  /** @type {JobRecord} */
  job,
  /** @type {number | null | undefined} */
  pid,
  /** @type {string} */
  launchToken,
  /** @type {unknown} */
  launchError,
  /** @type {{
   *   captureUnclaimedWorkerImpl?: (pid: number | null | undefined, token: string) => OwnedWorker | null,
   *   mutateJobIfImpl?: MutateJobIf,
   *   preserveLaunchCleanupJobImpl?: PreserveRecovery,
   *   stopOwnedWorkerTreeImpl?: (worker: OwnedWorker, options: { graceMs?: number, killMs?: number }) => Promise<void>,
   *   workerConfig?: { stopGraceMs?: number, stopKillMs?: number }
   * }} */
  options = {}
) {
  const captureUnclaimedWorkerImpl =
    options.captureUnclaimedWorkerImpl ?? captureUnclaimedWorker;
  const mutateJobIfImpl = options.mutateJobIfImpl ?? mutateJobIf;
  const preserveLaunchCleanupJobImpl =
    options.preserveLaunchCleanupJobImpl ?? preserveLaunchCleanupJob;
  const stopOwnedWorkerTreeImpl =
    options.stopOwnedWorkerTreeImpl ?? stopOwnedWorkerTree;
  const normalizedLaunchError = toError(launchError);
  let worker = null;
  let captureError = null;

  try {
    worker = captureUnclaimedWorkerImpl(pid, launchToken);
  } catch (error) {
    captureError = toError(error);
  }

  if (captureError) {
    const preservationError = tryPreserveRecovery(
      preserveLaunchCleanupJobImpl,
      workspaceRoot,
      buildRecoveryJob(
        job,
        launchToken,
        pid,
        null,
        "launch-cleanup-failed",
        captureError.message
      )
    );
    throw new AggregateError(
      [normalizedLaunchError, captureError, ...(preservationError ? [preservationError] : [])],
      `Background worker ${job.id} failed to claim its manifest and its identity could not be captured.`
    );
  }

  const initialPreservationError = worker
    ? tryPreserveRecovery(
        preserveLaunchCleanupJobImpl,
        workspaceRoot,
        buildRecoveryJob(
          job,
          launchToken,
          pid,
          worker,
          "launch-cleanup",
          normalizedLaunchError.message
        )
      )
    : null;
  let stopError = null;

  if (worker) {
    try {
      await stopOwnedWorkerTreeImpl(worker, {
        graceMs: options.workerConfig?.stopGraceMs,
        killMs: options.workerConfig?.stopKillMs
      });
    } catch (error) {
      stopError = toError(error);
    }
  }

  if (stopError) {
    const finalPreservationError = tryPreserveRecovery(
      preserveLaunchCleanupJobImpl,
      workspaceRoot,
      buildRecoveryJob(
        job,
        launchToken,
        pid,
        worker,
        "launch-cleanup-failed",
        stopError.message
      )
    );
    throw new AggregateError(
      [
        normalizedLaunchError,
        ...(initialPreservationError ? [initialPreservationError] : []),
        stopError,
        ...(finalPreservationError ? [finalPreservationError] : [])
      ],
      `Background worker ${job.id} failed to claim its manifest and could not be stopped.`
    );
  }

  try {
    mutateJobIfImpl(
      workspaceRoot,
      job.id,
      /** @param {JobRecord} current */
      (current) =>
        current.launchToken === launchToken &&
        (current.status === "queued" || current.status === "cancelling") &&
        (worker == null ||
          current.worker == null ||
          sameOwnedWorkerGeneration(current.worker, worker)),
      () => ({
        status: "failed",
        phase: "failed",
        pid: null,
        worker: null,
        launcher: null,
        errorMessage: normalizedLaunchError.message,
        completedAt: new Date().toISOString()
      })
    );
  } catch (error) {
    throw new AggregateError(
      [
        normalizedLaunchError,
        ...(initialPreservationError ? [initialPreservationError] : []),
        toError(error)
      ],
      `Background worker ${job.id} was stopped but its failed launch could not be recorded.`
    );
  }
}
