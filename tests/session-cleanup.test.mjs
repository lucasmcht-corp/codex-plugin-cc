import test from "node:test";
import assert from "node:assert/strict";

import {
  cleanupSessionJob,
  cleanupSessionJobs,
  prepareSessionStart,
  reconcileWorkspaceJobs
} from "../plugins/codex/scripts/lib/session-cleanup.mjs";
import {
  clearSessionEndingsIf,
  createJobIfSessionActive,
  loadState,
  markSessionEnding,
  upsertJob
} from "../plugins/codex/scripts/lib/state.mjs";
import {
  makePosixWorker,
  makeTempDir,
  makeWindowsWorker
} from "./helpers.mjs";

function makeSteering(worker, address) {
  return {
    version: 1,
    kind: "unix",
    address,
    worker,
    threadId: "thread-1",
    turnId: "turn-1"
  };
}

function createReconciliationState(job) {
  let current = job;
  return {
    listJobsImpl: () => (current ? [current] : []),
    mutateJobIfImpl(_workspace, _jobId, predicate, mutate) {
      if (!current || !predicate(current)) {
        return { matched: false, job: current };
      }
      current = { ...current, ...mutate(current) };
      return { matched: true, job: current };
    },
    current: () => current
  };
}

test("reconciliation fails an active job whose exact owned worker is gone", () => {
  const state = createReconciliationState({
    id: "dead-owned-worker",
    status: "running",
    pid: 1234,
    worker: makePosixWorker()
  });

  reconcileWorkspaceJobs("workspace", {
    ...state,
    inspectOwnedWorkerImpl: () => ({ status: "gone" })
  });

  assert.equal(state.current().status, "failed");
  assert.equal(state.current().pid, null);
  assert.equal(state.current().worker, null);
  assert.match(state.current().errorMessage, /exited without publishing/i);
});

test("a dead owned worker skipped by an exhausted-budget SessionStart is still failed at the status boundary, never left running", async () => {
  const state = createReconciliationState({
    id: "dead-owned-worker-budget-skip",
    status: "running",
    pid: 1234,
    worker: makePosixWorker()
  });
  const inspectOwnedWorkerImpl = () => ({ status: "gone" });

  // The first now() sets deadlineAt; every later call is past it, so SessionStart
  // exhausts its budget before its reconcile loop reaches the job and leaves the
  // dead owned worker untouched (partial recovery, FORK_MAINTENANCE invariant 18).
  let nowCalls = 0;
  await prepareSessionStart("workspace", {
    ...state,
    loadStateImpl: () => ({ endedSessions: [] }),
    inspectOwnedWorkerImpl,
    nowImpl: () => (nowCalls++ === 0 ? 1000 : 5000),
    sessionStartConfig: { recoveryBudgetMs: 3500 }
  });
  assert.equal(state.current().status, "running");

  // The status boundary reconciles without a budget, so a dead owned worker is
  // exposed as a terminal failure and never reported as running (invariant 9).
  reconcileWorkspaceJobs("workspace", {
    ...state,
    inspectOwnedWorkerImpl,
    jobIds: [state.current().id]
  });

  assert.equal(state.current().status, "failed");
  assert.equal(state.current().worker, null);
  assert.equal(state.current().pid, null);
  assert.match(state.current().errorMessage, /exited without publishing/i);
});

test("session cleanup refuses an unknown status without removing its worker record", async () => {
  const invalidJob = {
    id: "invalid-status",
    status: "runing",
    sessionId: "session-invalid",
    worker: makePosixWorker()
  };
  let removeCalls = 0;
  let stopCalls = 0;

  await assert.rejects(
    cleanupSessionJob("workspace", invalidJob.id, invalidJob.sessionId, {
      listJobsImpl: () => [invalidJob],
      removeJobIfImpl: () => {
        removeCalls += 1;
        return { matched: true, removed: true, job: null };
      },
      stopOwnedWorkerTreeImpl: () => {
        stopCalls += 1;
        return true;
      }
    }),
    /refused unknown status/i
  );
  assert.equal(removeCalls, 0);
  assert.equal(stopCalls, 0);
});

test("reconciliation finalizes an owned user cancellation instead of failing it", () => {
  const worker = makePosixWorker();
  const state = createReconciliationState({
    id: "cancelled-owned-worker",
    status: "cancelling",
    phase: "cancelling",
    pid: worker.pid,
    worker,
    steering: null,
    cancellation: {
      token: "cancel-token",
      requestedAt: "2026-07-23T00:00:00.000Z"
    }
  });

  reconcileWorkspaceJobs("workspace", {
    ...state,
    inspectOwnedWorkerImpl: () => ({ status: "gone" }),
    cleanupSteeringEndpointImpl: () => false
  });

  assert.equal(state.current().status, "cancelled");
  assert.equal(state.current().phase, "cancelled");
  assert.equal(state.current().worker, null);
  assert.equal(state.current().cancellation.token, "cancel-token");
});

test("reconciliation fails a dead v1.0.6 worker automatically", () => {
  const state = createReconciliationState({
    id: "dead-legacy-worker",
    status: "running",
    pid: 1234,
    worker: null
  });

  reconcileWorkspaceJobs("workspace", {
    ...state,
    isProcessAliveImpl: () => false
  });

  assert.equal(state.current().status, "failed");
  assert.equal(state.current().pid, null);
  assert.match(state.current().errorMessage, /legacy background worker exited/i);
});

test("session start reclassifies a dead v1.0.6 worker before applying the live gate", async () => {
  const state = createReconciliationState({
    id: "dead-legacy-worker",
    status: "running",
    pid: 1234,
    worker: null
  });

  await prepareSessionStart("workspace", {
    ...state,
    loadStateImpl: () => ({ endedSessions: [] }),
    isProcessAliveImpl: () => false
  });

  assert.equal(state.current().status, "failed");
  assert.equal(state.current().pid, null);
  assert.match(state.current().errorMessage, /legacy background worker exited/i);
});

test("session start still blocks a live v1.0.6 worker", async () => {
  const state = createReconciliationState({
    id: "live-legacy-worker",
    status: "running",
    pid: 1234,
    worker: null
  });

  await assert.rejects(
    prepareSessionStart("workspace", {
      ...state,
      loadStateImpl: () => ({ endedSessions: [] }),
      isProcessAliveImpl: () => true
    }),
    /live v1\.0\.6 background jobs detected/i
  );

  assert.equal(state.current().status, "running");
  assert.equal(state.current().pid, 1234);
});

test("session start inspects at most one bounded reconciliation batch", async () => {
  const jobs = Array.from({ length: 100 }, (_, index) => ({
    id: `owned-worker-${String(index).padStart(3, "0")}`,
    status: "running",
    pid: 1000 + index,
    worker: makePosixWorker({
      pid: 1000 + index,
      token: `worker-token-${index}`,
      startKey: `worker-start-${index}`
    })
  }));
  const inspectedJobPids = [];

  await prepareSessionStart("workspace", {
    listJobsImpl: () => jobs,
    loadStateImpl: () => ({ endedSessions: [] }),
    inspectOwnedWorkerImpl(worker) {
      inspectedJobPids.push(worker.pid);
      return { status: "same" };
    },
    nowImpl: () => 1000,
    sessionStartConfig: {
      recoveryJobBatchSize: 4,
      recoveryBudgetMs: 3500
    }
  });

  assert.deepEqual(inspectedJobPids, [1000, 1001, 1002, 1003]);
});

test("session start establishes its deadline before worker inspection", async () => {
  let nowCalls = 0;
  let inspections = 0;

  await prepareSessionStart("workspace", {
    listJobsImpl: () => [
      {
        id: "owned-worker",
        status: "running",
        pid: 1000,
        worker: makePosixWorker({ pid: 1000 })
      }
    ],
    loadStateImpl: () => ({ endedSessions: [] }),
    inspectOwnedWorkerImpl: () => {
      inspections += 1;
      return { status: "same" };
    },
    nowImpl: () => {
      nowCalls += 1;
      return nowCalls === 1 ? 1000 : 4500;
    },
    sessionStartConfig: {
      recoveryJobBatchSize: 4,
      recoveryBudgetMs: 3500
    }
  });

  assert.equal(inspections, 0);
});

test("session-start reconciliation caps state mutation waits to the remaining deadline", () => {
  const state = createReconciliationState({
    id: "dead-owned-worker",
    status: "running",
    pid: 1234,
    worker: makePosixWorker()
  });
  let mutationOptions = null;
  let inspectionOptions = null;

  reconcileWorkspaceJobs("workspace", {
    ...state,
    deadlineAt: 100,
    nowImpl: () => 0,
    inspectOwnedWorkerImpl(_worker, options) {
      inspectionOptions = options;
      return { status: "gone" };
    },
    mutateJobIfImpl(workspace, jobId, predicate, mutate, options) {
      mutationOptions = options;
      return state.mutateJobIfImpl(workspace, jobId, predicate, mutate);
    }
  });

  assert.deepEqual(mutationOptions, { timeoutMs: 100, pollMs: 10 });
  assert.deepEqual(inspectionOptions, { deadlineAt: 100 });
});

test("session start fails closed when legacy candidates remain uninspected", async () => {
  const jobs = Array.from({ length: 5 }, (_, index) => ({
    id: `legacy-worker-${index}`,
    status: "running",
    pid: 2000 + index,
    worker: null
  }));
  let inspections = 0;

  await assert.rejects(
    prepareSessionStart("workspace", {
      listJobsImpl: () => jobs,
      loadStateImpl: () => ({ endedSessions: [] }),
      isProcessAliveImpl: () => {
        inspections += 1;
        return false;
      },
      nowImpl: () => 1000,
      sessionStartConfig: {
        recoveryJobBatchSize: 4,
        recoveryBudgetMs: 3500
      }
    }),
    /could not inspect 1 legacy v1\.0\.6 background job/i
  );

  assert.equal(inspections, 4);
});

test("reconciliation clears terminal steering debt without a Claude session", () => {
  const worker = makePosixWorker();
  const steering = makeSteering(worker, "/tmp/terminal-steering.sock");
  const state = createReconciliationState({
    id: "terminal-steering-debt",
    status: "failed",
    errorMessage: "turn failed",
    pid: worker.pid,
    worker,
    steering
  });
  let cleaned = null;

  reconcileWorkspaceJobs("workspace", {
    ...state,
    inspectOwnedWorkerImpl: () => ({ status: "gone" }),
    cleanupSteeringEndpointImpl(descriptor, context) {
      cleaned = { descriptor, context };
    },
    steeringConfig: {}
  });

  assert.equal(state.current().status, "failed");
  assert.equal(state.current().errorMessage, "turn failed");
  assert.equal(state.current().pid, null);
  assert.equal(state.current().worker, null);
  assert.equal(state.current().steering, null);
  assert.equal(cleaned.descriptor, steering);
  assert.equal(cleaned.context.worker, worker);
});

test("reconciliation retains terminal steering while its exact worker is alive", () => {
  const worker = makePosixWorker();
  const state = createReconciliationState({
    id: "terminal-steering-live",
    status: "failed",
    pid: worker.pid,
    worker,
    steering: makeSteering(worker, "/tmp/terminal-steering-live.sock")
  });

  reconcileWorkspaceJobs("workspace", {
    ...state,
    inspectOwnedWorkerImpl: () => ({ status: "same" }),
    cleanupSteeringEndpointImpl() {
      throw new Error("live steering must not be cleaned");
    }
  });

  assert.equal(state.current().worker, worker);
  assert.equal(state.current().steering.address, "/tmp/terminal-steering-live.sock");
});

test("reconciliation leaves a current queued launch alone", () => {
  const launcher = {
    pid: 1234,
    startKey: "launcher-start"
  };
  const state = createReconciliationState({
    id: "current-launch",
    status: "queued",
    launchToken: "launch-token",
    launcher,
    worker: null
  });

  reconcileWorkspaceJobs("workspace", {
    ...state,
    inspectProcessIdentityImpl: () => launcher,
    isProcessAliveImpl: () => {
      throw new Error("queued launch should not inspect a process");
    }
  });

  assert.equal(state.current().status, "queued");
});

test("reconciliation fails an unclaimed launch whose launcher generation is gone", () => {
  const launcher = {
    pid: 1234,
    token: "launch-token",
    startKey: "launcher-start"
  };
  const state = createReconciliationState({
    id: "abandoned-launch",
    status: "queued",
    phase: "spawning",
    launchToken: "launch-token",
    launcher,
    worker: null
  });

  reconcileWorkspaceJobs("workspace", {
    ...state,
    inspectProcessIdentityImpl: () => null
  });

  assert.equal(state.current().status, "failed");
  assert.equal(state.current().launcher, null);
  assert.match(state.current().errorMessage, /launcher exited before worker spawn/i);
});

test("session start keeps an ended generation blocked until cleanup succeeds", async () => {
  const endedSession = {
    sessionId: "session-1",
    endedAt: "2026-03-18T15:30:00.000Z"
  };
  const events = [];
  let jobs = [{ id: "job-1", sessionId: "session-1" }];

  await prepareSessionStart("workspace", {
    loadStateImpl: () => ({ endedSessions: [endedSession] }),
    listJobsImpl: () => jobs,
    cleanupSessionJobsImpl: async () => {
      events.push("cleanup");
      jobs = [];
    },
    clearSessionEndingsIfImpl(_workspace, expected) {
      assert.deepEqual(expected, [endedSession]);
      events.push("clear");
      return {
        clearedSessionIds: ["session-1"],
        conflictedSessionIds: []
      };
    }
  });

  assert.deepEqual(events, ["cleanup", "clear"]);
});

test("failed session-start cleanup preserves the ended generation", async () => {
  let clearCalls = 0;

  await assert.rejects(
    prepareSessionStart("workspace", {
      loadStateImpl: () => ({
        endedSessions: [
          {
            sessionId: "session-1",
            endedAt: "2026-03-18T15:30:00.000Z"
          }
        ]
      }),
      reconcileWorkspaceJobsImpl: () => {},
      listJobsImpl: () => [{ sessionId: "session-1" }],
      cleanupSessionJobsImpl: async () => {
        throw new Error("cleanup failed");
      },
      clearSessionEndingsIfImpl: () => {
        clearCalls += 1;
        return {
          clearedSessionIds: [],
          conflictedSessionIds: []
        };
      }
    }),
    /cleanup failed/
  );

  assert.equal(clearCalls, 0);
});

test("session start cannot clear a newer concurrent session end", async () => {
  let jobs = [{ id: "job-1", sessionId: "session-1" }];
  await assert.rejects(
    prepareSessionStart("workspace", {
      loadStateImpl: () => ({
        endedSessions: [
          {
            sessionId: "session-1",
            endedAt: "2026-03-18T15:30:00.000Z"
          }
        ]
      }),
      listJobsImpl: () => jobs,
      cleanupSessionJobsImpl: async () => {
        jobs = [];
      },
      clearSessionEndingsIfImpl: () => ({
        clearedSessionIds: [],
        conflictedSessionIds: ["session-1"]
      })
    }),
    /ended again/
  );
});

test("session start recovers one bounded batch and clears it in one transaction", async () => {
  const endedSessions = Array.from({ length: 1003 }, (_, index) => ({
    sessionId: `session-${String(index).padStart(4, "0")}`,
    endedAt: new Date(index * 1000).toISOString()
  }));
  const cleanupCalls = [];
  const clearCalls = [];
  const remainingSessionIds = new Set(
    endedSessions.map((entry) => entry.sessionId)
  );

  await prepareSessionStart("workspace", {
    loadStateImpl: () => ({ endedSessions }),
    listJobsImpl: () =>
      endedSessions
        .filter((entry) => remainingSessionIds.has(entry.sessionId))
        .map((entry) => ({
          id: `job-${entry.sessionId}`,
          sessionId: entry.sessionId
        })),
    cleanupSessionJobsImpl: async (_workspace, sessionId) => {
      cleanupCalls.push(sessionId);
      remainingSessionIds.delete(sessionId);
    },
    clearSessionEndingsIfImpl(_workspace, entries) {
      clearCalls.push(entries);
      return {
        clearedSessionIds: entries.map((entry) => entry.sessionId),
        conflictedSessionIds: []
      };
    },
    sessionStartConfig: { recoveryBatchSize: 4 }
  });

  assert.deepEqual(cleanupCalls, [
    "session-0000",
    "session-0001",
    "session-0002",
    "session-0003"
  ]);
  assert.equal(clearCalls.length, 1);
  assert.deepEqual(
    clearCalls[0].map((entry) => entry.sessionId),
    cleanupCalls
  );
});

test("session start skips ending-marker mutation after its deadline", async () => {
  const endedSession = {
    sessionId: "ended-session",
    endedAt: "2026-03-18T15:30:00.000Z"
  };
  let now = 0;
  let jobs = [
    {
      id: "ended-job",
      sessionId: endedSession.sessionId,
      status: "failed"
    }
  ];
  let clearCalls = 0;

  await prepareSessionStart("workspace", {
    nowImpl: () => now,
    loadStateImpl: () => ({ endedSessions: [endedSession] }),
    listJobsImpl: () => jobs,
    cleanupSessionJobsImpl: async () => {
      jobs = [];
      now = 10;
    },
    clearSessionEndingsIfImpl: () => {
      clearCalls += 1;
      return {
        clearedSessionIds: [endedSession.sessionId],
        conflictedSessionIds: []
      };
    },
    sessionStartConfig: {
      recoveryBudgetMs: 10
    }
  });

  assert.equal(clearCalls, 0);
});

test("session start gives ended-session cleanup priority over unrelated healthy jobs", async () => {
  const endedSession = {
    sessionId: "old-ended-session",
    endedAt: "2026-03-18T15:30:00.000Z"
  };
  const healthyJobs = Array.from({ length: 4 }, (_, index) => ({
    id: `healthy-${index}`,
    status: "running",
    pid: 2000 + index,
    worker: makePosixWorker({
      pid: 2000 + index,
      token: `healthy-token-${index}`,
      startKey: `healthy-start-${index}`
    })
  }));
  let endedJob = {
    id: "old-ended-job",
    sessionId: endedSession.sessionId,
    status: "running",
    pid: 3000,
    worker: makePosixWorker({
      pid: 3000,
      token: "ended-token",
      startKey: "ended-start"
    })
  };
  const cleanupJobIds = [];
  let cleanupAttempts = 0;
  let clearCalls = 0;

  const start = () =>
    prepareSessionStart("workspace", {
      loadStateImpl: () => ({ endedSessions: [endedSession] }),
      listJobsImpl: () => [
        ...healthyJobs,
        ...(endedJob ? [endedJob] : [])
      ],
      inspectOwnedWorkerImpl: () => ({ status: "same" }),
      cleanupSessionJobsImpl: async (_workspace, _sessionId, options) => {
        cleanupAttempts += 1;
        cleanupJobIds.push(...(options.jobIds ?? []));
        if (cleanupAttempts === 2) {
          endedJob = null;
        }
        return {
          complete: cleanupAttempts === 2,
          deferred: cleanupAttempts !== 2
        };
      },
      clearSessionEndingsIfImpl: () => {
        clearCalls += 1;
        return {
          clearedSessionIds: [endedSession.sessionId],
          conflictedSessionIds: []
        };
      },
      sessionStartConfig: {
        recoveryJobBatchSize: 4,
        recoveryBudgetMs: 3500
      }
    });

  await start();
  await start();

  assert.equal(cleanupAttempts, 2);
  assert.deepEqual(cleanupJobIds, ["old-ended-job", "old-ended-job"]);
  assert.equal(clearCalls, 1);
});

test("session cleanup reclassifies a queued job that claims its worker during removal", async () => {
  const worker = makePosixWorker();
  let current = {
    id: "job-race",
    sessionId: "session-1",
    status: "queued",
    launchToken: "launch-token",
    worker: null
  };
  let stopCalls = 0;

  const cleaned = await cleanupSessionJob("workspace", current.id, current.sessionId, {
    listJobsImpl: () => (current ? [current] : []),
    removeJobIfImpl(_workspace, _jobId, predicate) {
      if (current.status === "queued") {
        current = {
          ...current,
          status: "running",
          worker
        };
        return { matched: false, job: current };
      }
      if (!predicate(current)) {
        return { matched: false, job: current };
      }
      current = null;
      return { matched: true, job: null };
    },
    mutateJobIfImpl(_workspace, _jobId, predicate, mutate) {
      if (!predicate(current)) {
        return { matched: false, job: current };
      }
      current = {
        ...current,
        ...mutate(current)
      };
      return { matched: true, job: current };
    },
    async stopOwnedWorkerTreeImpl(observedWorker) {
      stopCalls += 1;
      assert.equal(observedWorker, worker);
      return { stopped: true, forced: false };
    }
  });

  assert.equal(cleaned, true);
  assert.equal(stopCalls, 1);
  assert.equal(current, null);
});

test("session cleanup removes a job that becomes terminal before reservation", async () => {
  const worker = makePosixWorker();
  let current = {
    id: "job-terminal-race",
    sessionId: "session-1",
    status: "running",
    worker
  };

  const cleaned = await cleanupSessionJob("workspace", current.id, current.sessionId, {
    listJobsImpl: () => (current ? [current] : []),
    mutateJobIfImpl() {
      current = {
        ...current,
        status: "completed",
        worker: null
      };
      return { matched: false, job: current };
    },
    removeJobIfImpl(_workspace, _jobId, predicate) {
      if (!predicate(current)) {
        return { matched: false, job: current };
      }
      current = null;
      return { matched: true, job: null };
    },
    async stopOwnedWorkerTreeImpl() {
      throw new Error("terminal jobs must not be stopped");
    }
  });

  assert.equal(cleaned, true);
  assert.equal(current, null);
});

test("session cleanup retries retained steering metadata on a terminal job", async () => {
  const worker = makePosixWorker();
  let current = {
    id: "job-terminal-cleanup",
    sessionId: "session-1",
    status: "failed",
    worker,
    steering: makeSteering(worker, "/tmp/retry.sock")
  };
  let cleanupCalls = 0;

  const cleaned = await cleanupSessionJob(
    "workspace",
    current.id,
    current.sessionId,
    {
      listJobsImpl: () => (current ? [current] : []),
      removeJobIfImpl(_workspace, _jobId, predicate) {
        if (!predicate(current)) {
          return { matched: false, job: current };
        }
        current = null;
        return { matched: true, job: null };
      },
      cleanupSteeringEndpointImpl() {
        cleanupCalls += 1;
      },
      steeringConfig: {}
    }
  );

  assert.equal(cleaned, true);
  assert.equal(cleanupCalls, 1);
  assert.equal(current, null);
});

test("session cleanup reports a worker whose owned stop failed without retrying it", async () => {
  const job = {
    id: "job-stop-failed",
    sessionId: "session-1",
    status: "running",
    worker: makePosixWorker()
  };
  let cleanupCalls = 0;

  await assert.rejects(
    cleanupSessionJobs("workspace", job.sessionId, {
      listJobsImpl: () => [job],
      async cleanupSessionJobImpl() {
        cleanupCalls += 1;
        return false;
      }
    }),
    /job-stop-failed/
  );

  assert.equal(cleanupCalls, 1);
});

test("session cleanup retries a replacement POSIX or Windows worker generation", async () => {
  const generations = [
    [
      makePosixWorker({ pid: 1234, processGroupId: 1234 }),
      makePosixWorker({ pid: 4321, processGroupId: 4321 })
    ],
    [
      makeWindowsWorker({ pid: 1234 }),
      makeWindowsWorker({
        pid: 4321,
        token: "replacement-worker"
      })
    ]
  ];

  for (const [firstWorker, replacementWorker] of generations) {
    let current = {
      id: `replacement-${firstWorker.platform}`,
      sessionId: "session-replacement",
      status: "running",
      worker: firstWorker
    };
    let cleanupCalls = 0;

    await cleanupSessionJobs("workspace", current.sessionId, {
      listJobsImpl: () => (current ? [current] : []),
      async cleanupSessionJobImpl() {
        cleanupCalls += 1;
        if (cleanupCalls === 1) {
          current = {
            ...current,
            worker: replacementWorker
          };
          return false;
        }
        current = null;
        return true;
      }
    });

    assert.equal(cleanupCalls, 2);
    assert.equal(current, null);
  }
});

test("session cleanup reports an active job that has no owned worker identity", async () => {
  const job = {
    id: "orphan-running",
    sessionId: "session-1",
    status: "running",
    worker: null
  };
  let cleanupCalls = 0;

  await assert.rejects(
    cleanupSessionJobs("workspace", job.sessionId, {
      listJobsImpl: () => [job],
      async cleanupSessionJobImpl() {
        cleanupCalls += 1;
        return false;
      }
    }),
    /orphan-running/
  );

  assert.equal(cleanupCalls, 1);
});

test("session cleanup succeeds when a failed candidate disappeared concurrently", async () => {
  const job = {
    id: "concurrently-cleaned",
    sessionId: "session-1",
    status: "running",
    worker: null
  };
  let currentJobs = [job];

  await cleanupSessionJobs("workspace", job.sessionId, {
    listJobsImpl: () => currentJobs,
    async cleanupSessionJobImpl() {
      currentJobs = [];
      return false;
    }
  });

  assert.deepEqual(currentJobs, []);
});

test("session cleanup rechecks a failed candidate that became terminal", async () => {
  let current = {
    id: "concurrently-finished",
    sessionId: "session-1",
    status: "running",
    worker: null
  };
  let cleanupCalls = 0;

  await cleanupSessionJobs("workspace", current.sessionId, {
    listJobsImpl: () => (current ? [current] : []),
    async cleanupSessionJobImpl() {
      cleanupCalls += 1;
      if (cleanupCalls === 1) {
        current = {
          ...current,
          status: "completed"
        };
        return false;
      }
      current = null;
      return true;
    }
  });

  assert.equal(cleanupCalls, 2);
  assert.equal(current, null);
});

test("session cleanup does not remove a launcher that is still spawning", async () => {
  let current = {
    id: "job-spawning",
    sessionId: "session-1",
    status: "queued",
    phase: "spawning",
    launchToken: "launch-token",
    worker: null
  };

  await assert.rejects(
    cleanupSessionJobs("workspace", current.sessionId, {
      listJobsImpl: () => (current ? [current] : []),
      mutateJobIfImpl(_workspace, _jobId, predicate, mutate) {
        if (!predicate(current)) {
          return { matched: false, job: current };
        }
        current = {
          ...current,
          ...mutate(current)
        };
        return { matched: true, job: current };
      },
      launchWaitAttempts: 1,
      sleepImpl: async () => {}
    }),
    /job-spawning/
  );

  assert.equal(current.status, "cancelling");
  assert.equal(current.phase, "session-cleanup");
});

test("session cleanup retains retry metadata when steering cleanup fails", async () => {
  const worker = makePosixWorker();
  let current = {
    id: "job-steering-cleanup",
    sessionId: "session-1",
    status: "running",
    worker,
    steering: makeSteering(worker, "/tmp/stale.sock")
  };

  await assert.rejects(
    cleanupSessionJobs("workspace", current.sessionId, {
      listJobsImpl: () => (current ? [current] : []),
      mutateJobIfImpl(_workspace, _jobId, predicate, mutate) {
        if (!predicate(current)) {
          return { matched: false, job: current };
        }
        current = { ...current, ...mutate(current) };
        return { matched: true, job: current };
      },
      removeJobIfImpl(_workspace, _jobId, predicate) {
        if (!predicate(current)) {
          return { matched: false, job: current };
        }
        current = null;
        return { matched: true, job: null };
      },
      async stopOwnedWorkerTreeImpl() {
        return { stopped: true, forced: false };
      },
      cleanupSteeringEndpointImpl() {
        throw new Error("cannot unlink steering endpoint");
      },
      steeringConfig: {}
    }),
    /job-steering-cleanup/
  );

  assert.equal(current.status, "cancelling");
  assert.deepEqual(current.worker, worker);
  assert.deepEqual(current.steering, makeSteering(worker, "/tmp/stale.sock"));
});

test("session cleanup caps lock waits and worker shutdown to its remaining deadline", async () => {
  const worker = makePosixWorker({
    token: "worker-budget-token",
    startKey: "worker-budget-start"
  });
  let current = {
    id: "job-budget",
    sessionId: "session-budget",
    status: "running",
    worker
  };
  let mutationOptions = null;
  let stopOptions = null;

  const cleaned = await cleanupSessionJob(
    "workspace",
    current.id,
    current.sessionId,
    {
      deadlineAt: 100,
      nowImpl: () => 0,
      workerConfig: {
        stopGraceMs: 1000,
        stopKillMs: 2000
      },
      listJobsImpl: () => [current],
      mutateJobIfImpl(_workspace, _jobId, predicate, mutate, options) {
        mutationOptions = options;
        if (!predicate(current)) {
          return { matched: false, job: current };
        }
        current = { ...current, ...mutate(current) };
        return { matched: true, job: current };
      },
      stopOwnedWorkerTreeImpl: async (_worker, options) => {
        stopOptions = options;
        return { stopped: false };
      }
    }
  );

  assert.equal(cleaned, false);
  assert.deepEqual(mutationOptions, { timeoutMs: 100, pollMs: 10 });
  assert.equal(stopOptions.graceMs + stopOptions.killMs, 100);
  assert.equal(stopOptions.graceMs, 50);
  assert.equal(stopOptions.killMs, 50);
  assert.equal(stopOptions.deadlineAt, 100);
});

test("session cleanup returns deferred without starting another round after its deadline", async () => {
  let cleanupCalls = 0;
  const result = await cleanupSessionJobs("workspace", "session-deadline", {
    deadlineAt: 10,
    nowImpl: () => 10,
    allowPartial: true,
    listJobsImpl: () => [
      {
        id: "job-deadline",
        sessionId: "session-deadline",
        status: "running"
      }
    ],
    cleanupSessionJobImpl: async () => {
      cleanupCalls += 1;
      return true;
    }
  });

  assert.deepEqual(result, { complete: false, deferred: true });
  assert.equal(cleanupCalls, 0);
});

test("a concurrent SessionStart invalidates the exact SessionEnd cleanup generation", async () => {
  const workspace = makeTempDir();
  const sessionId = "session-generation-race";
  const worker = makePosixWorker();
  const oldJob = {
    id: "generation-race-job",
    sessionId,
    status: "running",
    worker
  };
  upsertJob(workspace, oldJob);
  const sessionEnding = markSessionEnding(workspace, sessionId);
  let scanCount = 0;
  let mutationCount = 0;
  let removalCount = 0;
  let stopCount = 0;

  const result = await cleanupSessionJobs(workspace, sessionId, {
    sessionEnding,
    allowPartial: true,
    listJobsImpl() {
      scanCount += 1;
      const scannedJobs = loadState(workspace).jobs;
      if (scanCount === 2) {
        assert.deepEqual(
          clearSessionEndingsIf(workspace, [sessionEnding]),
          {
            clearedSessionIds: [sessionId],
            conflictedSessionIds: []
          }
        );
        assert.equal(
          createJobIfSessionActive(workspace, {
            ...oldJob,
            title: "replacement generation"
          }).created,
          true
        );
      }
      return scannedJobs;
    },
    mutateJobIfImpl() {
      mutationCount += 1;
      throw new Error("stale SessionEnd reserved the replacement generation");
    },
    removeJobIfImpl() {
      removalCount += 1;
      throw new Error("stale SessionEnd removed the replacement generation");
    },
    async stopOwnedWorkerTreeImpl() {
      stopCount += 1;
      throw new Error("stale SessionEnd stopped the replacement generation");
    }
  });

  assert.deepEqual(result, { complete: false, deferred: true });
  assert.equal(scanCount, 2);
  assert.equal(mutationCount, 0);
  assert.equal(removalCount, 0);
  assert.equal(stopCount, 0);
  assert.equal(loadState(workspace).jobs[0].title, "replacement generation");
});
