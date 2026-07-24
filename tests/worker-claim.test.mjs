import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { makePosixWorker, makeTempDir } from "./helpers.mjs";
import { loadState, mutateJobIf, upsertJob } from "../plugins/codex/scripts/lib/state.mjs";
import {
  cleanupFailedWorkerLaunch,
  recordSpawnedWorker,
  waitForWorkerClaim
} from "../plugins/codex/scripts/lib/worker-claim.mjs";

test("a worker claim on the final poll is observed instead of reported as a timeout", async () => {
  const workspace = makeTempDir();
  const jobId = "job-late-claim";
  const launchToken = "late-token";
  upsertJob(workspace, {
    id: jobId,
    status: "queued",
    launchToken,
    worker: null
  });

  let clock = 0;
  const claimed = await waitForWorkerClaim(workspace, jobId, launchToken, {
    timeoutMs: 10,
    pollMs: 10,
    now: () => clock,
    sleep: async () => {
      mutateJobIf(
        workspace,
        jobId,
        (current) => current.status === "queued",
        () => ({
          status: "running",
          startedAt: "2026-07-23T12:00:00.000Z",
          worker: {
            version: 1,
            pid: 1234,
            token: launchToken,
            startKey: "late-start",
            platform: "linux",
            processGroupId: 1234
          }
        })
      );
      clock = 10;
    }
  });

  assert.equal(claimed.status, "running");
  assert.equal(claimed.worker.token, launchToken);
});

test("only an atomic queued-to-cancelling transition can report a claim timeout", async () => {
  const workspace = makeTempDir();
  const jobId = "job-timeout";
  const launchToken = "timeout-token";
  upsertJob(workspace, {
    id: jobId,
    status: "queued",
    launchToken,
    worker: null
  });

  await assert.rejects(
    waitForWorkerClaim(workspace, jobId, launchToken, {
      timeoutMs: 0
    }),
    /did not claim its manifest/i
  );

  const storedJob = loadState(workspace).jobs[0];
  assert.equal(storedJob.status, "cancelling");
  assert.match(storedJob.errorMessage, /did not claim its manifest/i);
});

test("claim timeout cannot cancel another POSIX worker generation with the same token", async () => {
  const workspace = makeTempDir();
  const jobId = "job-timeout-generation-race";
  const launchToken = "timeout-generation-token";
  const recordedWorker = makePosixWorker({
    pid: 1234,
    token: launchToken,
    processGroupId: 1234
  });
  const expectedWorker = makePosixWorker({
    pid: 4321,
    token: launchToken,
    processGroupId: 4321
  });
  upsertJob(workspace, {
    id: jobId,
    status: "queued",
    launchToken,
    worker: recordedWorker
  });

  await assert.rejects(
    waitForWorkerClaim(workspace, jobId, launchToken, {
      worker: expectedWorker,
      timeoutMs: 0
    }),
    /changed during timeout handling/i
  );

  const storedJob = loadState(workspace).jobs[0];
  assert.equal(storedJob.status, "queued");
  assert.deepEqual(storedJob.worker, recordedWorker);
});

test("a worker that finishes on the final poll still counts as claimed", async () => {
  const workspace = makeTempDir();
  const jobId = "job-fast-completion";
  const launchToken = "fast-token";
  upsertJob(workspace, {
    id: jobId,
    status: "queued",
    launchToken,
    worker: null
  });

  let clock = 0;
  const claimed = await waitForWorkerClaim(workspace, jobId, launchToken, {
    timeoutMs: 10,
    pollMs: 10,
    now: () => clock,
    sleep: async () => {
      mutateJobIf(
        workspace,
        jobId,
        (current) => current.status === "queued",
        () => ({
          status: "completed",
          startedAt: "2026-07-23T12:00:00.000Z",
          completedAt: "2026-07-23T12:00:00.001Z",
          worker: null
        })
      );
      clock = 10;
    }
  });

  assert.equal(claimed.status, "completed");
  assert.equal(claimed.launchToken, launchToken);
});

test("a worker that finished before parent recording still counts as spawned", () => {
  const workspace = makeTempDir();
  const jobId = "job-finished-before-recording";
  const launchToken = "finished-before-recording-token";
  upsertJob(workspace, {
    id: jobId,
    status: "completed",
    launchToken,
    startedAt: "2026-07-23T12:00:00.000Z",
    completedAt: "2026-07-23T12:00:00.001Z",
    worker: null
  });

  const recording = recordSpawnedWorker(
    workspace,
    jobId,
    1234,
    launchToken,
    {
      captureUnclaimedWorkerImpl: () => null
    }
  );

  assert.equal(recording.recorded, true);
  assert.equal(recording.job.status, "completed");
});

test("parent recording rejects a different active worker identity", () => {
  const workspace = makeTempDir();
  const jobId = "job-different-active-worker";
  const launchToken = "different-active-token";
  upsertJob(workspace, {
    id: jobId,
    status: "running",
    launchToken,
    startedAt: "2026-07-23T12:00:00.000Z",
    worker: {
      version: 1,
      pid: 5678,
      token: launchToken,
      startKey: "different-start",
      platform: "linux",
      processGroupId: 5678
    }
  });

  const recording = recordSpawnedWorker(
    workspace,
    jobId,
    1234,
    launchToken,
    {
      captureUnclaimedWorkerImpl: () => ({
        version: 1,
        pid: 1234,
        token: launchToken,
        startKey: "parent-start",
        platform: "linux",
        processGroupId: 1234
      })
    }
  );

  assert.equal(recording.recorded, false);
  assert.equal(recording.job.worker.pid, 5678);
});

test("a detached worker is stopped when its manifest claim fails", async (t) => {
  const directory = makeTempDir();
  const script = path.join(directory, "unclaimed-worker.mjs");
  const launchToken = "unclaimed-worker-token";
  const jobId = "job-unclaimed-worker";
  fs.writeFileSync(script, "setInterval(() => {}, 1000);\n", "utf8");
  upsertJob(directory, {
    id: jobId,
    status: "cancelling",
    phase: "claim-timeout",
    launchToken,
    worker: null
  });
  const child = spawn(
    process.execPath,
    [script, "--worker-token", launchToken],
    {
      detached: true,
      stdio: "ignore"
    }
  );
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.unref();
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // The helper already stopped the detached process group.
    }
  });

  await cleanupFailedWorkerLaunch(
    directory,
    {
      id: jobId,
      status: "cancelling",
      launchToken
    },
    child.pid,
    launchToken,
    new Error("claim timed out")
  );

  assert.throws(() => process.kill(child.pid, 0), { code: "ESRCH" });
  assert.equal(loadState(directory).jobs[0].status, "failed");
});

test("a failed launch cleanup preserves the owned worker identity for retry", async () => {
  const workspace = makeTempDir();
  const jobId = "job-launch-cleanup-failed";
  const launchToken = "launch-cleanup-token";
  const worker = {
    version: 1,
    pid: 1234,
    token: launchToken,
    startKey: "worker-start",
    platform: "linux",
    processGroupId: 1234
  };
  upsertJob(workspace, {
    id: jobId,
    status: "cancelling",
    phase: "claim-timeout",
    launchToken,
    worker: null
  });

  await assert.rejects(
    cleanupFailedWorkerLaunch(
      workspace,
      {
        id: jobId,
        status: "cancelling",
        launchToken
      },
      worker.pid,
      launchToken,
      new Error("claim timed out"),
      {
        captureUnclaimedWorkerImpl: () => worker,
        async stopOwnedWorkerTreeImpl() {
          throw new Error("stop failed");
        }
      }
    ),
    /could not be stopped/
  );

  const storedJob = loadState(workspace).jobs[0];
  assert.equal(storedJob.status, "cancelling");
  assert.equal(storedJob.phase, "launch-cleanup-failed");
  assert.equal(storedJob.pid, worker.pid);
  assert.deepEqual(storedJob.worker, worker);
  assert.match(storedJob.errorMessage, /stop failed/);
});

test("a missing manifest is recovered when launch cleanup cannot stop the worker", async () => {
  const workspace = makeTempDir();
  const jobId = "job-missing-during-cleanup";
  const launchToken = "missing-cleanup-token";
  const worker = {
    version: 1,
    pid: 4321,
    token: launchToken,
    startKey: "missing-start",
    platform: "linux",
    processGroupId: 4321
  };

  await assert.rejects(
    cleanupFailedWorkerLaunch(
      workspace,
      {
        id: jobId,
        sessionId: "session-ended",
        status: "queued",
        launchToken
      },
      worker.pid,
      launchToken,
      new Error("manifest disappeared"),
      {
        captureUnclaimedWorkerImpl: () => worker,
        async stopOwnedWorkerTreeImpl() {
          throw new Error("stop failed");
        }
      }
    ),
    /could not be stopped/
  );

  const recovered = loadState(workspace).jobs[0];
  assert.equal(recovered.id, jobId);
  assert.equal(recovered.status, "cancelling");
  assert.equal(recovered.phase, "launch-cleanup-failed");
  assert.deepEqual(recovered.worker, worker);
});

test("a persistence error does not prevent stopping a captured worker", async () => {
  const workspace = makeTempDir();
  const jobId = "job-persist-error";
  const launchToken = "persist-error-token";
  const worker = {
    version: 1,
    pid: 9876,
    token: launchToken,
    startKey: "persist-start",
    platform: "linux",
    processGroupId: 9876
  };
  upsertJob(workspace, {
    id: jobId,
    status: "cancelling",
    launchToken,
    worker: null
  });
  let stopCalls = 0;

  await cleanupFailedWorkerLaunch(
    workspace,
    {
      id: jobId,
      status: "cancelling",
      launchToken
    },
    worker.pid,
    launchToken,
    new Error("claim failed"),
    {
      captureUnclaimedWorkerImpl: () => worker,
      preserveLaunchCleanupJobImpl() {
        throw new Error("state unavailable");
      },
      async stopOwnedWorkerTreeImpl() {
        stopCalls += 1;
        return { stopped: true, forced: false };
      }
    }
  );

  assert.equal(stopCalls, 1);
  assert.equal(loadState(workspace).jobs[0].status, "failed");
});
