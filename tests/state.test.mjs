import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

import { makeTempDir } from "./helpers.mjs";
import {
  inspectProcessIdentity,
  runCommand
} from "../plugins/codex/scripts/lib/process.mjs";
import { prepareSessionStart } from "../plugins/codex/scripts/lib/session-cleanup.mjs";
import {
  loadState,
  clearSessionEndingsIf,
  createJobIfSessionActive,
  markSessionEnding,
  mutateJobIf,
  preserveLaunchCleanupJob,
  removeJobIf,
  resolveJobLogFile,
  resolveStateDir,
  resolveStateFile,
  upsertJob,
  withStateTransaction
} from "../plugins/codex/scripts/lib/state.mjs";

const STATE_MODULE_URL = pathToFileURL(
  path.resolve("plugins/codex/scripts/lib/state.mjs")
).href;

function waitFor(predicate, timeoutMs = 5000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        reject(new Error("Timed out waiting for state test condition."));
        return;
      }
      setTimeout(poll, 10);
    };
    poll();
  });
}

function waitForChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({
      status: child.exitCode,
      signal: child.signalCode
    });
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({ status, signal });
    });
  });
}

function spawnStateChild(source, env) {
  return spawn(process.execPath, ["--input-type=module", "-e", source], {
    env: {
      ...process.env,
      ...env
    },
    stdio: "ignore"
  });
}

test("resolveStateDir uses a temp-backed per-workspace directory", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);

  assert.equal(stateDir.startsWith(os.tmpdir()), true);
  assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
  assert.match(stateDir, new RegExp(`^${os.tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("resolveStateDir uses only the Codex-specific plugin data variable", () => {
  const workspace = makeTempDir();
  const pluginDataDir = makeTempDir();
  const unrelatedPluginDataDir = makeTempDir();
  const previousCompanionDataDir =
    process.env.CODEX_COMPANION_PLUGIN_DATA;
  const previousPluginDataDir = process.env.CLAUDE_PLUGIN_DATA;
  process.env.CODEX_COMPANION_PLUGIN_DATA = pluginDataDir;
  process.env.CLAUDE_PLUGIN_DATA = unrelatedPluginDataDir;

  try {
    const stateDir = resolveStateDir(workspace);

    assert.equal(stateDir.startsWith(path.join(pluginDataDir, "state")), true);
    assert.match(path.basename(stateDir), /.+-[a-f0-9]{16}$/);
    assert.match(
      stateDir,
      new RegExp(`^${path.join(pluginDataDir, "state").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)
    );
  } finally {
    if (previousCompanionDataDir == null) {
      delete process.env.CODEX_COMPANION_PLUGIN_DATA;
    } else {
      process.env.CODEX_COMPANION_PLUGIN_DATA = previousCompanionDataDir;
    }
    if (previousPluginDataDir == null) {
      delete process.env.CLAUDE_PLUGIN_DATA;
    } else {
      process.env.CLAUDE_PLUGIN_DATA = previousPluginDataDir;
    }
  }
});

test("resolveJobLogFile rejects job ids that can escape the jobs directory", () => {
  const workspace = makeTempDir();

  for (const jobId of ["../outside", "..", "/absolute", "nested/job"]) {
    assert.throws(
      () => resolveJobLogFile(workspace, jobId),
      /invalid job id/i
    );
  }
});

test("state retains active and terminal job history without silent deletion", () => {
  const workspace = makeTempDir();
  const activeLog = resolveJobLogFile(workspace, "job-active");
  fs.writeFileSync(activeLog, "active log\n", { encoding: "utf8", mode: 0o600 });
  upsertJob(workspace, {
    id: "job-active",
    status: "running",
    logFile: activeLog,
    updatedAt: "2025-01-01T00:00:00.000Z"
  });

  for (let index = 0; index < 51; index += 1) {
    const jobId = `job-${index}`;
    const updatedAt = new Date(Date.UTC(2026, 0, 1, 0, index, 0)).toISOString();
    const logFile = resolveJobLogFile(workspace, jobId);
    fs.writeFileSync(logFile, `log ${jobId}\n`, { encoding: "utf8", mode: 0o600 });
    upsertJob(workspace, {
      id: jobId,
      status: "completed",
      logFile,
      updatedAt,
      createdAt: updatedAt
    });
  }

  const oldestLogFile = resolveJobLogFile(workspace, "job-0");
  const retainedLogFile = resolveJobLogFile(workspace, "job-50");

  const savedJobs = loadState(workspace).jobs;
  assert.equal(savedJobs.filter((job) => job.status === "running").length, 1);
  assert.equal(savedJobs.filter((job) => job.status === "completed").length, 51);
  assert.equal(savedJobs.some((job) => job.id === "job-active"), true);
  assert.equal(fs.existsSync(activeLog), true);
  assert.equal(fs.existsSync(oldestLogFile), true);
  assert.equal(fs.existsSync(retainedLogFile), true);
});

test("state transactions serialize multiprocess updates without losing jobs", async () => {
  const workspace = makeTempDir();
  const barrierDir = makeTempDir();
  const enteredFile = path.join(barrierDir, "entered");
  const releaseFile = path.join(barrierDir, "release");
  const secondDoneFile = path.join(barrierDir, "second-done");

  const first = spawnStateChild(
    `
      import fs from "node:fs";
      import { withStateTransaction } from ${JSON.stringify(STATE_MODULE_URL)};
      const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      withStateTransaction(process.env.TEST_WORKSPACE, (state) => {
        fs.writeFileSync(process.env.TEST_ENTERED, "entered");
        while (!fs.existsSync(process.env.TEST_RELEASE)) sleep();
        state.jobs.push({
          id: "job-a",
          status: "completed",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z"
        });
      });
    `,
    {
      TEST_WORKSPACE: workspace,
      TEST_ENTERED: enteredFile,
      TEST_RELEASE: releaseFile
    }
  );
  await waitFor(() => fs.existsSync(enteredFile));

  const second = spawnStateChild(
    `
      import fs from "node:fs";
      import { upsertJob } from ${JSON.stringify(STATE_MODULE_URL)};
      upsertJob(process.env.TEST_WORKSPACE, {
        id: "job-b",
        status: "completed"
      });
      fs.writeFileSync(process.env.TEST_DONE, "done");
    `,
    {
      TEST_WORKSPACE: workspace,
      TEST_DONE: secondDoneFile
    }
  );

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(fs.existsSync(secondDoneFile), false);
  fs.writeFileSync(releaseFile, "release");

  const [firstResult, secondResult] = await Promise.all([
    waitForChild(first),
    waitForChild(second)
  ]);
  assert.equal(firstResult.status, 0);
  assert.equal(secondResult.status, 0);
  assert.deepEqual(
    loadState(workspace).jobs.map((job) => job.id).sort(),
    ["job-a", "job-b"]
  );
});

test("state transactions reclaim a stale lock after its owner dies", async () => {
  const workspace = makeTempDir();
  const enteredFile = path.join(makeTempDir(), "entered");
  const lockDir = path.join(resolveStateDir(workspace), "state-lock");
  const owner = spawnStateChild(
    `
      import fs from "node:fs";
      import { withStateTransaction } from ${JSON.stringify(STATE_MODULE_URL)};
      withStateTransaction(process.env.TEST_WORKSPACE, () => {
        fs.writeFileSync(process.env.TEST_ENTERED, "entered");
        process.exit(86);
      });
    `,
    {
      TEST_WORKSPACE: workspace,
      TEST_ENTERED: enteredFile
    }
  );

  await waitFor(() => fs.existsSync(enteredFile));
  const ownerResult = await waitForChild(owner);
  assert.equal(ownerResult.status, 86);
  assert.equal(fs.readdirSync(lockDir).some((name) => name.startsWith("ticket-")), true);

  upsertJob(workspace, { id: "recovered", status: "completed" });

  assert.equal(fs.readdirSync(lockDir).some((name) => name.startsWith("ticket-")), false);
  assert.equal(loadState(workspace).jobs[0].id, "recovered");
});

test("two contenders after an owner crash remain mutually exclusive", async (t) => {
  const workspace = makeTempDir();
  const barrierDir = makeTempDir();
  const ownerEnteredFile = path.join(barrierDir, "owner-entered");
  const startFile = path.join(barrierDir, "start");
  const criticalFile = path.join(barrierDir, "critical");
  const overlapFile = path.join(barrierDir, "overlap");

  const owner = spawnStateChild(
    `
      import fs from "node:fs";
      import { withStateTransaction } from ${JSON.stringify(STATE_MODULE_URL)};
      withStateTransaction(process.env.TEST_WORKSPACE, () => {
        fs.writeFileSync(process.env.TEST_OWNER_ENTERED, "entered");
        process.exit(86);
      });
    `,
    {
      TEST_WORKSPACE: workspace,
      TEST_OWNER_ENTERED: ownerEnteredFile
    }
  );
  await waitFor(() => fs.existsSync(ownerEnteredFile));
  await waitForChild(owner);

  const contenderSource = `
    import fs from "node:fs";
    import { withStateTransaction } from ${JSON.stringify(STATE_MODULE_URL)};
    const sleep = (duration = 5) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, duration);
    while (!fs.existsSync(process.env.TEST_START)) sleep();
    withStateTransaction(process.env.TEST_WORKSPACE, (state) => {
      let descriptor;
      try {
        descriptor = fs.openSync(process.env.TEST_CRITICAL, "wx");
      } catch (error) {
        if (error.code === "EEXIST") {
          fs.writeFileSync(process.env.TEST_OVERLAP, "overlap");
        } else {
          throw error;
        }
      }
      try {
        sleep(100);
        state.jobs.push({ id: process.env.TEST_JOB_ID, status: "completed" });
      } finally {
        if (descriptor !== undefined) {
          fs.closeSync(descriptor);
          fs.unlinkSync(process.env.TEST_CRITICAL);
        }
      }
    }, { timeoutMs: 5000, pollMs: 1 });
  `;
  const contenderEnv = {
    TEST_WORKSPACE: workspace,
    TEST_START: startFile,
    TEST_CRITICAL: criticalFile,
    TEST_OVERLAP: overlapFile
  };
  const first = spawnStateChild(contenderSource, {
    ...contenderEnv,
    TEST_JOB_ID: "job-first"
  });
  const second = spawnStateChild(contenderSource, {
    ...contenderEnv,
    TEST_JOB_ID: "job-second"
  });
  t.after(() => {
    for (const child of [first, second]) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }
  });
  fs.writeFileSync(startFile, "start");

  const [firstResult, secondResult] = await Promise.all([
    waitForChild(first),
    waitForChild(second)
  ]);
  assert.equal(firstResult.status, 0);
  assert.equal(secondResult.status, 0);
  assert.equal(fs.existsSync(overlapFile), false);
  assert.deepEqual(
    loadState(workspace).jobs.map((job) => job.id).sort(),
    ["job-first", "job-second"]
  );
});

test("state transactions time out without stealing a live lock", async () => {
  const workspace = makeTempDir();
  const barrierDir = makeTempDir();
  const enteredFile = path.join(barrierDir, "entered");
  const releaseFile = path.join(barrierDir, "release");
  const lockDir = path.join(resolveStateDir(workspace), "state-lock");
  const owner = spawnStateChild(
    `
      import fs from "node:fs";
      import { withStateTransaction } from ${JSON.stringify(STATE_MODULE_URL)};
      const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      withStateTransaction(process.env.TEST_WORKSPACE, () => {
        fs.writeFileSync(process.env.TEST_ENTERED, "entered");
        while (!fs.existsSync(process.env.TEST_RELEASE)) sleep();
      });
    `,
    {
      TEST_WORKSPACE: workspace,
      TEST_ENTERED: enteredFile,
      TEST_RELEASE: releaseFile
    }
  );
  await waitFor(() => fs.existsSync(enteredFile));
  const ownerTickets = fs.readdirSync(lockDir).filter((name) => name.startsWith("ticket-"));
  let ownerResult;
  try {
    assert.equal(ownerTickets.length, 1);
    assert.throws(
      () =>
        withStateTransaction(workspace, () => {}, {
          timeoutMs: 75,
          pollMs: 5
        }),
      /timed out waiting for state lock/i
    );
    assert.deepEqual(
      fs.readdirSync(lockDir).filter((name) => name.startsWith("ticket-")),
      ownerTickets
    );
  } finally {
    fs.writeFileSync(releaseFile, "release");
    ownerResult = await waitForChild(owner);
  }
  assert.equal(ownerResult.status, 0);
});

test("state lock cleanup bounds a blocking Windows inspection by the transaction deadline", () => {
  const workspace = makeTempDir();
  const lockDir = path.join(resolveStateDir(workspace), "state-lock");
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(lockDir, "ticket-000000000001-blocked.json"),
    `${JSON.stringify({
      version: 2,
      token: "blocked",
      pid: 1234,
      startKey: "blocked-owner",
      acquiredAt: new Date().toISOString(),
      ticket: 1
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const deadlines = [];
  let inspectionCount = 0;
  let inspectedCommand = null;
  const startedAt = Date.now();
  assert.throws(
    () =>
      withStateTransaction(workspace, () => {}, {
        platform: "win32",
        timeoutMs: 75,
        pollMs: 1,
        inspectProcessIdentityImpl(pid, options) {
          deadlines.push(options.deadlineAt);
          inspectionCount += 1;
          if (inspectionCount === 1) {
            return {
              pid,
              parentPid: 1,
              processGroupId: null,
              startKey: "transaction-owner",
              argv: null,
              command: "node state-owner.mjs"
            };
          }
          return inspectProcessIdentity(pid, {
            ...options,
            platform: "win32",
            runCommandImpl(command, _args, commandOptions) {
              inspectedCommand = command;
              return runCommand(
                process.execPath,
                ["-e", "setInterval(() => {}, 1000)"],
                commandOptions
              );
            }
          });
        }
      }),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ETIMEDOUT"
  );

  assert.equal(inspectedCommand, "powershell.exe");
  assert.equal(inspectionCount, 2);
  assert.equal(new Set(deadlines).size, 1);
  assert.ok(Date.now() - startedAt < 1000);
});

test("session-ending cleanup obeys its transaction deadline under a held lock", async () => {
  const workspace = makeTempDir();
  const ending = markSessionEnding(workspace, "held-ending");
  const barrierDir = makeTempDir();
  const enteredFile = path.join(barrierDir, "entered");
  const releaseFile = path.join(barrierDir, "release");
  const owner = spawnStateChild(
    `
      import fs from "node:fs";
      import { withStateTransaction } from ${JSON.stringify(STATE_MODULE_URL)};
      const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      withStateTransaction(process.env.TEST_WORKSPACE, () => {
        fs.writeFileSync(process.env.TEST_ENTERED, "entered");
        while (!fs.existsSync(process.env.TEST_RELEASE)) sleep();
      });
    `,
    {
      TEST_WORKSPACE: workspace,
      TEST_ENTERED: enteredFile,
      TEST_RELEASE: releaseFile
    }
  );
  await waitFor(() => fs.existsSync(enteredFile));
  let ownerResult;
  try {
    assert.throws(
      () =>
        clearSessionEndingsIf(workspace, [ending], {
          timeoutMs: 75,
          pollMs: 5
        }),
      /timed out waiting for state lock/i
    );
    assert.equal(
      loadState(workspace).endedSessions.some(
        (entry) => entry.token === ending.token
      ),
      true
    );
  } finally {
    fs.writeFileSync(releaseFile, "release");
    ownerResult = await waitForChild(owner);
  }
  assert.equal(ownerResult.status, 0);
});

test("session-start reconciliation obeys its transaction deadline under a held lock", async () => {
  const workspace = makeTempDir();
  upsertJob(workspace, {
    id: "dead-session-start-worker",
    status: "running",
    pid: 1234,
    worker: {
      version: 1,
      pid: 1234,
      token: "worker-token",
      startKey: "worker-start",
      platform: "linux",
      processGroupId: 1234
    }
  });
  const barrierDir = makeTempDir();
  const enteredFile = path.join(barrierDir, "entered");
  const releaseFile = path.join(barrierDir, "release");
  const owner = spawnStateChild(
    `
      import fs from "node:fs";
      import { withStateTransaction } from ${JSON.stringify(STATE_MODULE_URL)};
      const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      withStateTransaction(process.env.TEST_WORKSPACE, () => {
        fs.writeFileSync(process.env.TEST_ENTERED, "entered");
        while (!fs.existsSync(process.env.TEST_RELEASE)) sleep();
      });
    `,
    {
      TEST_WORKSPACE: workspace,
      TEST_ENTERED: enteredFile,
      TEST_RELEASE: releaseFile
    }
  );
  await waitFor(() => fs.existsSync(enteredFile));
  let ownerResult;
  try {
    await assert.rejects(
      prepareSessionStart(workspace, {
        inspectOwnedWorkerImpl: () => ({ status: "gone" }),
        // A frozen clock keeps the full recovery budget available at the reconcile
        // loop, so scheduling jitter can never make it break out before it reaches
        // the held state lock; withStateTransaction still times out on real time.
        nowImpl: () => 1_000_000,
        sessionStartConfig: {
          recoveryBudgetMs: 75
        }
      }),
      /timed out waiting for state lock/i
    );
  } finally {
    fs.writeFileSync(releaseFile, "release");
    ownerResult = await waitForChild(owner);
  }
  assert.equal(ownerResult.status, 0);
});

test("state transactions reclaim a lock after its pid is reused", () => {
  const workspace = makeTempDir();
  const lockDir = path.join(resolveStateDir(workspace), "state-lock");
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(lockDir, "ticket-000000000001-reused.json"),
    `${JSON.stringify({
      version: 2,
      token: "reused",
      pid: process.pid,
      startKey: "different-process-generation",
      acquiredAt: new Date().toISOString(),
      ticket: 1
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  upsertJob(workspace, { id: "after-pid-reuse", status: "completed" });

  assert.equal(fs.readdirSync(lockDir).length, 0);
  assert.equal(loadState(workspace).jobs[0].id, "after-pid-reuse");
});

test("state transactions reject obsolete locks without a generation key", () => {
  const workspace = makeTempDir();
  const lockDir = path.join(resolveStateDir(workspace), "state-lock");
  fs.mkdirSync(lockDir, { recursive: true, mode: 0o700 });
  const obsoleteLockFile = path.join(
    lockDir,
    "ticket-000000000001-obsolete.json"
  );
  fs.writeFileSync(
    obsoleteLockFile,
    `${JSON.stringify({
      version: 1,
      token: "obsolete",
      pid: process.pid,
      acquiredAt: new Date().toISOString(),
      ticket: 1
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  assert.throws(
    () => withStateTransaction(workspace, () => {}),
    /state lock metadata is invalid/i
  );
  assert.equal(fs.existsSync(obsoleteLockFile), true);
});

test("state transactions retain active legacy manifests and remove terminal ones", () => {
  const workspace = makeTempDir();
  const jobsDir = path.join(resolveStateDir(workspace), "jobs");
  const activeManifest = path.join(jobsDir, "legacy-active.json");
  const terminalManifest = path.join(jobsDir, "legacy-terminal.json");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    activeManifest,
    `${JSON.stringify({ id: "legacy-active", status: "running" })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fs.writeFileSync(
    terminalManifest,
    `${JSON.stringify({ id: "legacy-terminal", status: "completed" })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  upsertJob(workspace, { id: "legacy-active", status: "running" });
  upsertJob(workspace, { id: "legacy-terminal", status: "completed" });

  assert.equal(fs.existsSync(activeManifest), true);
  assert.equal(fs.existsSync(terminalManifest), false);
});

test("state transactions migrate a v1.0.6 terminal result before removing its manifest", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  const stateFile = resolveStateFile(workspace);
  const manifest = path.join(jobsDir, "legacy-result.json");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "legacy-result",
            status: "completed",
            title: "Codex Task",
            threadId: "newer-index-thread",
            summary: "Legacy task",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fs.writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        id: "legacy-result",
        status: "completed",
        threadId: "older-manifest-thread",
        request: { type: "task", prompt: "legacy prompt" },
        result: { rawOutput: "legacy raw output" },
        rendered: "legacy rendered output",
        completedAt: "2026-03-18T15:11:10.000Z"
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  withStateTransaction(workspace, () => {});

  const [migrated] = loadState(workspace).jobs;
  assert.deepEqual(migrated.request, {
    type: "task",
    prompt: "legacy prompt"
  });
  assert.deepEqual(migrated.result, {
    rawOutput: "legacy raw output"
  });
  assert.equal(migrated.rendered, "legacy rendered output");
  assert.equal(migrated.threadId, "newer-index-thread");
  assert.equal(fs.existsSync(manifest), false);
});

test("state transactions harden and migrate artifacts created by the v1.0.6 default umask", async () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  const stateFile = resolveStateFile(workspace);
  const manifest = path.join(jobsDir, "legacy-umask.json");
  const child = spawnStateChild(
    `
      import fs from "node:fs";
      process.umask(0o022);
      fs.mkdirSync(process.env.JOBS_DIR, { recursive: true });
      fs.writeFileSync(
        process.env.STATE_FILE,
        JSON.stringify({
          version: 1,
          config: { stopReviewGate: false },
          jobs: []
        }) + "\\n"
      );
      fs.writeFileSync(
        process.env.MANIFEST,
        JSON.stringify({
          id: "legacy-umask",
          status: "completed",
          result: { rawOutput: "legacy output" }
        }) + "\\n"
      );
    `,
    {
      JOBS_DIR: jobsDir,
      STATE_FILE: stateFile,
      MANIFEST: manifest
    }
  );
  const childResult = await waitForChild(child);

  assert.equal(childResult.status, 0);
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o755);
  assert.equal(fs.statSync(jobsDir).mode & 0o777, 0o755);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o644);
  assert.equal(fs.statSync(manifest).mode & 0o777, 0o644);

  withStateTransaction(workspace, () => {});

  const [migrated] = loadState(workspace).jobs;
  assert.equal(migrated.id, "legacy-umask");
  assert.deepEqual(migrated.result, { rawOutput: "legacy output" });
  assert.equal(fs.statSync(stateDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(jobsDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(manifest), false);
});

test("state loading hardens a canonical v1.0.6 manifest log created by the default umask", async () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  const stateFile = resolveStateFile(workspace);
  const manifest = path.join(jobsDir, "legacy-log.json");
  const logFile = path.join(jobsDir, "legacy-log.log");
  const child = spawnStateChild(
    `
      import fs from "node:fs";
      process.umask(0o022);
      fs.mkdirSync(process.env.JOBS_DIR, { recursive: true });
      fs.writeFileSync(process.env.LOG_FILE, "legacy progress\\n");
      fs.writeFileSync(
        process.env.STATE_FILE,
        JSON.stringify({
          version: 1,
          config: { stopReviewGate: false },
          jobs: []
        }) + "\\n"
      );
      fs.writeFileSync(
        process.env.MANIFEST,
        JSON.stringify({
            id: "legacy-log",
            status: "running",
            logFile: process.env.LOG_FILE
        }) + "\\n"
      );
    `,
    {
      JOBS_DIR: jobsDir,
      LOG_FILE: logFile,
      MANIFEST: manifest,
      STATE_FILE: stateFile
    }
  );
  const childResult = await waitForChild(child);

  assert.equal(childResult.status, 0);
  assert.equal(fs.statSync(manifest).mode & 0o777, 0o644);
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o644);

  const [migrated] = loadState(workspace).jobs;

  assert.equal(migrated.logFile, logFile);
  assert.equal(fs.readFileSync(logFile, "utf8"), "legacy progress\n");
  assert.equal(fs.statSync(manifest).mode & 0o777, 0o600);
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600);
});

test("state loading rejects unsafe canonical log artifacts without changing them", () => {
  for (const kind of ["writable", "symlink", "directory"]) {
    const workspace = makeTempDir();
    const stateFile = resolveStateFile(workspace);
    const jobsDir = path.join(resolveStateDir(workspace), "jobs");
    const logFile = path.join(jobsDir, `${kind}.log`);
    fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      stateFile,
      `${JSON.stringify({
        version: 1,
        jobs: [{ id: kind, status: "running", logFile }]
      })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );

    if (kind === "writable") {
      fs.writeFileSync(logFile, "unsafe\n", { encoding: "utf8", mode: 0o660 });
      fs.chmodSync(logFile, 0o660);
    } else if (kind === "symlink") {
      const target = path.join(workspace, "target.log");
      fs.writeFileSync(target, "target\n", { encoding: "utf8", mode: 0o600 });
      fs.symlinkSync(target, logFile);
    } else {
      fs.mkdirSync(logFile, { mode: 0o700 });
    }

    assert.throws(
      () => loadState(workspace),
      /not a regular file|must not be writable by group or others/i
    );
    if (kind === "writable") {
      assert.equal(fs.statSync(logFile).mode & 0o777, 0o660);
    } else if (kind === "symlink") {
      assert.equal(fs.lstatSync(logFile).isSymbolicLink(), true);
    } else {
      assert.equal(fs.lstatSync(logFile).isDirectory(), true);
    }
  }
});

test("retirement never deletes a non-canonical v1.0.6 manifest log path", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const jobsDir = path.join(resolveStateDir(workspace), "jobs");
  const manifest = path.join(jobsDir, "escaped-log.json");
  const outsideLog = path.join(workspace, "outside.log");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(outsideLog, "keep\n", { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      jobs: []
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fs.writeFileSync(
    manifest,
    `${JSON.stringify(
      {
        id: "escaped-log",
        status: "completed",
        logFile: outsideLog
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  assert.throws(
    () => withStateTransaction(workspace, () => {}),
    /invalid job log path/i
  );
  assert.equal(fs.readFileSync(outsideLog, "utf8"), "keep\n");
  assert.equal(fs.existsSync(manifest), true);
});

test("canonical state never accepts a non-canonical log path", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const outsideLog = path.join(workspace, "outside.log");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outsideLog, "keep\n", { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      jobs: [
        {
          id: "escaped-log",
          status: "running",
          logFile: outsideLog
        }
      ]
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  assert.throws(
    () => loadState(workspace),
    /invalid job log path/i
  );
  assert.equal(fs.readFileSync(outsideLog, "utf8"), "keep\n");
});

test("legacy hardening rejects writable and symbolic-link artifacts without changing them", () => {
  const writableWorkspace = makeTempDir();
  const writableStateDir = resolveStateDir(writableWorkspace);
  fs.mkdirSync(path.join(writableStateDir, "jobs"), {
    recursive: true,
    mode: 0o700
  });
  const writableStateFile = resolveStateFile(writableWorkspace);
  fs.writeFileSync(
    writableStateFile,
    `${JSON.stringify({ version: 1, jobs: [] })}\n`,
    { encoding: "utf8", mode: 0o660 }
  );
  fs.chmodSync(writableStateFile, 0o660);

  assert.throws(
    () => loadState(writableWorkspace),
    /must not be writable by group or others/i
  );
  assert.equal(fs.statSync(writableStateFile).mode & 0o777, 0o660);

  const symlinkWorkspace = makeTempDir();
  const symlinkJobsDir = path.join(resolveStateDir(symlinkWorkspace), "jobs");
  fs.mkdirSync(symlinkJobsDir, { recursive: true, mode: 0o700 });
  const target = path.join(symlinkWorkspace, "target.json");
  const manifest = path.join(symlinkJobsDir, "linked.json");
  fs.writeFileSync(
    target,
    `${JSON.stringify({ id: "linked", status: "completed" })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fs.symlinkSync(target, manifest);

  assert.throws(
    () => loadState(symlinkWorkspace),
    /legacy job manifest is not a regular file/i
  );
  assert.equal(fs.lstatSync(manifest).isSymbolicLink(), true);
});

test("state transactions migrate every terminal manifest beyond the former history cap", () => {
  const workspace = makeTempDir();
  const jobsDir = path.join(resolveStateDir(workspace), "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  for (let index = 0; index < 75; index += 1) {
    const id = `legacy-result-${String(index).padStart(3, "0")}`;
    fs.writeFileSync(
      path.join(jobsDir, `${id}.json`),
      `${JSON.stringify({
        id,
        status: "completed",
        result: { rawOutput: `result-${index}` },
        rendered: `rendered-${index}`
      })}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }

  withStateTransaction(workspace, () => {});

  const migrated = loadState(workspace).jobs;
  assert.equal(migrated.length, 75);
  assert.equal(
    migrated.every((job) => job.result?.rawOutput === `result-${Number(job.id.slice(-3))}`),
    true
  );
  assert.deepEqual(fs.readdirSync(jobsDir), []);
});

test("state transactions recover an orphaned v1.0.6 terminal manifest", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  const manifest = path.join(jobsDir, "orphan-result.json");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    resolveStateFile(workspace),
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: []
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fs.writeFileSync(
    manifest,
    `${JSON.stringify({
      id: "orphan-result",
      status: "completed",
      result: { rawOutput: "orphan output" },
      rendered: "orphan rendered",
      updatedAt: "2026-03-18T15:11:10.000Z"
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  withStateTransaction(workspace, () => {});

  const [recovered] = loadState(workspace).jobs;
  assert.equal(recovered.id, "orphan-result");
  assert.deepEqual(recovered.result, { rawOutput: "orphan output" });
  assert.equal(fs.existsSync(manifest), false);
});

test("atomic state replacement synchronizes data before and after rename", (t) => {
  const workspace = makeTempDir();
  const originalFsyncSync = fs.fsyncSync;
  let syncCalls = 0;
  fs.fsyncSync = (fileDescriptor) => {
    syncCalls += 1;
    return originalFsyncSync(fileDescriptor);
  };
  t.after(() => {
    fs.fsyncSync = originalFsyncSync;
  });

  upsertJob(workspace, {
    id: "durable-state",
    status: "completed"
  });

  assert.equal(syncCalls >= 2, true);
});

test("failed canonical file synchronization preserves a legacy manifest", (t) => {
  const workspace = makeTempDir();
  const jobsDir = path.join(resolveStateDir(workspace), "jobs");
  const manifest = path.join(jobsDir, "sync-failure.json");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    resolveStateFile(workspace),
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [{ id: "sync-failure", status: "completed" }]
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fs.writeFileSync(
    manifest,
    `${JSON.stringify({
      id: "sync-failure",
      status: "completed",
      rendered: "must survive"
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  const originalFsyncSync = fs.fsyncSync;
  fs.fsyncSync = () => {
    throw Object.assign(new Error("sync failed"), { code: "EIO" });
  };
  t.after(() => {
    fs.fsyncSync = originalFsyncSync;
  });

  assert.throws(
    () => withStateTransaction(workspace, () => {}),
    /sync failed/
  );
  assert.equal(fs.existsSync(manifest), true);
  assert.equal(
    fs
      .readdirSync(resolveStateDir(workspace))
      .some((entry) => entry.startsWith(".candidate-")),
    false
  );
});

test("unproven Windows directory durability preserves legacy manifests", (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  const manifest = path.join(jobsDir, "windows-durability.json");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    resolveStateFile(workspace),
    `${JSON.stringify({
      version: 1,
      config: { stopReviewGate: false },
      jobs: [{ id: "windows-durability", status: "completed" }]
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fs.writeFileSync(
    manifest,
    `${JSON.stringify({
      id: "windows-durability",
      status: "completed",
      rendered: "retain until directory durability is proven"
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  const originalOpenSync = fs.openSync;
  fs.openSync = (filePath, flags, mode) => {
    if (filePath === stateDir) {
      throw Object.assign(new Error("directory sync unavailable"), {
        code: "EACCES"
      });
    }
    return originalOpenSync(filePath, flags, mode);
  };
  t.after(() => {
    fs.openSync = originalOpenSync;
  });

  withStateTransaction(workspace, () => {}, { platform: "win32" });

  assert.equal(fs.existsSync(manifest), true);
  assert.equal(
    loadState(workspace).jobs[0].rendered,
    "retain until directory durability is proven"
  );
  const removed = removeJobIf(
    workspace,
    "windows-durability",
    () => true,
    { platform: "win32" }
  );
  assert.equal(removed.matched, true);
  assert.equal(fs.existsSync(manifest), true);
  assert.equal(loadState(workspace).jobs.length, 0);
  const canonical = JSON.parse(
    fs.readFileSync(resolveStateFile(workspace), "utf8")
  );
  assert.deepEqual(
    canonical.retiredLegacyJobIds,
    ["windows-durability"]
  );

  fs.writeFileSync(manifest, "{ invalid retained json", {
    encoding: "utf8",
    mode: 0o600
  });
  assert.equal(loadState(workspace).jobs.length, 0);
});

test("post-commit cleanup failure does not reject durable state and retries later", () => {
  const workspace = makeTempDir();
  const jobsDir = path.join(resolveStateDir(workspace), "jobs");
  const terminalManifest = path.join(jobsDir, "cleanup-debt.json");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    terminalManifest,
    `${JSON.stringify({ id: "cleanup-debt", status: "completed" })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  withStateTransaction(
    workspace,
    (state) => {
      state.jobs.push({
        id: "cleanup-debt",
        status: "completed",
        updatedAt: new Date().toISOString()
      });
    },
    {
      removeFileIfExistsImpl() {
        throw Object.assign(new Error("unlink failed"), { code: "EACCES" });
      }
    }
  );

  assert.equal(loadState(workspace).jobs[0].id, "cleanup-debt");
  assert.equal(fs.existsSync(terminalManifest), true);

  withStateTransaction(workspace, () => {});

  assert.equal(fs.existsSync(terminalManifest), false);
});

test("mutateJobIf updates or removes the canonical state and its log", () => {
  const workspace = makeTempDir();
  const jobId = "job-conditional";
  const logFile = resolveJobLogFile(workspace, jobId);
  fs.writeFileSync(logFile, "job log\n", { encoding: "utf8", mode: 0o600 });
  upsertJob(workspace, {
    id: jobId,
    status: "running",
    launchToken: "token-1",
    pid: 1234,
    request: { prompt: "keep this request" },
    logFile
  });

  const mismatch = mutateJobIf(
    workspace,
    jobId,
    (job) => job.launchToken === "wrong-token",
    () => ({ status: "cancelled" })
  );
  assert.equal(mismatch.matched, false);

  const updated = mutateJobIf(
    workspace,
    jobId,
    (job) => job.launchToken === "token-1" && job.pid === 1234,
    () => ({ status: "cancelled", pid: null })
  );
  assert.equal(updated.matched, true);
  assert.equal(updated.removed, false);
  assert.equal(loadState(workspace).jobs[0].status, "cancelled");
  const stored = loadState(workspace).jobs[0];
  assert.equal(stored.status, "cancelled");
  assert.deepEqual(stored.request, { prompt: "keep this request" });

  const unconditionallyUpdated = mutateJobIf(
    workspace,
    jobId,
    () => true,
    () => ({ status: "completed" })
  );
  assert.equal(unconditionallyUpdated.matched, true);
  assert.equal(unconditionallyUpdated.job.status, "completed");

  const removed = removeJobIf(
    workspace,
    jobId,
    (job) => job.status === "completed"
  );
  assert.equal(removed.matched, true);
  assert.equal(removed.removed, true);
  assert.equal(loadState(workspace).jobs.length, 0);
  assert.equal(fs.existsSync(logFile), false);
});

test("a session ending marker atomically rejects later background job publication", () => {
  const workspace = makeTempDir();
  const sessionId = "session-ending";
  const beforeEnding = createJobIfSessionActive(workspace, {
    id: "job-before-ending",
    sessionId,
    status: "queued"
  });
  assert.equal(beforeEnding.created, true);

  const ending = markSessionEnding(workspace, sessionId);
  const afterEnding = createJobIfSessionActive(workspace, {
    id: "job-after-ending",
    sessionId,
    status: "queued"
  });
  assert.equal(afterEnding.created, false);
  assert.deepEqual(
    loadState(workspace).jobs.map((job) => job.id),
    ["job-before-ending"]
  );

  assert.deepEqual(
    clearSessionEndingsIf(workspace, [ending]),
    {
      clearedSessionIds: [sessionId],
      conflictedSessionIds: []
    }
  );
  const afterRestart = createJobIfSessionActive(workspace, {
    id: "job-after-restart",
    sessionId,
    status: "queued"
  });
  assert.equal(afterRestart.created, true);
});

test("a durable session ending marker does not wait for the shared state lock", async () => {
  const workspace = makeTempDir();
  const barrierDir = makeTempDir();
  const enteredFile = path.join(barrierDir, "entered");
  const releaseFile = path.join(barrierDir, "release");
  const lockOwner = spawnStateChild(
    `
      import fs from "node:fs";
      import { withStateTransaction } from ${JSON.stringify(STATE_MODULE_URL)};
      const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      withStateTransaction(process.env.TEST_WORKSPACE, () => {
        fs.writeFileSync(process.env.TEST_ENTERED, "entered");
        while (!fs.existsSync(process.env.TEST_RELEASE)) sleep();
      });
    `,
    {
      TEST_WORKSPACE: workspace,
      TEST_ENTERED: enteredFile,
      TEST_RELEASE: releaseFile
    }
  );

  try {
    await waitFor(() => fs.existsSync(enteredFile));
    const startedAt = Date.now();
    const ending = markSessionEnding(workspace, "session-lock-independent");
    const elapsedMs = Date.now() - startedAt;

    assert.ok(elapsedMs < 500, `marker took ${elapsedMs} ms`);
    assert.deepEqual(
      loadState(workspace).endedSessions.find(
        (entry) => entry.sessionId === ending.sessionId
      ),
      ending
    );
  } finally {
    fs.writeFileSync(releaseFile, "release");
    const result = await waitForChild(lockOwner);
    assert.equal(result.status, 0);
  }
});

test("state runtime directories and sensitive files are private", () => {
  const workspace = makeTempDir();
  const ending = markSessionEnding(workspace, "session-private-runtime");
  upsertJob(workspace, { id: "private-state-job", status: "completed" });

  const stateDir = resolveStateDir(workspace);
  const markerDir = path.join(stateDir, "session-endings");
  const markerFile = path.join(markerDir, `${ending.token}.json`);
  for (const directoryPath of [
    stateDir,
    path.join(stateDir, "jobs"),
    path.join(stateDir, "state-lock"),
    markerDir
  ]) {
    assert.equal(fs.statSync(directoryPath).mode & 0o777, 0o700);
  }
  assert.equal(fs.statSync(resolveStateFile(workspace)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(markerFile).mode & 0o777, 0o600);
});

test("an active session singleton is reserved atomically", () => {
  const workspace = makeTempDir();
  const first = createJobIfSessionActive(workspace, {
    id: "stop-gate-1",
    sessionId: "session-singleton",
    singletonKey: "stop-review",
    status: "queued"
  });
  const second = createJobIfSessionActive(workspace, {
    id: "stop-gate-2",
    sessionId: "session-singleton",
    singletonKey: "stop-review",
    status: "queued"
  });

  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job.id, "stop-gate-1");
  assert.deepEqual(
    loadState(workspace).jobs.map((job) => job.id),
    ["stop-gate-1"]
  );
});

test("an old session ending marker is not evicted by newer sessions", () => {
  const workspace = makeTempDir();
  for (let index = 0; index < 51; index += 1) {
    markSessionEnding(workspace, `session-${index}`);
  }

  const delayedPublication = createJobIfSessionActive(workspace, {
    id: "job-from-old-ended-session",
    sessionId: "session-0",
    status: "queued"
  });

  assert.equal(delayedPublication.created, false);
});

test("an older session-start generation cannot clear a newer session end", () => {
  const workspace = makeTempDir();
  const sessionId = "session-race";
  const olderEnding = markSessionEnding(workspace, sessionId);
  const newerEnding = markSessionEnding(workspace, sessionId);

  assert.notEqual(olderEnding.token, newerEnding.token);
  assert.deepEqual(
    clearSessionEndingsIf(workspace, [olderEnding]),
    {
      clearedSessionIds: [],
      conflictedSessionIds: [sessionId]
    }
  );
  assert.equal(
    createJobIfSessionActive(workspace, {
      id: "blocked-after-newer-end",
      sessionId,
      status: "queued"
    }).created,
    false
  );
  assert.deepEqual(
    clearSessionEndingsIf(workspace, [newerEnding]),
    {
      clearedSessionIds: [sessionId],
      conflictedSessionIds: []
    }
  );
});

test("equal-timestamp reverse-sorted session endings clear only the exact token", () => {
  const workspace = makeTempDir();
  const sessionId = "session-equal-timestamp-race";
  const endedAt = "2026-03-18T15:30:00.000Z";
  const markerDir = path.join(resolveStateDir(workspace), "session-endings");
  const earlierToken = "z-earlier-token";
  const laterToken = "a-later-token";
  fs.mkdirSync(markerDir, { recursive: true, mode: 0o700 });
  for (const token of [earlierToken, laterToken]) {
    fs.writeFileSync(
      path.join(markerDir, `${token}.json`),
      `${JSON.stringify({ version: 1, sessionId, endedAt, token })}\n`,
      { mode: 0o600 }
    );
  }

  assert.deepEqual(
    clearSessionEndingsIf(workspace, [
      { sessionId, endedAt, token: earlierToken }
    ]),
    {
      clearedSessionIds: [],
      conflictedSessionIds: [sessionId]
    }
  );
  assert.equal(fs.existsSync(path.join(markerDir, `${earlierToken}.json`)), false);
  assert.equal(fs.existsSync(path.join(markerDir, `${laterToken}.json`)), true);
  assert.equal(
    createJobIfSessionActive(workspace, {
      id: "blocked-after-equal-timestamp-end",
      sessionId,
      status: "queued"
    }).created,
    false
  );

  assert.deepEqual(
    clearSessionEndingsIf(workspace, [
      { sessionId, endedAt, token: laterToken }
    ]),
    {
      clearedSessionIds: [sessionId],
      conflictedSessionIds: []
    }
  );
});

test("ended session recovery obligations are never expired or capped", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const now = Date.now();
  const recent = Array.from({ length: 1002 }, (_, index) => ({
    sessionId: `recent-${index}`,
    endedAt: new Date(now - index * 1000).toISOString()
  }));
  fs.writeFileSync(
    stateFile,
    `${JSON.stringify({
      version: 1,
      revision: 0,
      config: { stopReviewGate: false },
      endedSessions: [
        ...recent,
        {
          sessionId: "expired",
          endedAt: new Date(now - 8 * 24 * 60 * 60 * 1000).toISOString()
        }
      ],
      jobs: []
    })}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  upsertJob(workspace, { id: "retention-trigger", status: "completed" });

  const endedSessions = loadState(workspace).endedSessions;
  assert.equal(endedSessions.length, 1003);
  assert.equal(endedSessions.some((entry) => entry.sessionId === "expired"), true);
  assert.equal(endedSessions.some((entry) => entry.sessionId === "recent-0"), true);
  const rejected = createJobIfSessionActive(workspace, {
    id: "late-publication",
    sessionId: "recent-0",
    status: "queued"
  });
  assert.equal(rejected.created, false);
});

test("a corrupt state file blocks publication and is not overwritten", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const jobId = "job-after-corruption";
  markSessionEnding(workspace, "ended-session");
  fs.writeFileSync(stateFile, "{", { encoding: "utf8", mode: 0o600 });

  assert.throws(
    () =>
      createJobIfSessionActive(workspace, {
        id: jobId,
        sessionId: "ended-session",
        status: "queued"
      }),
    SyntaxError
  );
  assert.equal(fs.readFileSync(stateFile, "utf8"), "{");
});

test("an unknown persisted job status blocks cleanup and is not overwritten", () => {
  const workspace = makeTempDir();
  const stateFile = resolveStateFile(workspace);
  const malformedState = `${JSON.stringify({
    version: 1,
    revision: 0,
    config: { stopReviewGate: false },
    endedSessions: [],
    retiredLegacyJobIds: [],
    jobs: [{ id: "owned-worker", status: "runing" }]
  })}\n`;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(stateFile, malformedState, { encoding: "utf8", mode: 0o600 });

  assert.throws(() => loadState(workspace), /invalid job record/i);
  assert.equal(fs.readFileSync(stateFile, "utf8"), malformedState);
});

test("canonical state rejects partial launcher identities", () => {
  for (const [index, launcher] of [
    { pid: 1234 },
    { startKey: "launcher-start" },
    { pid: 0, startKey: "launcher-start" },
    { pid: 1234, startKey: "" }
  ].entries()) {
    const workspace = makeTempDir();
    const stateFile = resolveStateFile(workspace);
    const malformedState = `${JSON.stringify({
      version: 1,
      revision: 0,
      config: { stopReviewGate: false },
      endedSessions: [],
      retiredLegacyJobIds: [],
      jobs: [
        {
          id: `invalid-launcher-${index}`,
          status: "queued",
          launchToken: "launch-token",
          launcher
        }
      ]
    })}\n`;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, malformedState, { encoding: "utf8", mode: 0o600 });

    assert.throws(() => loadState(workspace), /invalid launcher identity/i);
    assert.equal(fs.readFileSync(stateFile, "utf8"), malformedState);
  }
});

test("canonical state rejects partial workers and steering from another generation", () => {
  const workerCases = [
    {
      worker: {
        pid: 1234,
        token: "worker-token",
        startKey: "worker-start"
      }
    },
    {
      worker: {
        version: 1,
        pid: 1234,
        token: "worker-token",
        startKey: "worker-start",
        platform: "unknown-platform",
        processGroupId: 1234
      }
    },
    {
      worker: {
        version: 1,
        pid: 1234,
        token: "worker-token",
        startKey: "worker-start",
        platform: "linux",
        processGroupId: 1234
      },
      steering: {
        version: 1,
        kind: "unix",
        address: "/tmp/steering.sock",
        worker: {
          version: 1,
          pid: 4321,
          token: "worker-token",
          startKey: "worker-start",
          platform: "linux",
          processGroupId: 4321
        },
        threadId: "thread-1",
        turnId: "turn-1"
      }
    }
  ];

  for (const [index, fields] of workerCases.entries()) {
    const workspace = makeTempDir();
    const stateFile = resolveStateFile(workspace);
    const malformedState = `${JSON.stringify({
      version: 1,
      revision: 0,
      config: { stopReviewGate: false },
      endedSessions: [],
      retiredLegacyJobIds: [],
      jobs: [
        {
          id: `invalid-worker-${index}`,
          status: "running",
          ...fields
        }
      ]
    })}\n`;
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, malformedState, { encoding: "utf8", mode: 0o600 });

    assert.throws(
      () => loadState(workspace),
      /invalid owned worker|steering worker does not match/i
    );
    assert.equal(fs.readFileSync(stateFile, "utf8"), malformedState);
  }
});

test("state transactions reject an unknown status before replacing durable state", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, { id: "owned-worker", status: "running" });
  const stateFile = resolveStateFile(workspace);
  const before = fs.readFileSync(stateFile, "utf8");

  assert.throws(
    () =>
      withStateTransaction(workspace, (state) => {
        state.jobs[0].status = "runing";
      }),
    /invalid job record/i
  );
  assert.equal(fs.readFileSync(stateFile, "utf8"), before);
});

test("launch cleanup recovery never overwrites a different generation", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, {
    id: "job-generation",
    status: "running",
    launchToken: "new-generation"
  });

  const result = preserveLaunchCleanupJob(workspace, {
    id: "job-generation",
    status: "cancelling",
    launchToken: "old-generation"
  });

  assert.equal(result.preserved, false);
  const stored = loadState(workspace).jobs[0];
  assert.equal(stored.status, "running");
  assert.equal(stored.launchToken, "new-generation");
});

test("launch cleanup recovery never regresses a terminal generation", () => {
  const workspace = makeTempDir();
  upsertJob(workspace, {
    id: "job-terminal-generation",
    status: "cancelled",
    launchToken: "same-generation"
  });

  const result = preserveLaunchCleanupJob(workspace, {
    id: "job-terminal-generation",
    status: "cancelling",
    phase: "launch-cleanup-failed",
    launchToken: "same-generation"
  });

  assert.equal(result.preserved, false);
  const stored = loadState(workspace).jobs[0];
  assert.equal(stored.status, "cancelled");
});
