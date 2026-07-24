import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { makePosixWorker, makeTempDir } from "./helpers.mjs";
import {
  loadState,
  mutateJobIf,
  resolveJobLogFile,
  upsertJob
} from "../plugins/codex/scripts/lib/state.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  readJobLogTail,
  removeUnpublishedJobLog,
  runTrackedJob
} from "../plugins/codex/scripts/lib/tracked-jobs.mjs";
import { readJobProgressPreview } from "../plugins/codex/scripts/lib/job-control.mjs";

test("tracked job logs are created with private permissions", () => {
  const workspace = makeTempDir();
  const logFile = createJobLogFile(workspace, "job-private-log", "Private log");

  if (process.platform !== "win32") {
    assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
  }
});

test("tracked job log creation never follows or truncates an existing leaf", () => {
  for (const kind of ["symlink", "file"]) {
    const workspace = makeTempDir();
    const logFile = resolveJobLogFile(workspace, `job-existing-${kind}`);
    const target = `${logFile}.target`;
    fs.writeFileSync(target, "preserve target\n", {
      encoding: "utf8",
      mode: 0o600
    });
    if (kind === "symlink") {
      fs.symlinkSync(target, logFile);
    } else {
      fs.writeFileSync(logFile, "preserve existing\n", {
        encoding: "utf8",
        mode: 0o600
      });
    }

    assert.throws(
      () => createJobLogFile(workspace, `job-existing-${kind}`, "Unsafe"),
      /EEXIST|exists/i
    );
    assert.equal(fs.readFileSync(target, "utf8"), "preserve target\n");
    if (kind === "symlink") {
      assert.equal(fs.lstatSync(logFile).isSymbolicLink(), true);
    } else {
      assert.equal(fs.readFileSync(logFile, "utf8"), "preserve existing\n");
    }
  }
});

test("tracked job log append never follows a replacement symlink", () => {
  const workspace = makeTempDir();
  const jobId = "job-append-symlink";
  const logFile = createJobLogFile(workspace, jobId, "Safe");
  const target = `${logFile}.target`;
  fs.writeFileSync(target, "preserve target\n", {
    encoding: "utf8",
    mode: 0o600
  });
  fs.unlinkSync(logFile);
  fs.symlinkSync(target, logFile);

  assert.throws(
    () => appendLogLine(logFile, "must not escape"),
    /not a regular file|ELOOP/i
  );
  assert.equal(fs.readFileSync(target, "utf8"), "preserve target\n");
});

test("tracked job log tail reads only the bounded end of a large private log", () => {
  const workspace = makeTempDir();
  const logFile = createJobLogFile(workspace, "job-bounded-tail", "");
  fs.writeFileSync(
    logFile,
    [
      "[2026-07-24T10:00:00.000Z] EARLY_PROGRESS_MUST_NOT_BE_READ",
      "x".repeat(256 * 1024),
      "[2026-07-24T10:01:00.000Z] Late progress one",
      "[2026-07-24T10:01:01.000Z] Late progress two"
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 }
  );

  const tail = readJobLogTail(logFile, 256);
  assert.equal(tail.truncated, true);
  assert.ok(Buffer.byteLength(tail.content, "utf8") <= 256);
  assert.doesNotMatch(tail.content, /EARLY_PROGRESS_MUST_NOT_BE_READ/);
  assert.deepEqual(readJobProgressPreview(logFile, 2), [
    "Late progress one",
    "Late progress two"
  ]);
});

test("tracked job log tail never follows a replacement symlink", {
  skip: process.platform === "win32"
}, () => {
  const workspace = makeTempDir();
  const logFile = createJobLogFile(workspace, "job-read-symlink", "");
  const target = `${logFile}.target`;
  fs.writeFileSync(target, "OUTSIDE_LOG_CONTENT\n", {
    encoding: "utf8",
    mode: 0o600
  });
  fs.unlinkSync(logFile);
  fs.symlinkSync(target, logFile);

  assert.throws(
    () => readJobLogTail(logFile),
    /not a regular file|ELOOP/i
  );
});

test("tracked job log tail reports descriptor close failures", () => {
  const workspace = makeTempDir();
  const logFile = createJobLogFile(workspace, "job-read-close", "");
  fs.writeFileSync(logFile, "[2026-07-24T10:00:00.000Z] Progress\n", {
    encoding: "utf8",
    mode: 0o600
  });
  const closeError = new Error("descriptor close failed");
  const originalCloseSync = fs.closeSync;
  fs.closeSync = (fileDescriptor) => {
    originalCloseSync(fileDescriptor);
    throw closeError;
  };

  try {
    assert.throws(
      () => readJobLogTail(logFile),
      (error) => error === closeError
    );
  } finally {
    fs.closeSync = originalCloseSync;
  }
});

test("tracked job log creation removes a partial file when its descriptor write fails", () => {
  const workspace = makeTempDir();
  const jobId = "job-write-failure";
  const logFile = resolveJobLogFile(workspace, jobId);
  const writeError = new Error("descriptor write failed");
  const originalWriteFileSync = fs.writeFileSync;
  fs.writeFileSync = (file, data, options) => {
    if (typeof file === "number") {
      throw writeError;
    }
    return originalWriteFileSync(file, data, options);
  };

  try {
    assert.throws(
      () => createJobLogFile(workspace, jobId, "Write failure"),
      (error) => error === writeError
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }
  assert.equal(fs.existsSync(logFile), false);
});

test("tracked job log creation removes a partial file when descriptor validation fails", () => {
  const workspace = makeTempDir();
  const jobId = "job-fstat-failure";
  const logFile = resolveJobLogFile(workspace, jobId);
  const validationError = new Error("descriptor validation failed");
  const originalFstatSync = fs.fstatSync;
  fs.fstatSync = () => {
    throw validationError;
  };

  try {
    assert.throws(
      () => createJobLogFile(workspace, jobId, "Validation failure"),
      (error) => error === validationError
    );
  } finally {
    fs.fstatSync = originalFstatSync;
  }
  assert.equal(fs.existsSync(logFile), false);
});

test("tracked job log creation preserves write and cleanup failures", () => {
  const workspace = makeTempDir();
  const jobId = "job-write-cleanup-failure";
  const logFile = resolveJobLogFile(workspace, jobId);
  const writeError = new Error("descriptor write failed");
  const cleanupError = new Error("log cleanup failed");
  const originalWriteFileSync = fs.writeFileSync;
  const originalUnlinkSync = fs.unlinkSync;
  fs.writeFileSync = (file, data, options) => {
    if (typeof file === "number") {
      throw writeError;
    }
    return originalWriteFileSync(file, data, options);
  };
  fs.unlinkSync = (file) => {
    if (file === logFile) {
      throw cleanupError;
    }
    return originalUnlinkSync(file);
  };

  try {
    assert.throws(
      () => createJobLogFile(workspace, jobId, "Aggregate failure"),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [writeError, cleanupError]);
        return true;
      }
    );
  } finally {
    fs.writeFileSync = originalWriteFileSync;
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.equal(fs.existsSync(logFile), true);
});

test("unpublished job log cleanup preserves publication and cleanup failures", () => {
  const workspace = makeTempDir();
  const logFile = createJobLogFile(
    workspace,
    "job-publication-cleanup-failure",
    "Publication"
  );
  const publicationError = new Error("state publication failed");
  const cleanupError = new Error("log cleanup failed");
  const originalUnlinkSync = fs.unlinkSync;
  fs.unlinkSync = (file) => {
    if (file === logFile) {
      throw cleanupError;
    }
    return originalUnlinkSync(file);
  };

  try {
    assert.throws(
      () => removeUnpublishedJobLog(logFile, publicationError),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [publicationError, cleanupError]);
        return true;
      }
    );
  } finally {
    fs.unlinkSync = originalUnlinkSync;
  }
  assert.equal(fs.existsSync(logFile), true);
});

test("late progress cannot recreate or mutate a job outside its worker generation", () => {
  const workspace = makeTempDir();
  const worker = makePosixWorker();
  upsertJob(workspace, {
    id: "job-progress-race",
    status: "running",
    phase: "running",
    worker
  });
  const update = createJobProgressUpdater(
    workspace,
    "job-progress-race",
    worker
  );

  update({ phase: "finalizing", threadId: "thread-1" });
  assert.equal(loadState(workspace).jobs[0].phase, "finalizing");

  mutateJobIf(
    workspace,
    "job-progress-race",
    () => true,
    () => ({
      status: "cancelled",
      phase: "cancelled",
      worker: null
    })
  );
  update({ phase: "running", turnId: "turn-late" });
  const terminal = loadState(workspace).jobs[0];
  assert.equal(terminal.status, "cancelled");
  assert.equal(terminal.phase, "cancelled");
  assert.equal(terminal.turnId, undefined);

  mutateJobIf(workspace, "job-progress-race", () => true, () => null);
  update({ phase: "running", turnId: "turn-after-remove" });
  assert.equal(loadState(workspace).jobs.length, 0);
});

test("a cancellation reserved before worker execution cannot be overwritten", async () => {
  const workspace = makeTempDir();
  const worker = makePosixWorker();
  upsertJob(workspace, {
    id: "job-cancel-race",
    status: "cancelling",
    worker
  });

  let runnerCalled = false;
  await assert.rejects(
    runTrackedJob(
      {
        id: "job-cancel-race",
        workspaceRoot: workspace,
        worker
      },
      async () => {
        runnerCalled = true;
        return {
          exitStatus: 0,
          payload: {},
          rendered: "",
          summary: ""
        };
      }
    ),
    /cancelled or replaced before worker execution/i
  );

  assert.equal(runnerCalled, false);
  assert.equal(loadState(workspace).jobs[0].status, "cancelling");
});

test("runTrackedJob owns the queued worker claim and passes the claimed record", async () => {
  const workspace = makeTempDir();
  const worker = makePosixWorker();
  upsertJob(workspace, {
    id: "job-claim",
    status: "queued",
    launchToken: worker.token
  });

  let claimedJob = null;
  await runTrackedJob(
    {
      id: "job-claim",
      workspaceRoot: workspace,
      launchToken: worker.token,
      worker
    },
    async (runningJob) => {
      claimedJob = runningJob;
      return {
        exitStatus: 0,
        payload: {},
        rendered: "done",
        summary: "done"
      };
    }
  );

  assert.equal(claimedJob.status, "running");
  assert.deepEqual(claimedJob.worker, worker);
  assert.equal(typeof claimedJob.startedAt, "string");
  assert.equal(loadState(workspace).jobs[0].status, "completed");
});

test("runTrackedJob does not report success after cancellation wins completion", async () => {
  const workspace = makeTempDir();
  const worker = makePosixWorker();
  upsertJob(workspace, {
    id: "job-completion-race",
    status: "queued",
    launchToken: worker.token
  });

  await assert.rejects(
    runTrackedJob(
      {
        id: "job-completion-race",
        workspaceRoot: workspace,
        launchToken: worker.token,
        worker
      },
      async () => {
        mutateJobIf(
          workspace,
          "job-completion-race",
          (job) => job.status === "running",
          () => ({ status: "cancelling" })
        );
        return {
          exitStatus: 0,
          payload: {},
          rendered: "done",
          summary: "done"
        };
      }
    ),
    /finished after its worker generation was cancelled or replaced/i
  );

  assert.equal(loadState(workspace).jobs[0].status, "cancelling");
});

test("runTrackedJob retains ownership when failed steering cleanup needs retry", async () => {
  const workspace = makeTempDir();
  const worker = makePosixWorker();
  const steering = {
    version: 1,
    kind: "unix",
    address: "/tmp/retry-steering.sock",
    worker,
    threadId: "thread-1",
    turnId: "turn-1"
  };
  upsertJob(workspace, {
    id: "job-cleanup-retry",
    status: "queued",
    launchToken: worker.token
  });

  await assert.rejects(
    runTrackedJob(
      {
        id: "job-cleanup-retry",
        workspaceRoot: workspace,
        launchToken: worker.token,
        worker
      },
      async () => {
        mutateJobIf(
          workspace,
          "job-cleanup-retry",
          (job) => job.status === "running",
          () => ({ steering })
        );
        throw new Error("cannot unlink endpoint");
      }
    ),
    /cannot unlink endpoint/
  );

  const failed = loadState(workspace).jobs[0];
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.worker, worker);
  assert.deepEqual(failed.steering, steering);
});
