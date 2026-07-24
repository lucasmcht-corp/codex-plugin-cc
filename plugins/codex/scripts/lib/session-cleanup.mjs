// @ts-check

import {
  inspectProcessIdentity,
  inspectOwnedWorker,
  isProcessAlive,
  stopOwnedWorkerTree
} from "./process.mjs";
import {
  isActiveJobStatus,
  isJobStatus,
  sameOwnedWorkerGeneration,
  sameProcessGeneration
} from "./job-lifecycle.mjs";
import {
  clearSessionEndingsIf,
  listJobs,
  loadState,
  mutateJobIf,
  removeJobIf
} from "./state.mjs";
import {
  DEFAULT_SESSION_CLEANUP_LAUNCH_WAIT_ATTEMPTS,
  DEFAULT_SESSION_CLEANUP_LAUNCH_WAIT_POLL_MS,
  DEFAULT_SESSION_CLEANUP_ROUNDS,
  DEFAULT_SESSION_START_CONFIG,
  DEFAULT_WORKER_CONFIG
} from "./runtime-config.mjs";
import { cleanupSteeringEndpoint } from "./steering-channel.mjs";

/**
 * @typedef {import("./reliability-contracts").JobRecord} JobRecord
 * @typedef {import("./reliability-contracts").OwnedWorker} OwnedWorker
 * @typedef {import("./reliability-contracts").PersistedState} PersistedState
 * @typedef {import("./reliability-contracts").ProcessIdentity} ProcessIdentity
 * @typedef {import("./reliability-contracts").SessionEnding} SessionEnding
 * @typedef {import("./reliability-contracts").SteeringDescriptor} SteeringDescriptor
 * @typedef {{ socketRoot: string, directoryMode: number, socketMode: number, requestTimeoutMs: number, maxFrameBytes: number }} SteeringConfig
 * @typedef {{ timeoutMs?: number, pollMs?: number }} StateMutationOptions
 * @typedef {(cwd: string) => JobRecord[]} ListJobs
 * @typedef {(cwd: string, jobId: string, predicate: (job: JobRecord) => boolean, mutate: (job: JobRecord) => Partial<JobRecord> | null, options?: StateMutationOptions) => { matched: boolean, job: JobRecord | null }} MutateJobIf
 * @typedef {(cwd: string, jobId: string, predicate: (job: JobRecord) => boolean, options?: StateMutationOptions) => { matched: boolean, job: JobRecord | null }} RemoveJobIf
 * @typedef {(descriptor: SteeringDescriptor | null | undefined, options: { workspaceRoot: string, jobId: string, worker: OwnedWorker, config?: SteeringConfig }) => boolean} CleanupSteeringEndpoint
 * @typedef {{ processedJobCount: number, processedJobIds: string[] }} ReconciliationResult
 * @typedef {{
 *   listJobsImpl?: ListJobs,
 *   mutateJobIfImpl?: MutateJobIf,
 *   removeJobIfImpl?: RemoveJobIf,
 *   inspectOwnedWorkerImpl?: (worker: OwnedWorker, options?: { deadlineAt?: number }) => { status: "same" | "gone" | "mismatch" },
 *   inspectProcessIdentityImpl?: (pid: number, options?: { deadlineAt?: number }) => ProcessIdentity | null,
 *   isProcessAliveImpl?: (pid: number) => boolean,
 *   cleanupSteeringEndpointImpl?: CleanupSteeringEndpoint,
 *   stopOwnedWorkerTreeImpl?: (worker: OwnedWorker, options: { graceMs: number, killMs: number, deadlineAt?: number }) => Promise<{ stopped: boolean }>,
 *   reconcileWorkspaceJobsImpl?: (workspaceRoot: string, options: SessionCleanupOptions) => ReconciliationResult | void,
 *   cleanupSessionJobImpl?: (workspaceRoot: string, jobId: string, sessionId: string, options: SessionCleanupOptions) => Promise<boolean>,
 *   cleanupSessionJobsImpl?: (workspaceRoot: string, sessionId: string, options: SessionCleanupOptions) => Promise<{ complete: boolean, deferred: boolean } | void>,
 *   loadStateImpl?: (cwd: string) => PersistedState,
 *   clearSessionEndingsIfImpl?: (cwd: string, entries: SessionEnding[], options?: StateMutationOptions) => { clearedSessionIds: string[], conflictedSessionIds: string[] },
 *   sleepImpl?: (durationMs: number) => Promise<void>,
 *   nowImpl?: () => number,
 *   steeringConfig?: SteeringConfig,
 *   workerConfig?: { stopGraceMs?: number, stopKillMs?: number },
 *   sessionStartConfig?: { recoveryBatchSize?: number, recoveryJobBatchSize?: number, recoveryBudgetMs?: number },
 *   jobIds?: string[],
 *   sessionId?: string,
 *   limit?: number,
 *   deadlineAt?: number,
 *   launchWaitAttempts?: number,
 *   launchWaitPollMs?: number,
 *   allowPartial?: boolean,
 *   sessionEnding?: SessionEnding
 * }} SessionCleanupOptions
 */

/** @param {ProcessIdentity | null | undefined} left @param {ProcessIdentity | null | undefined} right */
function sameLauncherGeneration(left, right) {
  if (left == null || right == null) {
    return left == null && right == null;
  }
  return sameProcessGeneration(left, right);
}

/** @param {OwnedWorker | null | undefined} worker @returns {OwnedWorker} */
function requireOwnedWorker(worker) {
  if (!worker) {
    throw new Error("Owned worker generation is missing.");
  }
  return worker;
}

/** @type {CleanupSteeringEndpoint} */
const cleanupSteeringEndpointWithRequiredConfig = (descriptor, options) => {
  if (!options.config) {
    throw new Error("Steering cleanup configuration is missing.");
  }
  return cleanupSteeringEndpoint(descriptor, {
    ...options,
    config: options.config
  });
};

/** @param {JobRecord} job */
function isReconciliationCandidate(job) {
  return (
    isActiveJobStatus(job.status) ||
    Boolean(job.steering && job.worker?.token)
  );
}

/** @param {JobRecord} job */
function isLegacyCompatibilityCandidate(job) {
  return (
    isActiveJobStatus(job.status) &&
    !job.worker?.token &&
    typeof job.launchToken !== "string"
  );
}

/** @param {string} workspaceRoot @param {SessionCleanupOptions} options @returns {ReconciliationResult} */
export function reconcileWorkspaceJobs(workspaceRoot, options = {}) {
  const listJobsImpl = options.listJobsImpl ?? listJobs;
  const mutateJobIfImpl = options.mutateJobIfImpl ?? mutateJobIf;
  const inspectOwnedWorkerImpl =
    options.inspectOwnedWorkerImpl ?? inspectOwnedWorker;
  const inspectProcessIdentityImpl =
    options.inspectProcessIdentityImpl ?? inspectProcessIdentity;
  const isProcessAliveImpl = options.isProcessAliveImpl ?? isProcessAlive;
  const cleanupSteeringEndpointImpl =
    options.cleanupSteeringEndpointImpl ??
    cleanupSteeringEndpointWithRequiredConfig;
  /** @type {string[]} */
  const legacyJobs = [];
  const selectedJobIds = options.jobIds
    ? new Set(options.jobIds)
    : null;
  const candidates = listJobsImpl(workspaceRoot)
    .filter(
      (job) =>
        (selectedJobIds == null || selectedJobIds.has(job.id)) &&
        (options.sessionId == null || job.sessionId === options.sessionId) &&
        isReconciliationCandidate(job)
    );
  const legacyCandidates = candidates.filter(isLegacyCompatibilityCandidate);
  const orderedCandidates = [
    ...legacyCandidates,
    ...candidates.filter((job) => !isLegacyCompatibilityCandidate(job))
  ];
  const jobs = orderedCandidates.slice(
    0,
    options.limit ?? Number.POSITIVE_INFINITY
  );
  /** @type {string[]} */
  const processedJobIds = [];

  for (const job of jobs) {
    if (remainingBudgetMs(options) <= 0) {
      break;
    }
    processedJobIds.push(job.id);
    if (!isActiveJobStatus(job.status)) {
      if (!job.steering || !job.worker?.token) {
        continue;
      }
      if (
        inspectOwnedWorkerImpl(job.worker, {
          deadlineAt: options.deadlineAt
        }).status === "same"
      ) {
        continue;
      }
      try {
        cleanupSteeringEndpointImpl(job.steering, {
          workspaceRoot,
          jobId: job.id,
          worker: job.worker,
          config: options.steeringConfig
        });
      } catch {
        continue;
      }
      if (remainingBudgetMs(options) <= 0) {
        break;
      }
      mutateJobIfImpl(
        workspaceRoot,
        job.id,
        /** @param {JobRecord} current */
        (current) =>
          !isActiveJobStatus(current.status) &&
          current.sessionId === job.sessionId &&
          sameOwnedWorkerGeneration(current.worker, job.worker),
        () => ({
          pid: null,
          worker: null,
          steering: null
        }),
        stateMutationOptions(options)
      );
      continue;
    }
    if (!job.worker?.token) {
      if (typeof job.launchToken === "string") {
        let launcherStatus = "gone";
        if (job.launcher?.pid && job.launcher?.startKey) {
          const observed = inspectProcessIdentityImpl(job.launcher.pid, {
            deadlineAt: options.deadlineAt
          });
          launcherStatus =
            observed && sameProcessGeneration(observed, job.launcher)
              ? "same"
              : observed
                ? "mismatch"
                : "gone";
        }
        if (launcherStatus === "same") {
          continue;
        }
        if (remainingBudgetMs(options) <= 0) {
          break;
        }
        mutateJobIfImpl(
          workspaceRoot,
          job.id,
          /** @param {JobRecord} current */
          (current) =>
            isActiveJobStatus(current.status) &&
            current.sessionId === job.sessionId &&
            current.launchToken === job.launchToken &&
            current.worker == null &&
            sameLauncherGeneration(current.launcher, job.launcher),
          () => ({
            status: "failed",
            phase: "failed",
            pid: null,
            launcher: null,
            errorMessage:
              launcherStatus === "mismatch"
                ? "Background launcher identity changed before worker spawn."
                : "Background launcher exited before worker spawn."
          }),
          stateMutationOptions(options)
        );
        continue;
      }
      if (
        typeof job.pid === "number" &&
        Number.isSafeInteger(job.pid) &&
        !isProcessAliveImpl(job.pid)
      ) {
        if (remainingBudgetMs(options) <= 0) {
          break;
        }
        mutateJobIfImpl(
          workspaceRoot,
          job.id,
          /** @param {JobRecord} current */
          (current) =>
            isActiveJobStatus(current.status) &&
            current.sessionId === job.sessionId &&
            !current.worker?.token &&
            current.pid === job.pid,
          () => ({
            status: "failed",
            phase: "failed",
            pid: null,
            errorMessage: "Legacy background worker exited before the fork was activated."
          }),
          stateMutationOptions(options)
        );
        continue;
      }
      legacyJobs.push(job.id);
      continue;
    }

    const inspection = inspectOwnedWorkerImpl(job.worker, {
      deadlineAt: options.deadlineAt
    });
    if (inspection.status === "same") {
      continue;
    }
    if (
      job.status === "cancelling" &&
      job.phase === "cancelling" &&
      job.cancellation?.token
    ) {
      const cancellationToken = job.cancellation.token;
      try {
        cleanupSteeringEndpointImpl(job.steering, {
          workspaceRoot,
          jobId: job.id,
          worker: job.worker,
          config: options.steeringConfig
        });
      } catch {
        continue;
      }
      if (remainingBudgetMs(options) <= 0) {
        break;
      }
      const completedAt = new Date().toISOString();
      mutateJobIfImpl(
        workspaceRoot,
        job.id,
        /** @param {JobRecord} current */
        (current) =>
          current.status === "cancelling" &&
          current.sessionId === job.sessionId &&
          current.cancellation?.token === cancellationToken &&
          sameOwnedWorkerGeneration(current.worker, job.worker),
        () => ({
          status: "cancelled",
          phase: "cancelled",
          pid: null,
          worker: null,
          steering: null,
          errorMessage: "Cancelled by user.",
          completedAt,
          cancelledAt: completedAt
        }),
        stateMutationOptions(options)
      );
      continue;
    }
    if (remainingBudgetMs(options) <= 0) {
      break;
    }
    const failure = mutateJobIfImpl(
      workspaceRoot,
      job.id,
      /** @param {JobRecord} current */
      (current) =>
        isActiveJobStatus(current.status) &&
        current.sessionId === job.sessionId &&
        sameOwnedWorkerGeneration(current.worker, job.worker),
      () => ({
        status: "failed",
        phase: "failed",
        pid: job.steering ? job.pid : null,
        worker: job.steering ? job.worker : null,
        errorMessage:
          inspection.status === "gone"
            ? "Owned background worker exited without publishing a terminal result."
            : "Owned background worker identity no longer matches its recorded generation."
      }),
      stateMutationOptions(options)
    );
    if (
      !failure.matched ||
      !failure.job?.steering ||
      !failure.job.worker
    ) {
      continue;
    }
    const failedJob = failure.job;
    const failedWorker = requireOwnedWorker(failedJob.worker);
    const failedSteering = failedJob.steering;

    try {
      cleanupSteeringEndpointImpl(failedSteering, {
        workspaceRoot,
        jobId: failedJob.id,
        worker: failedWorker,
        config: options.steeringConfig
      });
    } catch {
      continue;
    }
    if (remainingBudgetMs(options) <= 0) {
      break;
    }
    mutateJobIfImpl(
      workspaceRoot,
      failedJob.id,
      /** @param {JobRecord} current */
      (current) =>
        !isActiveJobStatus(current.status) &&
        current.sessionId === failedJob.sessionId &&
        sameOwnedWorkerGeneration(current.worker, failedWorker),
      () => ({
        pid: null,
        worker: null,
        steering: null
      }),
      stateMutationOptions(options)
    );
  }

  if (legacyJobs.length > 0) {
    throw new Error(
      `Live v1.0.6 background jobs detected: ${legacyJobs.join(", ")}. Finish or cancel them with v1.0.6 before activating this fork.`
    );
  }
  const processedJobs = new Set(processedJobIds);
  const uninspectedLegacyJobs = legacyCandidates.filter(
    (job) => !processedJobs.has(job.id)
  );
  if (uninspectedLegacyJobs.length > 0) {
    throw new Error(
      `SessionStart could not inspect ${uninspectedLegacyJobs.length} legacy v1.0.6 background job(s) within its recovery limit. Retry SessionStart before activating this fork.`
    );
  }
  return {
    processedJobCount: processedJobIds.length,
    processedJobIds
  };
}

/** @param {string} workspaceRoot @param {SessionCleanupOptions} options */
export async function prepareSessionStart(workspaceRoot, options = {}) {
  const loadStateImpl = options.loadStateImpl ?? loadState;
  const cleanupSessionJobsImpl =
    options.cleanupSessionJobsImpl ?? cleanupSessionJobs;
  const listJobsImpl = options.listJobsImpl ?? listJobs;
  const clearSessionEndingsIfImpl =
    options.clearSessionEndingsIfImpl ?? clearSessionEndingsIf;
  const recoveryBatchSize =
    options.sessionStartConfig?.recoveryBatchSize ??
    DEFAULT_SESSION_START_CONFIG.recoveryBatchSize;
  const recoveryJobBatchSize =
    options.sessionStartConfig?.recoveryJobBatchSize ??
    DEFAULT_SESSION_START_CONFIG.recoveryJobBatchSize;
  const recoveryBudgetMs =
    options.sessionStartConfig?.recoveryBudgetMs ??
    DEFAULT_SESSION_START_CONFIG.recoveryBudgetMs;
  const deadlineAt = (options.nowImpl ?? Date.now)() + recoveryBudgetMs;
  const recoveryOptions = { ...options, deadlineAt };
  const endedSessions = [...loadStateImpl(workspaceRoot).endedSessions]
    .sort(
      (left, right) =>
        left.endedAt.localeCompare(right.endedAt) ||
        left.sessionId.localeCompare(right.sessionId)
    )
    .slice(0, recoveryBatchSize);
  const workspaceJobs = listJobsImpl(workspaceRoot);
  const selectedSessionIds = new Set(
    endedSessions.map((entry) => entry.sessionId)
  );
  const legacyJobIds = workspaceJobs
    .filter(isLegacyCompatibilityCandidate)
    .map((job) => job.id);
  const reconcileWorkspaceJobsImpl =
    options.reconcileWorkspaceJobsImpl ?? reconcileWorkspaceJobs;
  const legacyReconciliation = reconcileWorkspaceJobsImpl(workspaceRoot, {
    ...recoveryOptions,
    jobIds: legacyJobIds,
    limit: recoveryJobBatchSize
  });
  const processedLegacyJobIds = new Set(
    legacyReconciliation?.processedJobIds ??
      legacyJobIds.slice(
        0,
        legacyReconciliation?.processedJobCount ?? 0
      )
  );
  /** @type {Map<string, string[]>} */
  const jobsBySession = new Map();
  for (const job of workspaceJobs) {
    if (!job.sessionId) {
      continue;
    }
    const jobs = jobsBySession.get(job.sessionId) ?? [];
    jobs.push(job.id);
    jobsBySession.set(job.sessionId, jobs);
  }
  let remainingJobSlots = Math.max(
    0,
    recoveryJobBatchSize -
      (legacyReconciliation?.processedJobCount ?? 0)
  );
  const cleanupResults = await Promise.allSettled(
    endedSessions.map((endedSession) => {
      const sessionJobIds = jobsBySession.get(endedSession.sessionId) ?? [];
      const jobIds = sessionJobIds
        .filter((jobId) => !processedLegacyJobIds.has(jobId))
        .slice(0, remainingJobSlots);
      remainingJobSlots -= jobIds.length;
      if (sessionJobIds.length === 0) {
        return Promise.resolve();
      }
      if (jobIds.length === 0) {
        return Promise.resolve({ deferred: true });
      }
      return cleanupSessionJobsImpl(
        workspaceRoot,
        endedSession.sessionId,
        {
          ...recoveryOptions,
          jobIds,
          allowPartial: true,
          sessionEnding: endedSession
        }
      );
    })
  );
  if (
    remainingJobSlots > 0 &&
    remainingBudgetMs(recoveryOptions) > 0
  ) {
    const unrelatedJobIds = workspaceJobs
      .filter(
        (job) =>
          !processedLegacyJobIds.has(job.id) &&
          !selectedSessionIds.has(job.sessionId ?? "")
      )
      .map((job) => job.id);
    reconcileWorkspaceJobsImpl(workspaceRoot, {
      ...recoveryOptions,
      jobIds: unrelatedJobIds,
      limit: remainingJobSlots
    });
  }
  const remainingSessionIds = new Set(
    listJobsImpl(workspaceRoot)
      .map((job) => job.sessionId)
      .filter((sessionId) => typeof sessionId === "string")
  );
  const cleanedSessions = endedSessions.filter(
    (entry, index) =>
      cleanupResults[index].status === "fulfilled" &&
      !remainingSessionIds.has(entry.sessionId)
  );
  const clearing =
    cleanedSessions.length > 0 &&
    remainingBudgetMs(recoveryOptions) > 0
      ? clearSessionEndingsIfImpl(
          workspaceRoot,
          cleanedSessions,
          stateMutationOptions(recoveryOptions)
        )
      : { clearedSessionIds: [], conflictedSessionIds: [] };
  const cleanupErrors = cleanupResults
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (
    cleanupErrors.length > 0 ||
    clearing.conflictedSessionIds.length > 0
  ) {
    throw new AggregateError(
      cleanupErrors,
      [
        cleanupErrors.length > 0
          ? `${cleanupErrors.length} session cleanup operation(s) failed: ${cleanupErrors.map((error) => error instanceof Error ? error.message : String(error)).join("; ")}.`
          : "",
        clearing.conflictedSessionIds.length > 0
          ? `Sessions ended again during cleanup: ${clearing.conflictedSessionIds.join(", ")}.`
          : ""
      ]
        .filter(Boolean)
        .join(" ")
    );
  }
}

/** @param {ListJobs} listJobsImpl @param {string} workspaceRoot @param {string} jobId @param {string} sessionId */
function findSessionJob(listJobsImpl, workspaceRoot, jobId, sessionId) {
  return (
    listJobsImpl(workspaceRoot).find(
      (job) => job.id === jobId && job.sessionId === sessionId
    ) ?? null
  );
}

/** @param {SessionCleanupOptions} options */
function remainingBudgetMs(options) {
  if (options.deadlineAt == null) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(
    0,
    options.deadlineAt - (options.nowImpl ?? Date.now)()
  );
}

/** @param {SessionCleanupOptions} options @returns {StateMutationOptions} */
function stateMutationOptions(options) {
  const remainingMs = remainingBudgetMs(options);
  if (!Number.isFinite(remainingMs)) {
    return {};
  }
  return {
    timeoutMs: Math.max(1, Math.floor(remainingMs)),
    pollMs: Math.max(1, Math.min(10, Math.floor(remainingMs)))
  };
}

/** @param {string} workspaceRoot @param {string} sessionId @param {SessionCleanupOptions} options */
function isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options) {
  const expected = options.sessionEnding;
  if (!expected) {
    return true;
  }
  if (expected.sessionId !== sessionId) {
    return false;
  }
  const current = (options.loadStateImpl ?? loadState)(workspaceRoot)
    .endedSessions.find((entry) => entry.sessionId === sessionId);
  if (!current) {
    return false;
  }
  return expected.token === undefined
    ? current.token === undefined && current.endedAt === expected.endedAt
    : current.token === expected.token;
}

/** @param {string} workspaceRoot @param {string} jobId @param {string} sessionId @param {SessionCleanupOptions} options */
export async function cleanupSessionJob(workspaceRoot, jobId, sessionId, options = {}) {
  const listJobsImpl = options.listJobsImpl ?? listJobs;
  const mutateJobIfImpl = options.mutateJobIfImpl ?? mutateJobIf;
  const removeJobIfImpl = options.removeJobIfImpl ?? removeJobIf;
  const stopOwnedWorkerTreeImpl = options.stopOwnedWorkerTreeImpl ?? stopOwnedWorkerTree;
  const cleanupSteeringEndpointImpl =
    options.cleanupSteeringEndpointImpl ??
    cleanupSteeringEndpointWithRequiredConfig;
  const sleepImpl =
    options.sleepImpl ??
    ((durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)));
  const launchWaitAttempts =
    options.launchWaitAttempts ??
    DEFAULT_SESSION_CLEANUP_LAUNCH_WAIT_ATTEMPTS;
  const launchWaitPollMs =
    options.launchWaitPollMs ??
    DEFAULT_SESSION_CLEANUP_LAUNCH_WAIT_POLL_MS;
  let launchWaits = 0;

  for (
    let attempt = 0;
    attempt < launchWaitAttempts + DEFAULT_SESSION_CLEANUP_ROUNDS;
    attempt += 1
  ) {
    if (
      remainingBudgetMs(options) <= 0 ||
      !isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)
    ) {
      return false;
    }
    const job = findSessionJob(listJobsImpl, workspaceRoot, jobId, sessionId);
    if (!job) {
      return true;
    }
    if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
      return false;
    }
    if (!isJobStatus(job.status)) {
      throw new Error(`Session cleanup refused unknown status for ${job.id}.`);
    }

    if (!isActiveJobStatus(job.status)) {
      if (job.steering) {
        if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
          return false;
        }
        if (!job.worker || !options.steeringConfig) {
          throw new Error(
            `Session cleanup is missing retained steering ownership for ${job.id}.`
          );
        }
        cleanupSteeringEndpointImpl(job.steering, {
          workspaceRoot,
          jobId: job.id,
          worker: job.worker,
          config: options.steeringConfig
        });
      }
      if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
        return false;
      }
      const removal = removeJobIfImpl(
        workspaceRoot,
        job.id,
        /** @param {JobRecord} current */
        (current) =>
          isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options) &&
          current.sessionId === sessionId && !isActiveJobStatus(current.status),
        stateMutationOptions(options)
      );
      if (removal.matched) {
        return true;
      }
      continue;
    }

    if (!job.worker?.token) {
      if (job.status === "queued" && job.phase === "spawning") {
        if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
          return false;
        }
        mutateJobIfImpl(
          workspaceRoot,
          job.id,
          /** @param {JobRecord} current */
          (current) =>
            isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options) &&
            current.sessionId === sessionId &&
            current.status === "queued" &&
            current.phase === "spawning" &&
            current.launchToken === job.launchToken &&
            current.worker == null,
          () => ({
            status: "cancelling",
            phase: "session-cleanup"
          }),
          stateMutationOptions(options)
        );
      } else if (job.status === "queued") {
        if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
          return false;
        }
        const removal = removeJobIfImpl(
          workspaceRoot,
          job.id,
          /** @param {JobRecord} current */
          (current) =>
            isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options) &&
            current.sessionId === sessionId &&
            current.status === "queued" &&
            current.launchToken === job.launchToken &&
            current.worker == null,
          stateMutationOptions(options)
        );
        if (removal.matched) {
          return true;
        }
        continue;
      } else if (job.status !== "cancelling") {
        return false;
      }

      if (launchWaits >= launchWaitAttempts) {
        return false;
      }
      launchWaits += 1;
      const waitMs = Math.min(launchWaitPollMs, remainingBudgetMs(options));
      if (waitMs <= 0) {
        return false;
      }
      await sleepImpl(waitMs);
      continue;
    }

    if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
      return false;
    }
    const reservation = mutateJobIfImpl(
      workspaceRoot,
      job.id,
      /** @param {JobRecord} current */
      (current) =>
        isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options) &&
        current.sessionId === sessionId &&
        isActiveJobStatus(current.status) &&
        sameOwnedWorkerGeneration(current.worker, job.worker),
      () => ({
        status: "cancelling",
        phase: "session-cleanup"
      }),
      stateMutationOptions(options)
    );
    if (!reservation.matched || !reservation.job?.worker) {
      continue;
    }
    if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
      return false;
    }

    try {
      const stopBudgetMs = remainingBudgetMs(options);
      if (stopBudgetMs <= 2) {
        return false;
      }
      const graceMs = Math.max(
        1,
        Math.min(
          options.workerConfig?.stopGraceMs ??
            DEFAULT_WORKER_CONFIG.stopGraceMs,
          Math.floor(stopBudgetMs / 2)
        )
      );
      const killMs = Math.max(
        1,
        Math.min(
          options.workerConfig?.stopKillMs ??
            DEFAULT_WORKER_CONFIG.stopKillMs,
          Math.floor(stopBudgetMs - graceMs)
        )
      );
      const stopped = await stopOwnedWorkerTreeImpl(reservation.job.worker, {
        graceMs,
        killMs,
        deadlineAt: options.deadlineAt
      });
      if (!stopped.stopped) {
        return false;
      }
    } catch {
      return false;
    }

    if (reservation.job.steering) {
      if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
        return false;
      }
      if (!options.steeringConfig) {
        throw new Error(
          `Session cleanup is missing steering configuration for ${reservation.job.id}.`
        );
      }
      cleanupSteeringEndpointImpl(reservation.job.steering, {
        workspaceRoot,
        jobId: reservation.job.id,
        worker: reservation.job.worker,
        config: options.steeringConfig
      });
    }
    if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
      return false;
    }
    const reservedWorker = reservation.job.worker;
    const removal = removeJobIfImpl(
      workspaceRoot,
      job.id,
      /** @param {JobRecord} current */
      (current) =>
        isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options) &&
        current.sessionId === sessionId &&
        sameOwnedWorkerGeneration(current.worker, reservedWorker),
      stateMutationOptions(options)
    );
    if (removal.matched) {
      return true;
    }
  }
  return false;
}

/** @param {string} workspaceRoot @param {string} sessionId @param {SessionCleanupOptions} options */
export async function cleanupSessionJobs(workspaceRoot, sessionId, options = {}) {
  const listJobsImpl = options.listJobsImpl ?? listJobs;
  const cleanupSessionJobImpl = options.cleanupSessionJobImpl ?? cleanupSessionJob;
  /** @type {Map<string, JobRecord>} */
  const failedJobs = new Map();
  /** @type {Map<string, unknown>} */
  const cleanupErrors = new Map();
  const selectedJobIds = options.jobIds ? new Set(options.jobIds) : null;

  /** @param {JobRecord} job */
  const isSameUnresolvedJob = (job) => {
    const failedJob = failedJobs.get(job.id);
    if (!failedJob || !isActiveJobStatus(job.status)) {
      return false;
    }
    if (!failedJob.worker?.token) {
      return (
        !job.worker?.token &&
        job.launchToken === failedJob.launchToken
      );
    }
    return (
      sameOwnedWorkerGeneration(job.worker, failedJob.worker)
    );
  };

  for (let round = 0; round < DEFAULT_SESSION_CLEANUP_ROUNDS; round += 1) {
    if (remainingBudgetMs(options) <= 0) {
      if (options.allowPartial) {
        return { complete: false, deferred: true };
      }
      throw new Error(`Session cleanup deadline reached for ${sessionId}.`);
    }
    if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
      return { complete: false, deferred: true };
    }
    const allSessionJobs = listJobsImpl(workspaceRoot).filter(
      (job) => job.sessionId === sessionId
    );
    if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
      return { complete: false, deferred: true };
    }
    const sessionJobs = allSessionJobs.filter(
      (job) => selectedJobIds == null || selectedJobIds.has(job.id)
    );
    const jobs = sessionJobs.filter(
      (job) =>
        !isSameUnresolvedJob(job)
    );
    if (jobs.length === 0) {
      const incompleteJobIds = sessionJobs
        .filter(isSameUnresolvedJob)
        .map((job) => job.id);
      if (incompleteJobIds.length > 0) {
        if (options.allowPartial) {
          return { complete: false, deferred: true };
        }
        throw new Error(
          `Session cleanup incomplete for jobs: ${incompleteJobIds.join(", ")}`
        );
      }
      if (cleanupErrors.size > 0) {
        throw new AggregateError(
          [...cleanupErrors.values()],
          `Session cleanup reported errors for jobs: ${[...cleanupErrors.keys()].join(", ")}`
        );
      }
      return {
        complete: allSessionJobs.length === 0,
        deferred: allSessionJobs.length > 0
      };
    }
    const results = await Promise.allSettled(
      jobs.map((job) =>
        cleanupSessionJobImpl(workspaceRoot, job.id, sessionId, options)
      )
    );
    if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
      return { complete: false, deferred: true };
    }
    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value === true) {
        failedJobs.delete(jobs[index].id);
        cleanupErrors.delete(jobs[index].id);
        return;
      }
      if (result.status === "rejected") {
        cleanupErrors.set(jobs[index].id, result.reason);
        return;
      }
      if (result.value !== true) {
        failedJobs.set(jobs[index].id, jobs[index]);
      }
    });
  }

  if (!isSessionCleanupGenerationCurrent(workspaceRoot, sessionId, options)) {
    return { complete: false, deferred: true };
  }
  const remainingJobIds = listJobsImpl(workspaceRoot)
    .filter((job) => job.sessionId === sessionId)
    .map((job) => job.id);
  const incompleteJobIds = [...new Set(remainingJobIds)];
  if (incompleteJobIds.length > 0) {
    if (options.allowPartial) {
      return { complete: false, deferred: true };
    }
    throw new Error(
      `Session cleanup incomplete for jobs: ${incompleteJobIds.join(", ")}`
    );
  }
  return { complete: true, deferred: false };
}
