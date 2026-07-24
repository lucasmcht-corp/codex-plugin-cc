import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import {
  initGitRepo,
  makePosixWorker,
  makeTempDir,
  makeWindowsWorker,
  run
} from "./helpers.mjs";
import {
  loadState,
  markSessionEnding,
  mutateJobIf,
  resolveJobLogFile,
  resolveStateDir,
  upsertJob
} from "../plugins/codex/scripts/lib/state.mjs";
import { CodexAppServerClient } from "../plugins/codex/scripts/lib/app-server.mjs";
import {
  inspectOwnedWorker,
  inspectProcessIdentity
} from "../plugins/codex/scripts/lib/process.mjs";
import { enqueueOwnedJob } from "../plugins/codex/scripts/codex-companion.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLUGIN_ROOT = path.join(ROOT, "plugins", "codex");
const SCRIPT = path.join(PLUGIN_ROOT, "scripts", "codex-companion.mjs");
const STOP_HOOK = path.join(PLUGIN_ROOT, "scripts", "stop-review-gate-hook.mjs");
const SESSION_HOOK = path.join(PLUGIN_ROOT, "scripts", "session-lifecycle-hook.mjs");

function activeLauncherFields() {
  const launcher = inspectProcessIdentity(process.pid);
  assert.ok(launcher?.startKey);
  return {
    status: "queued",
    launchToken: `test-launch-${process.pid}`,
    launcher: {
      pid: launcher.pid,
      startKey: launcher.startKey
    }
  };
}

function buildEnqueueBoundaryFixture(workspaceRoot, jobId) {
  return {
    job: {
      id: jobId,
      status: "queued",
      kind: "task",
      title: "Enqueue boundary task",
      workspaceRoot,
      jobClass: "task",
      summary: "Exercise the enqueue launch boundary",
      sessionId: `session-${jobId}`,
      write: false
    },
    request: {
      type: "task",
      cwd: workspaceRoot,
      model: null,
      effort: null,
      prompt: "Exercise the enqueue launch boundary.",
      write: false,
      resumeLast: false,
      jobId
    }
  };
}

function forceStopTestWorker(worker) {
  if (!Number.isSafeInteger(worker?.pid)) {
    return;
  }
  if (worker.platform === "win32") {
    run("taskkill", ["/PID", String(worker.pid), "/T", "/F"]);
    return;
  }
  try {
    process.kill(-worker.pid, "SIGKILL");
  } catch {
    process.kill(worker.pid, "SIGKILL");
  }
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition.");
}

function runAsync(command, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin.end(options.input ?? "");
    const timeout =
      options.timeoutMs == null
        ? null
        : setTimeout(() => {
            child.kill("SIGTERM");
          }, options.timeoutMs);
    child.on("close", (status, signal) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      resolve({ status, signal, stdout, stderr, timedOut: signal === "SIGTERM" });
    });
  });
}

test("setup reports ready when fake codex is installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.match(payload.claude.detail, /minimum 2\.1\.218/);
  assert.match(payload.codex.detail, /turn\/steer.*thread\/read available/);
  assert.equal(payload.sessionRuntime.mode, "direct");
});

test("setup rejects an old Claude Code version", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "old-claude");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.match(payload.claude.detail, /2\.1\.218 or later is required/);
  assert.ok(payload.nextSteps.some((step) => step.includes("Upgrade Claude Code")));
});

test("setup rejects an old Codex version before probing app-server", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "old-codex");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.match(payload.codex.detail, /0\.145\.0 or later is required/);
});

test("setup fails closed when Codex omits the native turn steer schema", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "missing-turn-steer");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.match(payload.codex.detail, /turn\/steer capability unavailable/);
});

test("setup fails closed when Codex omits the authoritative thread read schema", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "missing-thread-read");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.match(payload.codex.detail, /thread\/read capability unavailable/);
});

test("setup is ready without npm when Codex is already installed and authenticated", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  if (process.platform === "win32") {
    fs.writeFileSync(
      path.join(binDir, "node.cmd"),
      `@echo off\r\n"${process.execPath}" %*\r\n`,
      "utf8"
    );
  } else {
    fs.symlinkSync(process.execPath, path.join(binDir, "node"));
  }

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: binDir
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.npm.available, false);
  assert.equal(payload.codex.available, true);
  assert.equal(payload.auth.loggedIn, true);
});

test("setup trusts app-server API key auth even when login status alone would fail", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "api-key-account-only");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, "apiKey");
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /API key configured \(unverified\)/);
});

test("setup is ready when the active provider does not require OpenAI login", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup treats custom providers with app-server-ready config as ready", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "env-key-provider");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, true);
  assert.equal(payload.auth.loggedIn, true);
  assert.equal(payload.auth.authMethod, null);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /configured and does not require OpenAI authentication/i);
});

test("setup reports not ready when app-server config read fails", () => {
  const binDir = makeTempDir();
  installFakeCodex(binDir, "config-read-fails");

  const result = run("node", [SCRIPT, "setup", "--json"], {
    cwd: ROOT,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ready, false);
  assert.equal(payload.auth.loggedIn, false);
  assert.equal(payload.auth.source, "app-server");
  assert.match(payload.auth.detail, /config\/read failed for cwd/);
});

test("review renders a no-findings result from app-server review/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed uncommitted changes/);
  assert.match(result.stdout, /No material issues found/);
});

test("task runs when the active provider does not require OpenAI login", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "provider-no-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check auth preflight"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task runs without auth preflight so Codex can refresh an expired session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check refreshable auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
});

test("task fails closed when its direct app-server exits after turn/start", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const env = buildEnv(binDir);
  installFakeCodex(binDir, "app-server-exits-after-turn-start");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = await runAsync("node", [SCRIPT, "task", "prove transport failure"], {
    cwd: repo,
    env,
    timeoutMs: 3000
  });

  assert.equal(result.timedOut, false, "task hung after its direct app-server exited");
  assert.notEqual(result.status, 0);
  const [job] = loadState(repo).jobs;
  assert.equal(job.status, "failed");
  assert.equal(job.pid, null);
  assert.match(job.errorMessage, /connection closed unexpectedly/i);
});

test("task uses an invocation-owned direct app-server by default", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "run in direct mode"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
});

test("direct task drains terminal output before treating process exit as transport failure", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "terminal-then-immediate-exit");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "drain final output"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Handled the requested task/);
  const [job] = loadState(repo).jobs;
  assert.equal(job.status, "completed");
});

test("a foreground launcher can die while its owned worker finishes the job", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launcher = spawn(
    process.execPath,
    [SCRIPT, "task", "survive the foreground launcher"],
    {
      cwd: repo,
      env: buildEnv(binDir),
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  launcher.stdout.resume();
  launcher.stderr.resume();

  const running = await waitFor(() => {
    const job = loadState(repo).jobs[0];
    return job?.status === "running" && job.worker?.token ? job : null;
  });
  launcher.kill("SIGKILL");
  await new Promise((resolve) => launcher.once("close", resolve));

  const completed = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === running.id);
    return job?.status === "completed" ? job : null;
  });
  assert.equal(completed.worker, null);
  assert.equal(completed.pid, null);
  assert.match(completed.rendered, /Handled the requested task/);
});

test("a short task in the same workspace cannot stop another task's app-server", async () => {
  const repo = makeTempDir();
  const slowBinDir = makeTempDir();
  const shortBinDir = makeTempDir();
  const slowStatePath = path.join(slowBinDir, "fake-codex-state.json");
  installFakeCodex(slowBinDir, "slow-task");
  installFakeCodex(shortBinDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const slowTask = runAsync("node", [SCRIPT, "task", "keep running"], {
    cwd: repo,
    env: {
      ...buildEnv(slowBinDir),
      CODEX_COMPANION_SESSION_ID: "session-a"
    }
  });
  await waitFor(() => {
    if (!fs.existsSync(slowStatePath)) {
      return false;
    }
    const fakeState = JSON.parse(fs.readFileSync(slowStatePath, "utf8"));
    return fakeState.lastTurnStart ?? null;
  });

  const shortTask = run("node", [SCRIPT, "task", "finish independently"], {
    cwd: repo,
    env: {
      ...buildEnv(shortBinDir),
      CODEX_COMPANION_SESSION_ID: "session-b"
    }
  });
  const shortJob = loadState(repo).jobs.find((job) => job.sessionId === "session-b");
  const unrelatedSessionEnd = run("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: buildEnv(shortBinDir),
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "session-b",
      cwd: repo
    })
  });
  const slowResult = await slowTask;

  assert.equal(shortTask.status, 0, shortTask.stderr);
  assert.equal(shortJob?.status, "completed");
  assert.equal(unrelatedSessionEnd.status, 0, unrelatedSessionEnd.stderr);
  assert.equal(slowResult.status, 0, slowResult.stderr);
  assert.match(shortTask.stdout, /Handled the requested task/);
  assert.match(slowResult.stdout, /Handled the requested task/);
  const slowJob = loadState(repo).jobs.find((job) => job.sessionId === "session-a");
  assert.equal(slowJob?.status, "completed");
});

test("transfer delegates the current Claude session directly to native import", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sessionId = "sess-native-transfer";
  fs.mkdirSync(repo, { recursive: true });
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);

  fs.writeFileSync(
    sourcePath,
    [
      { type: "custom-title", customTitle: "Native transfer" },
      { type: "user", cwd: repo, message: { role: "user", content: "Initial request" } },
      { type: "assistant", cwd: repo, message: { role: "assistant", content: "Initial answer" } },
      { type: "user", cwd: repo, message: { role: "user", content: "/codex:transfer" } }
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    "utf8"
  );
  const result = run("node", [SCRIPT, "transfer", "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex"),
      CODEX_COMPANION_TRANSCRIPT_PATH: sourcePath
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  const canonicalSourcePath = fs.realpathSync(sourcePath);
  assert.equal(payload.threadId, "thr_1");
  assert.equal(payload.resumeCommand, "codex resume thr_1");
  assert.equal(payload.sourcePath, canonicalSourcePath);
  assert.equal(payload.sessionId, sessionId);

  const fakeState = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.equal(fakeState.threads.length, 1);
  assert.equal(fakeState.threads[0].ephemeral, false);
  assert.equal(fakeState.threads[0].name, "Native transfer");
  assert.equal(fakeState.lastExternalAgentImport.sourcePath, canonicalSourcePath);
  assert.deepEqual(
    fakeState.threads[0].visibleMessages.map((message) => message.text),
    ["Initial request", "Initial answer", "/codex:transfer"]
  );
});

test("transfer reports an actionable upgrade error when native import is unsupported", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-unsupported");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Continue this work." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath, "--json"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not support Claude session transfer/);
  assert.match(result.stderr, /@openai\/codex@latest/);
});

test("transfer fails visibly when native import completes without a ledger record", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const projectDir = path.join(home, ".claude", "projects", "-repo");
  const sourcePath = path.join(projectDir, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  installFakeCodex(binDir, "external-import-fails");
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Do not lose this request." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      HOME: home,
      CODEX_HOME: path.join(home, ".codex")
    }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /did not record an imported thread/);
});

test("transfer rejects sources outside the Claude projects directory", () => {
  const home = makeTempDir();
  const repo = path.join(home, "repo");
  const binDir = makeTempDir();
  const sourcePath = path.join(home, "session.jsonl");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true });
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(
    sourcePath,
    `${JSON.stringify({ type: "user", cwd: repo, message: { role: "user", content: "Outside source." } })}\n`,
    "utf8"
  );

  const result = run("node", [SCRIPT, "transfer", "--source", sourcePath], {
    cwd: repo,
    env: { ...buildEnv(binDir), HOME: home }
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /only from .*\.claude.*projects/);
});

test("task reports the actual Codex auth error when the run is rejected", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "auth-run-fails");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "check failed auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /authentication expired; run codex login/);
});

test("review accepts the quoted raw argument style for built-in base-branch review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 1;\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = 2;\n");

  const result = run("node", [SCRIPT, "review", "--base main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Reviewed changes against main/);
  assert.match(result.stdout, /No material issues found/);
});

test("background review parses a prepended flag inside the quoted raw argument", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run(
    "node",
    [SCRIPT, "review", "--background --base main"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );
  assert.equal(launched.status, 0, launched.stderr);
  assert.match(launched.stdout, /started in the background/i);
  const jobId = loadState(repo).jobs[0].id;
  const completed = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "completed" ? job : null;
  });
  assert.equal(completed.summary.includes("main"), true);
});

test("encoded review arguments preserve exact raw focus text without workspace files", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const marker = path.join(repo, "argument-injection-marker");
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  const rawFocus =
    `focus  exactly on C:\\tmp\\file, "$(touch ${marker})"; ` +
    `backticks \`touch ${marker}\`, empty '', tail  `;
  const rawArguments = `--base main ${rawFocus}`;
  const encodedArguments = Buffer.from(rawArguments, "utf8").toString("base64");
  const filesBefore = fs.readdirSync(repo).sort();

  const result = run(
    "node",
    [
      SCRIPT,
      "adversarial-review",
      "--arguments-base64",
      encodedArguments
    ],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(fs.readdirSync(repo).sort(), filesBefore);
  assert.equal(fs.existsSync(marker), false);
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt.includes(rawFocus), true);
  assert.match(fakeState.lastTurnStart.prompt, /argument-injection-marker/);
});

test("encoded review arguments fail closed on non-canonical base64", () => {
  const repo = makeTempDir();
  const result = run(
    "node",
    [SCRIPT, "review", "--arguments-base64", "not-base64"],
    { cwd: repo }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /canonical base64/i);
});

test("adversarial review renders structured findings over app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review accepts the same base-branch targeting as review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0];\n");
  run("git", ["add", "src/app.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "app.js"), "export const value = items[0].id;\n");

  const result = run("node", [SCRIPT, "adversarial-review", "--base", "main"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Branch review against main|against main/i);
  assert.match(result.stdout, /Missing empty-state guard/);
});

test("adversarial review asks Codex to inspect larger diffs itself", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.mkdirSync(path.join(repo, "src"));
  for (const name of ["a.js", "b.js", "c.js"]) {
    fs.writeFileSync(path.join(repo, "src", name), `export const value = "${name}-v1";\n`);
  }
  run("git", ["add", "src/a.js", "src/b.js", "src/c.js"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "src", "a.js"), 'export const value = "PROMPT_SELF_COLLECT_A";\n');
  fs.writeFileSync(path.join(repo, "src", "b.js"), 'export const value = "PROMPT_SELF_COLLECT_B";\n');
  fs.writeFileSync(path.join(repo, "src", "c.js"), 'export const value = "PROMPT_SELF_COLLECT_C";\n');

  const result = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8"));
  assert.match(state.lastTurnStart.prompt, /lightweight summary/i);
  assert.match(state.lastTurnStart.prompt, /read-only git commands/i);
  assert.doesNotMatch(state.lastTurnStart.prompt, /PROMPT_SELF_COLLECT_[ABC]/);
});

test("review includes reasoning output when the app server returns it", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Reasoning:/);
  assert.match(result.stdout, /Reviewed the changed files and checked the likely regression paths first|Reviewed the changed files and checked the likely regression paths/i);
});

test("review logs reasoning summaries and review output to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Reviewed the changed files and checked the likely regression paths/);
  assert.match(log, /Review output/);
  assert.match(log, /Reviewed uncommitted changes\./);
});

test("task --resume-last resumes the latest persisted task thread", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Resumed the prior run.\nFollow-up prompt accepted.\n");
});

test("task-resume-candidate returns the latest rescue thread from the current session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-current",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Investigate the flaky test",
            updatedAt: "2026-03-24T20:00:00.000Z"
          },
          {
            id: "task-other-session",
            status: "completed",
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old rescue run",
            updatedAt: "2026-03-24T20:05:00.000Z"
          },
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_review",
            summary: "Review main...HEAD",
            updatedAt: "2026-03-24T20:10:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const result = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.sessionId, "sess-current");
  assert.equal(payload.candidate.id, "task-current");
  assert.equal(payload.candidate.threadId, "thr_current");
});

test("task --resume-last does not resume a task from another Claude session", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const otherEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const currentEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: otherEnv
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const candidate = run("node", [SCRIPT, "task-resume-candidate", "--json"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(candidate.status, 0, candidate.stderr);
  assert.equal(JSON.parse(candidate.stdout).available, false);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env: currentEnv
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);

  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "initial task");
});

test("task --resume-last ignores running tasks from other Claude sessions", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  fs.mkdirSync(path.join(stateDir, "jobs"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other-running",
            ...activeLauncherFields(),
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Other session active task",
            updatedAt: "2026-03-24T20:05:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const resume = run("node", [SCRIPT, "task", "--resume-last", "follow up"], {
    cwd: repo,
    env
  });
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /No previous Codex task thread was found for this repository\./);
});

test("session start hook exports plugin data without leaking the scoped Claude variable", () => {
  const repo = makeTempDir();
  const envFile = path.join(makeTempDir(), "claude-env.sh");
  fs.writeFileSync(envFile, "", "utf8");
  const pluginDataDir = makeTempDir();
  const transcriptPath = path.join(repo, "session.jsonl");

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CLAUDE_ENV_FILE: envFile,
      CLAUDE_PLUGIN_DATA: pluginDataDir
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "sess-current",
      transcript_path: transcriptPath,
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(envFile, "utf8"),
    `export CODEX_COMPANION_SESSION_ID='sess-current'\nexport CODEX_COMPANION_TRANSCRIPT_PATH='${transcriptPath}'\nexport CODEX_COMPANION_PLUGIN_DATA='${pluginDataDir}'\n`
  );
});

test("session start hook fails closed on arrays and invalid field types", async (t) => {
  const cases = [
    ["array input", []],
    ["invalid cwd", { cwd: 42 }],
    ["invalid session id", { session_id: null }],
    ["invalid transcript path", { transcript_path: [] }],
    ["invalid event name", { hook_event_name: {} }]
  ];

  for (const [name, input] of cases) {
    await t.test(name, () => {
      const repo = makeTempDir();
      const result = run(process.execPath, [SESSION_HOOK, "SessionStart"], {
        cwd: repo,
        input: JSON.stringify(input)
      });

      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      const payload = JSON.parse(result.stdout);
      assert.deepEqual(Object.keys(payload).sort(), ["continue", "stopReason"]);
      assert.equal(payload.continue, false);
      assert.match(payload.stopReason, /must be a JSON object|must be a string/i);
    });
  }
});

test("session start hook blocks within its default recovery budget while the state lock is held", async () => {
  const repo = makeTempDir();
  const barrierDir = makeTempDir();
  const enteredFile = path.join(barrierDir, "entered");
  const releaseFile = path.join(barrierDir, "release");
  upsertJob(repo, {
    id: "task-session-start-held-lock",
    status: "running",
    pid: 2147483647
  });
  const stateModuleUrl = new URL(
    "../plugins/codex/scripts/lib/state.mjs",
    import.meta.url
  ).href;
  const lockOwner = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import fs from "node:fs";
        import { withStateTransaction } from ${JSON.stringify(stateModuleUrl)};
        const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        withStateTransaction(process.env.TEST_WORKSPACE, () => {
          fs.writeFileSync(process.env.TEST_ENTERED, "entered");
          while (!fs.existsSync(process.env.TEST_RELEASE)) sleep();
        });
      `
    ],
    {
      env: {
        ...process.env,
        TEST_WORKSPACE: repo,
        TEST_ENTERED: enteredFile,
        TEST_RELEASE: releaseFile
      },
      stdio: "ignore"
    }
  );

  try {
    await waitFor(() => fs.existsSync(enteredFile));
    const startedAt = Date.now();
    const result = await runAsync(process.execPath, [SESSION_HOOK, "SessionStart"], {
      cwd: repo,
      env: process.env,
      timeoutMs: 5000,
      input: JSON.stringify({
        hook_event_name: "SessionStart",
        session_id: "sess-held-lock",
        cwd: repo
      })
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.timedOut, false, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(elapsedMs < 5000, `SessionStart took ${elapsedMs} ms`);
    assert.equal(result.stderr, "");
    const payload = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(payload).sort(), ["continue", "stopReason"]);
    assert.equal(payload.continue, false);
    assert.equal(typeof payload.stopReason, "string");
    assert.match(payload.stopReason, /timed out waiting for state lock/i);
    assert.equal(result.stdout, `${JSON.stringify(payload)}\n`);
  } finally {
    fs.writeFileSync(releaseFile, "release");
    await new Promise((resolve, reject) => {
      lockOwner.once("error", reject);
      lockOwner.once("close", resolve);
    });
  }
});

test("write task output focuses on the Codex result without generic follow-up hints", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--write", "fix the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task --resume acts like --resume-last without leaking the flag into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const firstRun = run("node", [SCRIPT, "task", "initial task"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);

  const result = run("node", [SCRIPT, "task", "--resume", "follow up"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.threadId, "thr_1");
  assert.equal(fakeState.lastTurnStart.prompt, "follow up");
});

test("task --fresh is treated as routing control and does not leak into the prompt", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--fresh", "diagnose the flaky test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.prompt, "diagnose the flaky test");
});

test("task forwards model selection and reasoning effort to app-server turn/start", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "--model", "spark", "--effort", "low", "diagnose the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const fakeState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(fakeState.lastTurnStart.model, "gpt-5.3-codex-spark");
  assert.equal(fakeState.lastTurnStart.effort, "low");
});

test("task logs reasoning summaries and assistant messages to the job log", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-reasoning");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Reasoning summary/);
  assert.match(log, /Inspected the prompt, gathered evidence, and checked the highest-risk paths first/);
  assert.match(log, /Assistant message/);
  assert.match(log, /Handled the requested task/);
});

test("task logs subagent reasoning and messages with a subagent prefix", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent design-challenger via collaboration tool: wait\./);
  assert.match(log, /Subagent design-challenger reasoning:/);
  assert.match(log, /Questioned the retry strategy and the cache invalidation boundaries\./);
  assert.match(log, /Subagent design-challenger:/);
  assert.match(
    log,
    /The design assumes retries are harmless, but they can duplicate side effects without stronger idempotency guarantees\./
  );
});

test("task waits for the main thread to complete before returning the final result", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task ignores later subagent messages when choosing the final returned output", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-late-subagent-message");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task can finish after subagent work even if the parent turn/completed event is missing", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent-no-main-turn-completed");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("task does not infer success before a delayed terminal failure", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "final-answer-then-delayed-failure");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "verify the terminal outcome"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 1, result.stdout);
  const fakeState = JSON.parse(
    fs.readFileSync(path.join(binDir, "fake-codex-state.json"), "utf8")
  );
  assert.equal(fakeState.threads[0].turns[0].status, "failed");
});

test("task waits for collaboration announced after the final answer", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "late-collaboration-after-final-answer");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const result = run("node", [SCRIPT, "task", "wait for all verification"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
  const stateDir = resolveStateDir(repo);
  const state = JSON.parse(
    fs.readFileSync(path.join(stateDir, "state.json"), "utf8")
  );
  const log = fs.readFileSync(state.jobs[0].logFile, "utf8");
  assert.match(log, /Starting subagent late-checker via collaboration tool: wait\./);
  assert.match(log, /Subagent late-checker completed\./);
});

test("direct task still completes when Codex spawns subagents", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "with-subagent");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);
  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);


  const result = run("node", [SCRIPT, "task", "challenge the current design"], {
    cwd: repo,
    env
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Handled the requested task.\nTask prompt accepted.\n");
});

test("background task removes its log when canonical state publication fails", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "state.json"), "{", {
    encoding: "utf8",
    mode: 0o600
  });

  const result = run(
    "node",
    [SCRIPT, "task", "--background", "publication must fail"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unexpected end of JSON input|JSON/i);
  assert.deepEqual(
    fs.readdirSync(jobsDir).filter((entry) => entry.endsWith(".log")),
    []
  );
  assert.equal(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"), "{");
});

test("synchronous worker spawn failure after publication converges the job to failed", async () => {
  const repo = makeTempDir();
  const jobId = "task-sync-spawn-failure";
  const { job, request } = buildEnqueueBoundaryFixture(repo, jobId);
  let spawnCalls = 0;
  let publishedLogFile = null;

  await assert.rejects(
    enqueueOwnedJob(repo, job, request, {
      background: true,
      spawnWorkerOptions: {
        spawnImpl() {
          spawnCalls += 1;
          const published = loadState(repo).jobs.find(
            (candidate) => candidate.id === jobId
          );
          assert.equal(published?.status, "queued");
          assert.equal(published?.phase, "spawning");
          assert.equal(typeof published?.launcher?.startKey, "string");
          assert.equal(typeof published?.launchToken, "string");
          assert.equal(typeof published?.logFile, "string");
          publishedLogFile = published.logFile;
          assert.equal(fs.existsSync(publishedLogFile), true);
          throw new Error("synchronous worker spawn failure");
        }
      }
    }),
    /synchronous worker spawn failure/
  );

  const failed = loadState(repo).jobs.find(
    (candidate) => candidate.id === jobId
  );
  assert.equal(spawnCalls, 1);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.phase, "failed");
  assert.equal(failed?.pid, null);
  assert.equal(failed?.worker, null);
  assert.equal(failed?.launcher, null);
  assert.match(failed?.errorMessage ?? "", /synchronous worker spawn failure/);
  assert.equal(fs.existsSync(publishedLogFile), true);
});

test("failed enqueue cleanup preserves recoverable worker ownership", async () => {
  const repo = makeTempDir();
  const jobId = "task-recoverable-launch-cleanup";
  const { job, request } = buildEnqueueBoundaryFixture(repo, jobId);
  const worker =
    process.platform === "win32"
      ? makeWindowsWorker({
          pid: 424242,
          token: "replaced-after-publication"
        })
      : makePosixWorker({
          pid: 424242,
          token: "replaced-after-publication",
          startKey: "recoverable-worker-start"
        });
  let launchToken = "";

  await assert.rejects(
    enqueueOwnedJob(repo, job, request, {
      background: true,
      spawnWorkerOptions: {
        spawnImpl() {
          const published = loadState(repo).jobs.find(
            (candidate) => candidate.id === jobId
          );
          launchToken = published?.launchToken ?? "";
          const child = new EventEmitter();
          child.pid = worker.pid;
          child.unref = () => {};
          queueMicrotask(() => {
            child.emit("error", new Error("worker failed during spawn"));
          });
          return child;
        }
      },
      cleanupOptions: {
        captureUnclaimedWorkerImpl(_pid, token) {
          return { ...worker, token };
        },
        async stopOwnedWorkerTreeImpl() {
          throw new Error("owned worker cleanup failed");
        }
      }
    }),
    (error) =>
      error instanceof AggregateError &&
      error.errors.some((cause) =>
        /worker failed during spawn/.test(String(cause))
      ) &&
      error.errors.some((cause) =>
        /owned worker cleanup failed/.test(String(cause))
      )
  );

  const recoverable = loadState(repo).jobs.find(
    (candidate) => candidate.id === jobId
  );
  assert.equal(typeof launchToken, "string");
  assert.ok(launchToken);
  assert.equal(recoverable?.status, "cancelling");
  assert.equal(recoverable?.phase, "launch-cleanup-failed");
  assert.equal(recoverable?.pid, worker.pid);
  assert.equal(recoverable?.worker?.token, launchToken);
  assert.equal(recoverable?.worker?.startKey, worker.startKey);
  assert.equal(recoverable?.launcher, null);
  assert.match(
    recoverable?.errorMessage ?? "",
    /owned worker cleanup failed/
  );
});

test("task --background enqueues a detached worker and exposes per-job status", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the failing test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^task-/);
  const claimedJob = loadState(repo).jobs.find((job) => job.id === launchPayload.jobId);
  assert.equal(claimedJob?.status, "running");
  assert.equal(typeof claimedJob?.worker?.token, "string");
  assert.equal(
    claimedJob?.worker?.processGroupId,
    process.platform === "win32" ? null : claimedJob?.worker?.pid
  );

  const waitedStatus = run(
    "node",
    [SCRIPT, "status", launchPayload.jobId, "--wait", "--timeout-ms", "15000", "--json"],
    {
      cwd: repo,
      env: buildEnv(binDir)
    }
  );

  assert.equal(waitedStatus.status, 0, waitedStatus.stderr);
  const waitedPayload = JSON.parse(waitedStatus.stdout);
  assert.equal(waitedPayload.job.id, launchPayload.jobId);
  assert.equal(waitedPayload.job.status, "completed");

  const resultPayload = await waitFor(() => {
    const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
      cwd: repo,
      env: buildEnv(binDir)
    });
    if (result.status !== 0) {
      return null;
    }
    return JSON.parse(result.stdout);
  });

  assert.equal(resultPayload.job.id, launchPayload.jobId);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /Handled the requested task/);
});

test("fake app-server accepts turn/steer only for the exact active turn", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "steerable-slow-task");
  const client = await CodexAppServerClient.connect(repo, {
    env: buildEnv(binDir)
  });
  t.after(() => client.close());

  const threadResponse = await client.request("thread/start", {
    cwd: repo,
    model: null,
    approvalPolicy: "never",
    sandbox: "read-only",
    serviceName: "test",
    ephemeral: true
  });
  const threadId = threadResponse.thread.id;
  const turnResponse = await client.request("turn/start", {
    threadId,
    input: [{ type: "text", text: "start slowly", text_elements: [] }],
    model: null,
    effort: null,
    outputSchema: null
  });
  const turnId = turnResponse.turn.id;

  await assert.rejects(
    client.request("turn/steer", {
      threadId,
      input: [{ type: "text", text: "wrong turn", text_elements: [] }],
      expectedTurnId: "turn_wrong",
      clientUserMessageId: "request-wrong"
    }),
    /expectedTurnId does not match the active turn/i
  );

  const accepted = await client.request("turn/steer", {
    threadId,
    input: [{ type: "text", text: "use the exact turn", text_elements: [] }],
    expectedTurnId: turnId,
    clientUserMessageId: "request-exact"
  });
  assert.equal(accepted.turnId, turnId);

  await new Promise((resolve) => setTimeout(resolve, 2700));
  await assert.rejects(
    client.request("turn/steer", {
      threadId,
      input: [{ type: "text", text: "too late", text_elements: [] }],
      expectedTurnId: turnId,
      clientUserMessageId: "request-late"
    }),
    /expectedTurnId does not match the active turn/i
  );
});

test("send requires an explicit job, instruction, current session, and running task", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-send-validation"
  };

  const missingInstruction = run(
    "node",
    [SCRIPT, "send", "task-missing-instruction", "--json"],
    { cwd: repo, env }
  );
  assert.equal(missingInstruction.status, 1);
  assert.match(missingInstruction.stderr, /non-empty instruction/i);

  const missingJob = run(
    "node",
    [SCRIPT, "send", "task-absent", "--json", "do this"],
    { cwd: repo, env }
  );
  assert.equal(missingJob.status, 1);
  assert.match(missingJob.stderr, /No stored job found/i);

  upsertJob(repo, {
    id: "task-queued",
    status: "queued",
    jobClass: "task",
    sessionId: "sess-send-validation",
    launchToken: "launch-token"
  });
  const queuedJob = run(
    "node",
    [SCRIPT, "send", "task-queued", "--json", "do this"],
    { cwd: repo, env }
  );
  assert.equal(queuedJob.status, 1);
  assert.match(queuedJob.stderr, /not a running background task/i);
});

test("send steers the exact active background turn and the final result reflects it", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const steeringRoot = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "steerable-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-steer-success",
    CODEX_COMPANION_STEERING_ROOT: steeringRoot
  };
  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "investigate the flaky test"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const runningJob = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.threadId && job.turnId && job.steering
      ? job
      : null;
  }, { timeoutMs: 15000 });
  t.after(() => {
    try {
      forceStopTestWorker(runningJob.worker);
    } catch {
      // The background worker already finished.
    }
  });
  const endpointAddress = runningJob.steering.address;
  if (runningJob.steering.kind === "unix") {
    assert.equal(fs.existsSync(endpointAddress), true);
  }

  const instruction =
    "  first  line\nsecond\t\"quoted\" C:\\tmp\\file /\\d+\\s+/ it's exact\\  ";
  const sent = run(
    "node",
    [SCRIPT, "send", jobId, "--json", instruction],
    { cwd: repo, env }
  );
  assert.equal(sent.status, 0, sent.stderr);
  const acknowledgement = JSON.parse(sent.stdout);
  assert.equal(acknowledgement.status, "accepted");
  assert.equal(acknowledgement.jobId, jobId);
  assert.equal(acknowledgement.threadId, runningJob.threadId);
  assert.equal(acknowledgement.turnId, runningJob.turnId);
  assert.match(acknowledgement.requestId, /^steer-/);

  const completedJob = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "completed" ? job : null;
  }, { timeoutMs: 15000 });
  assert.equal(completedJob.steering, null);
  if (runningJob.steering.kind === "unix") {
    assert.equal(fs.existsSync(endpointAddress), false);
  }

  const result = run("node", [SCRIPT, "result", jobId, "--json"], {
    cwd: repo,
    env
  });
  assert.equal(result.status, 0, result.stderr);
  const resultPayload = JSON.parse(result.stdout);
  assert.match(
    resultPayload.storedJob.result.rawOutput,
    /Steering applied:/
  );

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);
  assert.equal(fakeState.steerCalls, 1);
  assert.equal(fakeState.lastSteer.threadId, runningJob.threadId);
  assert.equal(fakeState.lastSteer.expectedTurnId, runningJob.turnId);
  assert.equal(fakeState.lastSteer.clientUserMessageId, acknowledgement.requestId);
  assert.equal(fakeState.lastSteer.instruction, instruction);

  const lateSend = run(
    "node",
    [SCRIPT, "send", jobId, "--json", "this must be rejected"],
    { cwd: repo, env }
  );
  assert.equal(lateSend.status, 1);
  assert.match(lateSend.stderr, /not a running background task/i);
});

test("post-dispatch malformed or wrong-turn app-server acknowledgements stay delivery unknown through private steering", async (t) => {
  for (const behavior of ["steer-ack-malformed", "steer-ack-mismatch"]) {
    const repo = makeTempDir();
    const binDir = makeTempDir();
    const steeringRoot = makeTempDir();
    const fakeStatePath = path.join(binDir, "fake-codex-state.json");
    installFakeCodex(binDir, behavior);
    initGitRepo(repo);

    const env = {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: `sess-${behavior}`,
      CODEX_COMPANION_STEERING_ROOT: steeringRoot
    };
    const launched = run(
      "node",
      [SCRIPT, "task", "--background", "--json", `wait for ${behavior}`],
      { cwd: repo, env }
    );
    assert.equal(launched.status, 0, launched.stderr);
    const jobId = JSON.parse(launched.stdout).jobId;
    const runningJob = await waitFor(() => {
      const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
      return job?.status === "running" && job.threadId && job.turnId && job.steering
        ? job
        : null;
    }, { timeoutMs: 15000 });
    t.after(() => {
      try {
        forceStopTestWorker(runningJob.worker);
      } catch {
        // The background worker already finished.
      }
    });

    const sent = run(
      "node",
      [SCRIPT, "send", jobId, "--json", `apply ${behavior} once`],
      { cwd: repo, env }
    );
    assert.equal(sent.status, 1);
    assert.match(sent.stderr, /delivery unknown/i);

    const log = fs.readFileSync(runningJob.logFile, "utf8");
    assert.match(log, /Steering delivery unknown request=/);
    assert.doesNotMatch(log, /Steering rejected request=/);

    const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
    assert.equal(fakeState.steerCalls, 1);
    assert.equal(fakeState.lastSteer.expectedTurnId, runningJob.turnId);
  }
});

test("send hook preserves raw instructions and never evaluates shell syntax", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const steeringRoot = makeTempDir();
  const marker = path.join(repo, "shell-injection-marker");
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "steerable-slow-task");
  initGitRepo(repo);

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-send-hook",
    CODEX_COMPANION_STEERING_ROOT: steeringRoot
  };
  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "wait for hook steering"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const runningJob = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.steering ? job : null;
  }, { timeoutMs: 15000 });
  t.after(() => {
    try {
      forceStopTestWorker(runningJob.worker);
    } catch {
      // The owned worker already finished.
    }
  });

  const instruction =
    `  exact\tline\n"quotes" 'single' C:\\tmp\\file $(touch ${marker}) ; \`touch ${marker}\``;
  const hook = run("node", [SCRIPT, "send-hook"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "UserPromptExpansion",
      command_name: "codex:send",
      command_args: `${jobId} ${instruction}`,
      session_id: "sess-send-hook",
      cwd: repo
    })
  });
  assert.equal(hook.status, 0, hook.stderr);
  const response = JSON.parse(hook.stdout);
  assert.equal(response.decision, "block");
  assert.match(response.reason, /Accepted instruction/);
  assert.equal(fs.existsSync(marker), false);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.steerCalls, 1);
  assert.equal(fakeState.lastSteer.instruction, instruction);
});

test("send hook fails closed when delivery cannot be attempted", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  const hook = run("node", [SCRIPT, "send-hook"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "UserPromptExpansion",
      command_name: "codex:send",
      command_args: "",
      session_id: "sess-send-hook",
      cwd: repo
    })
  });
  assert.equal(hook.status, 0, hook.stderr);
  const response = JSON.parse(hook.stdout);
  assert.equal(response.decision, "block");
  assert.match(response.reason, /explicit background job id/i);
});

test("review hook injects exact deterministic base64 without evaluating raw arguments", () => {
  const repo = makeTempDir();
  const marker = path.join(repo, "review-hook-shell-marker");
  initGitRepo(repo);
  const rawArguments =
    `  --scope working-tree  critique café 東京 $(touch ${marker}) ; \`touch ${marker}\`\nsecond\tline  `;

  const hook = run("node", [SCRIPT, "review-hook"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "UserPromptExpansion",
      command_name: "codex:adversarial-review",
      command_args: rawArguments,
      session_id: "sess-review-hook",
      cwd: repo
    })
  });

  assert.equal(hook.status, 0, hook.stderr);
  assert.deepEqual(JSON.parse(hook.stdout), {
    hookSpecificOutput: {
      hookEventName: "UserPromptExpansion",
      additionalContext: `Deterministic review transport: ${JSON.stringify({
        argumentsBase64: Buffer.from(rawArguments, "utf8").toString("base64")
      })}`
    }
  });
  assert.equal(fs.existsSync(marker), false);

  const emptyHook = run("node", [SCRIPT, "review-hook"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "UserPromptExpansion",
      command_name: "review",
      command_args: "",
      session_id: "sess-review-hook",
      cwd: repo
    })
  });
  assert.equal(emptyHook.status, 0, emptyHook.stderr);
  assert.deepEqual(JSON.parse(emptyHook.stdout), {
    hookSpecificOutput: {
      hookEventName: "UserPromptExpansion",
      additionalContext:
        "Deterministic review transport: {\"argumentsBase64\":\"\"}"
    }
  });
});

test("review hook executes an explicit foreground mode without a shell", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const marker = path.join(repo, "review-hook-wait-shell-marker");
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "before\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "after\n", "utf8");
  const focus =
    `critique café 東京 $(touch ${marker}) ; \`touch ${marker}\`\nsecond\tline`;
  const rawArguments = `--wait --scope working-tree ${focus}`;

  const hook = run("node", [SCRIPT, "review-hook"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      hook_event_name: "UserPromptExpansion",
      command_name: "codex:adversarial-review",
      command_args: rawArguments,
      session_id: "sess-review-hook-wait",
      cwd: repo
    })
  });

  assert.equal(hook.status, 0, hook.stderr);
  const response = JSON.parse(hook.stdout);
  assert.equal(response.decision, "block");
  assert.match(response.reason, /Codex Adversarial Review/);
  assert.equal(fs.existsSync(marker), false);
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, new RegExp(focus.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("review hook preserves explicit background mode", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "steerable-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "before\n", "utf8");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "after\n", "utf8");

  const hook = run("node", [SCRIPT, "review-hook"], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      hook_event_name: "UserPromptExpansion",
      command_name: "review",
      command_args: "--background --scope working-tree",
      session_id: "sess-review-hook-background",
      cwd: repo
    })
  });

  assert.equal(hook.status, 0, hook.stderr);
  const response = JSON.parse(hook.stdout);
  assert.equal(response.decision, "block");
  assert.match(response.reason, /started in the background/i);
  const jobId = /started in the background as ([^.]+)\./.exec(response.reason)?.[1];
  assert.ok(jobId);
  const runningJob = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.worker ? job : null;
  }, { timeoutMs: 15000 });
  t.after(() => {
    try {
      forceStopTestWorker(runningJob.worker);
    } catch {
      // The owned worker already finished.
    }
  });
  assert.equal(runningJob.jobClass, "review");
  assert.equal(runningJob.sessionId, "sess-review-hook-background");
});

test("direct command hook preserves raw arguments without shell evaluation", () => {
  const repo = makeTempDir();
  const marker = path.join(repo, "command-hook-shell-marker");
  const uncPath = String.raw`\\server\share with space`;
  initGitRepo(repo);

  const setupArguments =
    `--enable-review-gate "$(touch\${IFS}${marker})" "${uncPath}"`;
  const setupHook = run("node", [SCRIPT, "command-hook"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "UserPromptExpansion",
      command_name: "codex:setup",
      command_args: setupArguments,
      session_id: "sess-command-hook",
      cwd: repo
    })
  });
  assert.equal(setupHook.status, 0, setupHook.stderr);
  const setupResponse = JSON.parse(setupHook.stdout);
  assert.equal(
    setupResponse.hookSpecificOutput.hookEventName,
    "UserPromptExpansion"
  );
  const encoded = JSON.parse(
    setupResponse.hookSpecificOutput.additionalContext.slice(
      "Deterministic command transport: ".length
    )
  ).argumentsBase64;
  assert.equal(Buffer.from(encoded, "base64").toString("utf8"), setupArguments);
  assert.equal(fs.existsSync(marker), false);

  const statusHook = run("node", [SCRIPT, "command-hook"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "UserPromptExpansion",
      command_name: "codex:status",
      command_args: `$(touch\${IFS}${marker})`,
      session_id: "sess-command-hook",
      cwd: repo
    })
  });
  assert.equal(statusHook.status, 0, statusHook.stderr);
  assert.equal(JSON.parse(statusHook.stdout).decision, "block");
  assert.equal(fs.existsSync(marker), false);

  const resultHook = run("node", [SCRIPT, "command-hook"], {
    cwd: repo,
    input: JSON.stringify({
      hook_event_name: "UserPromptExpansion",
      command_name: "result",
      command_args: `"${uncPath}"`,
      session_id: "sess-command-hook",
      cwd: repo
    })
  });
  assert.equal(resultHook.status, 0, resultHook.stderr);
  const resultResponse = JSON.parse(resultHook.stdout);
  assert.equal(resultResponse.decision, "block");
  assert.match(resultResponse.reason, /No job found/);
  assert.match(resultResponse.reason, /\\\\server\\share with space/);
  assert.equal(fs.existsSync(marker), false);
});

test("a failed active turn removes its steering endpoint and descriptor", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const steeringRoot = makeTempDir();
  installFakeCodex(binDir, "steerable-failing-task");
  initGitRepo(repo);

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-steer-failure",
    CODEX_COMPANION_STEERING_ROOT: steeringRoot
  };
  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "fail after steering activates"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const runningJob = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.steering ? job : null;
  }, { timeoutMs: 15000 });
  t.after(() => {
    try {
      forceStopTestWorker(runningJob.worker);
    } catch {
      // The failed task already stopped its worker.
    }
  });
  const endpointAddress = runningJob.steering.address;

  const failedJob = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "failed" ? job : null;
  }, { timeoutMs: 15000 });
  assert.equal(failedJob.steering, null);
  assert.equal(failedJob.worker, null);
  if (runningJob.steering.kind === "unix") {
    assert.equal(fs.existsSync(endpointAddress), false);
  }
});

test("send serves a foreign session holding the job id, and rejects stale generations and dead workers", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const steeringRoot = makeTempDir();
  installFakeCodex(binDir, "steerable-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const ownerEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-owner",
    CODEX_COMPANION_STEERING_ROOT: steeringRoot
  };
  const foreignEnv = {
    ...ownerEnv,
    CODEX_COMPANION_SESSION_ID: "sess-foreign"
  };
  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "stay active for validation"],
    { cwd: repo, env: ownerEnv }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const runningJob = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.steering ? job : null;
  }, { timeoutMs: 15000 });
  t.after(() => {
    try {
      forceStopTestWorker(runningJob.worker);
    } catch {
      // The test cleanup already stopped the worker.
    }
  });

  const foreignSend = run(
    "node",
    [SCRIPT, "send", jobId, "--json", "foreign instruction"],
    { cwd: repo, env: foreignEnv }
  );
  assert.equal(foreignSend.status, 0, foreignSend.stderr);
  const foreignPayload = JSON.parse(foreignSend.stdout);
  assert.equal(foreignPayload.jobId, jobId);
  assert.equal(foreignPayload.status, "accepted");
  assert.equal(foreignPayload.threadId, runningJob.threadId);

  const detachedEnv = { ...ownerEnv };
  delete detachedEnv.CODEX_COMPANION_SESSION_ID;
  const detachedSend = run(
    "node",
    [SCRIPT, "send", jobId, "--json", "detached instruction"],
    { cwd: repo, env: detachedEnv }
  );
  assert.equal(detachedSend.status, 0, detachedSend.stderr);
  assert.equal(JSON.parse(detachedSend.stdout).status, "accepted");

  const originalSteering = runningJob.steering;
  const staleWorker = {
    ...runningJob.worker,
    startKey: "stale-start-key"
  };
  mutateJobIf(
    repo,
    jobId,
    (current) => current.status === "running",
    () => ({
      worker: staleWorker,
      steering: {
        ...originalSteering,
        worker: staleWorker
      }
    })
  );
  const staleSend = run(
    "node",
    [SCRIPT, "send", jobId, "--json", "stale generation instruction"],
    { cwd: repo, env: ownerEnv }
  );
  assert.equal(staleSend.status, 1);
  assert.match(staleSend.stderr, /not a running background task/i);
  const staleJob = loadState(repo).jobs.find(
    (candidate) => candidate.id === jobId
  );
  assert.equal(staleJob.status, "failed");
  assert.match(staleJob.errorMessage, /identity no longer matches/i);
  assert.equal(staleJob.worker, null);
  assert.equal(staleJob.steering, null);
  if (originalSteering.kind === "unix") {
    assert.equal(fs.existsSync(originalSteering.address), false);
  }

  forceStopTestWorker(runningJob.worker);
  await waitFor(() => {
    try {
      process.kill(runningJob.worker.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const deadLaunch = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "stay active for dead worker validation"],
    { cwd: repo, env: ownerEnv }
  );
  assert.equal(deadLaunch.status, 0, deadLaunch.stderr);
  const deadJobId = JSON.parse(deadLaunch.stdout).jobId;
  const deadRunningJob = await waitFor(() => {
    const job = loadState(repo).jobs.find(
      (candidate) => candidate.id === deadJobId
    );
    return job?.status === "running" && job.steering ? job : null;
  }, { timeoutMs: 15000 });
  t.after(() => {
    try {
      forceStopTestWorker(deadRunningJob.worker);
    } catch {
      // The test already stopped this worker.
    }
  });
  forceStopTestWorker(deadRunningJob.worker);
  await waitFor(() => {
    try {
      process.kill(deadRunningJob.worker.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });
  const reconciled = run("node", [SCRIPT, "status", deadJobId, "--json"], {
    cwd: repo,
    env: ownerEnv
  });
  assert.equal(reconciled.status, 0, reconciled.stderr);
  const reconciledJob = JSON.parse(reconciled.stdout).job;
  assert.equal(reconciledJob.status, "failed");
  assert.match(reconciledJob.errorMessage, /exited without publishing/i);
  if (deadRunningJob.steering.kind === "unix") {
    assert.equal(fs.existsSync(deadRunningJob.steering.address), false);
  }
  const deadSend = run(
    "node",
    [SCRIPT, "send", deadJobId, "--json", "dead worker instruction"],
    { cwd: repo, env: ownerEnv }
  );
  assert.equal(deadSend.status, 1);
  assert.match(deadSend.stderr, /not a running background task/i);
});

test("session start blocks a live v1.0.6 background job without owned identity", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  upsertJob(repo, {
    id: "legacy-running",
    status: "running",
    sessionId: "legacy-session",
    pid: process.pid,
    worker: null
  });

  const result = run("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "new-session"
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: "new-session",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const response = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(response).sort(), ["continue", "stopReason"]);
  assert.equal(response.continue, false);
  assert.match(
    response.stopReason,
    /v1\.0\.6.*finish or cancel.*before activating/i
  );
});

test("session start cleans a live worker from an ended generation before reuse", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  const sessionId = "sess-restart-recovery";
  const restartedSessionId = "sess-after-recovery";
  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: sessionId
  };
  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "keep running until restart"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const runningJob = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.worker?.token ? job : null;
  }, { timeoutMs: 15000 });
  t.after(() => {
    try {
      forceStopTestWorker(runningJob.worker);
    } catch {
      // Startup recovery already stopped the old worker.
    }
  });
  markSessionEnding(repo, sessionId);

  const restarted = await runAsync("node", [SESSION_HOOK, "SessionStart"], {
    cwd: repo,
    env: {
      ...env,
      CODEX_COMPANION_SESSION_ID: restartedSessionId
    },
    input: JSON.stringify({
      hook_event_name: "SessionStart",
      session_id: restartedSessionId,
      cwd: repo
    })
  });

  assert.equal(restarted.status, 0, restarted.stderr);
  await waitFor(() => {
    try {
      process.kill(runningJob.worker.pid, 0);
      return false;
    } catch {
      return true;
    }
  });
  const state = loadState(repo);
  assert.equal(state.jobs.some((job) => job.id === jobId), false);
  assert.equal(
    state.endedSessions.some((entry) => entry.sessionId === sessionId),
    false
  );
});

test("session cleanup of job A leaves job B steerable in the same workspace", async (t) => {
  const repo = makeTempDir();
  const binDirA = makeTempDir();
  const binDirB = makeTempDir();
  const steeringRoot = makeTempDir();
  installFakeCodex(binDirA, "steerable-slow-task");
  installFakeCodex(binDirB, "steerable-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const envA = {
    ...buildEnv(binDirA),
    CODEX_COMPANION_SESSION_ID: "sess-a",
    CODEX_COMPANION_STEERING_ROOT: steeringRoot
  };
  const envB = {
    ...buildEnv(binDirB),
    CODEX_COMPANION_SESSION_ID: "sess-b",
    CODEX_COMPANION_STEERING_ROOT: steeringRoot
  };
  const launchA = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "session A task"],
    { cwd: repo, env: envA }
  );
  const launchB = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "session B task"],
    { cwd: repo, env: envB }
  );
  assert.equal(launchA.status, 0, launchA.stderr);
  assert.equal(launchB.status, 0, launchB.stderr);
  const jobAId = JSON.parse(launchA.stdout).jobId;
  const jobBId = JSON.parse(launchB.stdout).jobId;
  const active = await waitFor(() => {
    const jobs = loadState(repo).jobs;
    const jobA = jobs.find((candidate) => candidate.id === jobAId);
    const jobB = jobs.find((candidate) => candidate.id === jobBId);
    return jobA?.steering && jobB?.steering ? { jobA, jobB } : null;
  }, { timeoutMs: 15000 });
  t.after(() => {
    for (const job of [active.jobA, active.jobB]) {
      try {
        forceStopTestWorker(job.worker);
      } catch {
        // The task or session cleanup already stopped this worker.
      }
    }
  });

  const endedA = await runAsync("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env: envA,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-a",
      cwd: repo
    })
  });
  assert.equal(endedA.status, 0, endedA.stderr);

  const stateAfterA = loadState(repo);
  assert.equal(stateAfterA.jobs.some((job) => job.id === jobAId), false);
  const jobBAfterA = stateAfterA.jobs.find((job) => job.id === jobBId);
  assert.equal(jobBAfterA.status, "running");
  assert.equal(jobBAfterA.steering.address, active.jobB.steering.address);

  const sentB = run(
    "node",
    [SCRIPT, "send", jobBId, "--json", "only session B should apply this"],
    { cwd: repo, env: envB }
  );
  assert.equal(sentB.status, 0, sentB.stderr);
  const acknowledgementB = JSON.parse(sentB.stdout);
  assert.equal(acknowledgementB.threadId, active.jobB.threadId);
  assert.equal(acknowledgementB.turnId, active.jobB.turnId);

  const completedB = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobBId);
    return job?.status === "completed" ? job : null;
  }, { timeoutMs: 15000 });
  assert.match(
    completedB.result.rawOutput,
    /Steering applied: only session B should apply this/
  );
  if (active.jobA.steering.kind === "unix") {
    assert.equal(fs.existsSync(active.jobA.steering.address), false);
    assert.equal(fs.existsSync(active.jobB.steering.address), false);
  }
});

test("task worker rejects a mismatched launch token before starting Codex", () => {
  const repo = makeTempDir();
  const jobId = "task-token-check";
  upsertJob(repo, {
    id: jobId,
    status: "queued",
    phase: "queued",
    launchToken: "expected-token",
    request: {
      type: "task",
      cwd: repo,
      prompt: "must not run"
    }
  });

  const worker = run(
    "node",
    [
      SCRIPT,
      "task-worker",
      "--cwd",
      repo,
      "--job-id",
      jobId,
      "--worker-token",
      "wrong-token"
    ],
    { cwd: repo }
  );

  assert.equal(worker.status, 1);
  assert.match(worker.stderr, /does not match this worker launch/i);
  const storedJob = loadState(repo).jobs.find((job) => job.id === jobId);
  assert.equal(storedJob?.status, "queued");
  assert.equal(storedJob?.worker, undefined);
});

test("review rejects focus text because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const result = run("node", [SCRIPT, "review", "--scope working-tree focus on auth"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /does not support custom focus text/i);
  assert.match(result.stderr, /\/codex:adversarial-review focus on auth/i);
});

test("review rejects staged-only scope because it is native-review only", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("adversarial review rejects staged-only scope to match review target selection", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");
  run("git", ["add", "README.md"], { cwd: repo });

  const result = run("node", [SCRIPT, "adversarial-review", "--scope", "staged"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status > 0, true);
  assert.match(result.stderr, /Unsupported review scope "staged"/i);
  assert.match(result.stderr, /Use one of: auto, working-tree, branch, or pass --base <ref>/i);
});

test("review --background uses an owned worker and exposes its stored result", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const launched = run("node", [SCRIPT, "review", "--background", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  assert.equal(launchPayload.status, "queued");
  assert.match(launchPayload.jobId, /^review-/);

  const completedJob = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === launchPayload.jobId);
    return job?.status === "completed" ? job : null;
  });
  assert.equal(completedJob.worker, null);

  const result = run("node", [SCRIPT, "result", launchPayload.jobId, "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(result.status, 0, result.stderr);
  const resultPayload = JSON.parse(result.stdout);
  assert.equal(resultPayload.job.status, "completed");
  assert.match(resultPayload.storedJob.rendered, /No material issues found/);
});

test("status shows phases, hints, and the latest finished job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  const logFile = path.join(jobsDir, "review-live.log");
  fs.writeFileSync(
    logFile,
    [
      "[2026-03-18T15:30:00.000Z] Starting Codex Review.",
      "[2026-03-18T15:30:01.000Z] Thread ready (thr_1).",
      "[2026-03-18T15:30:02.000Z] Turn started (turn_1).",
      "[2026-03-18T15:30:03.000Z] Reviewer started: current changes"
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 }
  );

  const finishedJobFile = path.join(jobsDir, "review-done.json");
  fs.writeFileSync(
    finishedJobFile,
    JSON.stringify(
      {
        id: "review-done",
        status: "completed",
        title: "Codex Review",
        rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n"
      },
      null,
      2
    ),
    { encoding: "utf8", mode: 0o600 }
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-live",
            kind: "review",
            kindLabel: "review",
            ...activeLauncherFields(),
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_1",
            summary: "Review working tree diff",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:03.000Z"
          },
          {
            id: "review-done",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_done",
            summary: "Review main...HEAD",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Active jobs:/);
  assert.match(result.stdout, /\| Job \| Kind \| Status \| Phase \| Elapsed \| Codex Session ID \| Summary \| Actions \|/);
  assert.match(result.stdout, /\| review-live \| review \| queued \| reviewing \| .* \| thr_1 \| Review working tree diff \|/);
  assert.match(result.stdout, /`\/codex:status review-live`/);
  assert.doesNotMatch(result.stdout, /`\/codex:cancel review-live`/);
  assert.match(result.stdout, /Live details:/);
  assert.match(result.stdout, /Latest finished:/);
  assert.match(result.stdout, /Progress:/);
  assert.match(result.stdout, /Session runtime: direct process per invocation/);
  assert.match(result.stdout, /Phase: reviewing/);
  assert.match(result.stdout, /Codex session ID: thr_1/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_1/);
  assert.match(result.stdout, /Thread ready \(thr_1\)\./);
  assert.match(result.stdout, /Reviewer started: current changes/);
  assert.match(result.stdout, /Duration: 1m 5s/);
  assert.match(result.stdout, /Codex session ID: thr_done/);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_done/);
});

test("status without a job id only shows jobs from the current Claude session", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  const currentLog = path.join(jobsDir, "review-current.log");
  const otherLog = path.join(jobsDir, "review-other.log");
  fs.writeFileSync(currentLog, "[2026-03-18T15:30:00.000Z] Reviewer started: current changes\n", { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(otherLog, "[2026-03-18T15:31:00.000Z] Reviewer started: old changes\n", { encoding: "utf8", mode: 0o600 });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            kind: "review",
            kindLabel: "review",
            ...activeLauncherFields(),
            title: "Codex Review",
            jobClass: "review",
            phase: "reviewing",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            logFile: currentLog,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-other",
            kind: "review",
            kindLabel: "review",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Previous session review",
            createdAt: "2026-03-18T15:20:00.000Z",
            startedAt: "2026-03-18T15:20:05.000Z",
            completedAt: "2026-03-18T15:21:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    [...new Set(result.stdout.match(/review-(?:current|other)/g) ?? [])],
    ["review-current"]
  );
});

test("targeted status, wait, and result serve a job id held by any session and reconcile it first", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  const deadLauncher = {
    pid: 2147483647,
    startKey: "missing-launcher"
  };
  upsertJob(workspace, {
    id: "task-current-dead",
    status: "queued",
    jobClass: "task",
    sessionId: "sess-current",
    launchToken: "launch-current",
    launcher: deadLauncher
  });
  upsertJob(workspace, {
    id: "task-foreign-dead",
    status: "queued",
    jobClass: "task",
    sessionId: "sess-foreign",
    launchToken: "launch-foreign",
    launcher: deadLauncher
  });
  upsertJob(workspace, {
    id: "task-foreign-wait",
    status: "queued",
    jobClass: "task",
    sessionId: "sess-foreign",
    launchToken: "launch-foreign-wait",
    launcher: deadLauncher
  });
  upsertJob(workspace, {
    id: "task-foreign-result",
    status: "completed",
    jobClass: "task",
    sessionId: "sess-foreign",
    rendered: "FOREIGN_RESULT_READ_BY_JOB_ID",
    result: {
      codex: {
        stdout: "FOREIGN_RESULT_READ_BY_JOB_ID"
      }
    }
  });
  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  const currentStatus = run(
    "node",
    [SCRIPT, "status", "task-current-dead", "--json"],
    { cwd: workspace, env }
  );
  assert.equal(currentStatus.status, 0, currentStatus.stderr);
  assert.equal(JSON.parse(currentStatus.stdout).job.status, "failed");
  assert.equal(
    loadState(workspace).jobs.find((job) => job.id === "task-foreign-dead")
      .status,
    "queued"
  );

  const detachedEnv = { ...process.env };
  delete detachedEnv.CODEX_COMPANION_SESSION_ID;
  const restartedEnv = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-restarted"
  };

  for (const [caller, callerEnv] of [
    ["without any session id", detachedEnv],
    ["from a restarted session", restartedEnv]
  ]) {
    const foreignStatus = run(
      "node",
      [SCRIPT, "status", "task-foreign-dead", "--json"],
      { cwd: workspace, env: callerEnv }
    );
    assert.equal(foreignStatus.status, 0, `status ${caller}: ${foreignStatus.stderr}`);
    assert.equal(JSON.parse(foreignStatus.stdout).job.status, "failed");

    const foreignWait = run(
      "node",
      [SCRIPT, "status", "task-foreign-wait", "--wait", "--timeout-ms", "25", "--json"],
      { cwd: workspace, env: callerEnv }
    );
    assert.equal(foreignWait.status, 0, `wait ${caller}: ${foreignWait.stderr}`);
    const waited = JSON.parse(foreignWait.stdout);
    assert.equal(waited.job.status, "failed");
    assert.equal(waited.waitTimedOut, false);

    const foreignResult = run(
      "node",
      [SCRIPT, "result", "task-foreign-result", "--json"],
      { cwd: workspace, env: callerEnv }
    );
    assert.equal(foreignResult.status, 0, `result ${caller}: ${foreignResult.stderr}`);
    assert.equal(
      JSON.parse(foreignResult.stdout).job.result.codex.stdout,
      "FOREIGN_RESULT_READ_BY_JOB_ID"
    );
  }
});

test("status, result, send, and cancel refuse an omitted or unknown job reference", () => {
  const workspace = makeTempDir();
  initGitRepo(workspace);
  upsertJob(workspace, {
    id: "job-visible-done",
    status: "completed",
    jobClass: "review",
    sessionId: "sess-current",
    rendered: "IMPLICIT_RESOLUTION_MUST_NOT_HAPPEN",
    result: {
      codex: {
        stdout: "IMPLICIT_RESOLUTION_MUST_NOT_HAPPEN"
      }
    }
  });
  upsertJob(workspace, {
    id: "job-visible-active",
    ...activeLauncherFields(),
    jobClass: "task",
    sessionId: "sess-current"
  });
  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };

  for (const args of [
    ["status", "--wait", "--timeout-ms", "25", "--json"],
    ["result", "--json"],
    ["cancel", "--json"],
    ["send", "--json"]
  ]) {
    const refused = run("node", [SCRIPT, ...args], { cwd: workspace, env });
    assert.equal(refused.status, 1, `${args[0]} resolved an omitted job reference`);
    assert.match(
      refused.stderr,
      /An explicit job id is required\.|requires a job id|requires an explicit background job id/
    );
    assert.doesNotMatch(
      `${refused.stdout}\n${refused.stderr}`,
      /IMPLICIT_RESOLUTION_MUST_NOT_HAPPEN/
    );
  }

  for (const args of [
    ["status", "job-unknown", "--json"],
    ["result", "job-unknown", "--json"],
    ["cancel", "job-unknown", "--json"],
    ["send", "job-unknown", "--json", "instruction"]
  ]) {
    const refused = run("node", [SCRIPT, ...args], { cwd: workspace, env });
    assert.equal(refused.status, 1, `${args[0]} accepted an unknown job id`);
    assert.match(
      refused.stderr,
      /No job found for "job-unknown"|No stored job found for job-unknown/
    );
  }

  assert.deepEqual(
    loadState(workspace).jobs.map((job) => [job.id, job.status]).sort(),
    [
      ["job-visible-active", "queued"],
      ["job-visible-done", "completed"]
    ]
  );
});

test("status preserves adversarial review kind labels", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  const logFile = path.join(jobsDir, "review-adv-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Reviewer started: adversarial review\n", { encoding: "utf8", mode: 0o600 });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-adv-live",
            kind: "adversarial-review",
            ...activeLauncherFields(),
            title: "Codex Adversarial Review",
            jobClass: "review",
            phase: "reviewing",
            threadId: "thr_adv_live",
            summary: "Adversarial review current changes",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            updatedAt: "2026-03-18T15:30:00.000Z"
          },
          {
            id: "review-adv",
            kind: "adversarial-review",
            status: "completed",
            title: "Codex Adversarial Review",
            jobClass: "review",
            threadId: "thr_adv_done",
            summary: "Adversarial review working tree diff",
            createdAt: "2026-03-18T15:10:00.000Z",
            startedAt: "2026-03-18T15:10:05.000Z",
            completedAt: "2026-03-18T15:11:10.000Z",
            updatedAt: "2026-03-18T15:11:10.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const result = run("node", [SCRIPT, "status"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| review-adv-live \| adversarial-review \| queued \| reviewing \|/);
  assert.match(result.stdout, /- review-adv \| completed \| adversarial-review \| Codex Adversarial Review/);
  assert.match(result.stdout, /Codex session ID: thr_adv_live/);
  assert.match(result.stdout, /Codex session ID: thr_adv_done/);
});

test("status --wait times out cleanly when a job is still active", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  const logFile = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(
    path.join(jobsDir, "task-live.json"),
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    { encoding: "utf8", mode: 0o600 }
  );

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            ...activeLauncherFields(),
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const result = run("node", [SCRIPT, "status", "task-live", "--wait", "--timeout-ms", "25", "--json"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.job.id, "task-live");
  assert.equal(payload.job.status, "queued");
  assert.equal(payload.waitTimedOut, true);
});

test("status rejects a wait deadline longer than its host hook budget", () => {
  const workspace = makeTempDir();
  const result = run(
    "node",
    [
      SCRIPT,
      "status",
      "task-live",
      "--wait",
      "--timeout-ms",
      "780001",
      "--json"
    ],
    { cwd: workspace }
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--timeout-ms must be an integer from 1 to 780000/i);
});

test("result returns the stored output for an explicit job id", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-finished",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            threadId: "thr_review_finished",
            summary: "Review working tree diff",
            rendered: "# Codex Review\n\nReviewed uncommitted changes.\nNo material issues found.\n",
            result: {
              codex: {
                stdout: "Reviewed uncommitted changes.\nNo material issues found."
              }
            },
            createdAt: "2026-03-18T15:00:00.000Z",
            updatedAt: "2026-03-18T15:01:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const result = run("node", [SCRIPT, "result", "review-finished"], {
    cwd: workspace
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    "Reviewed uncommitted changes.\nNo material issues found.\n\nCodex session ID: thr_review_finished\nResume in Codex: codex resume thr_review_finished\n"
  );

  const implicit = run("node", [SCRIPT, "result"], {
    cwd: workspace
  });

  assert.equal(implicit.status, 1);
  assert.match(implicit.stderr, /An explicit job id is required\./);
  assert.doesNotMatch(implicit.stdout, /No material issues found/);
});

test("result without a job id lists the session-visible jobs instead of resolving one", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "review-current",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-current",
            threadId: "thr_current",
            summary: "Current session review",
            result: {
              codex: {
                stdout: "Current session output."
              }
            },
            createdAt: "2026-03-18T15:10:00.000Z",
            updatedAt: "2026-03-18T15:11:00.000Z"
          },
          {
            id: "review-other",
            status: "completed",
            title: "Codex Review",
            jobClass: "review",
            sessionId: "sess-other",
            threadId: "thr_other",
            summary: "Old session review",
            result: {
              codex: {
                stdout: "Old session output."
              }
            },
            createdAt: "2026-03-18T15:20:00.000Z",
            updatedAt: "2026-03-18T15:21:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const result = run("node", [SCRIPT, "result"], {
    cwd: workspace,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    }
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /An explicit job id is required\./);
  assert.match(result.stderr, /Visible jobs: review-current \(completed\)\./);
  assert.doesNotMatch(result.stderr, /review-other/);
  assert.equal(result.stdout, "");
});

test("result for a finished write-capable task returns the raw Codex final response", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const taskRun = run("node", [SCRIPT, "task", "--write", "fix the flaky integration test"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskRun.status, 0, taskRun.stderr);

  const [taskJob] = loadState(repo).jobs;
  const result = run("node", [SCRIPT, "result", taskJob.id], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Handled the requested task\.\nTask prompt accepted\.\n/);
  assert.match(result.stdout, /Codex session ID: thr_[a-z0-9]+/i);
  assert.match(result.stdout, /Resume in Codex: codex resume thr_[a-z0-9]+/i);
});

test("cancel refuses a running process that is not an owned worker", async (t) => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: workspace,
    detached: true,
    stdio: "ignore"
  });
  sleeper.unref();

  t.after(() => {
    try {
      if (process.platform === "win32") {
        run("taskkill", ["/PID", String(sleeper.pid), "/T", "/F"]);
      } else {
        process.kill(-sleeper.pid, "SIGTERM");
      }
    } catch {
      // Ignore missing process.
    }
  });

  const logFile = path.join(jobsDir, "task-live.log");
  const jobFile = path.join(jobsDir, "task-live.json");
  fs.writeFileSync(logFile, "[2026-03-18T15:30:00.000Z] Starting Codex Task.\n", { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(
    jobFile,
    JSON.stringify(
      {
        id: "task-live",
        status: "running",
        title: "Codex Task",
        logFile
      },
      null,
      2
    ),
    { encoding: "utf8", mode: 0o600 }
  );
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-live",
            ...activeLauncherFields(),
            title: "Codex Task",
            jobClass: "task",
            summary: "Investigate flaky test",
            pid: sleeper.pid,
            logFile,
            createdAt: "2026-03-18T15:30:00.000Z",
            startedAt: "2026-03-18T15:30:01.000Z",
            updatedAt: "2026-03-18T15:30:02.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const cancelResult = await runAsync("node", [SCRIPT, "cancel", "task-live", "--json"], {
    cwd: workspace
  });

  assert.equal(cancelResult.status, 1);
  assert.match(cancelResult.stderr, /not an owned background worker/i);
  process.kill(sleeper.pid, 0);

  const state = loadState(workspace);
  assert.equal(state.jobs[0].status, "queued");
  const stored = JSON.parse(fs.readFileSync(jobFile, "utf8"));
  assert.equal(stored.status, "running");
  assert.doesNotMatch(fs.readFileSync(logFile, "utf8"), /Cancelled by user/);
});

test("cancel without a job id fails closed instead of picking an active job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            ...activeLauncherFields(),
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const status = run("node", [SCRIPT, "status", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).running, []);

  const cancel = run("node", [SCRIPT, "cancel", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /An explicit job id is required\./);
  assert.match(cancel.stderr, /No job is visible for this Claude session\./);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "queued");
});

test("cancel with a job id reaches another session job", () => {
  const workspace = makeTempDir();
  const stateDir = resolveStateDir(workspace);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  const logFile = path.join(jobsDir, "task-other.log");
  fs.writeFileSync(logFile, "", { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: { stopReviewGate: false },
        jobs: [
          {
            id: "task-other",
            ...activeLauncherFields(),
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-other",
            summary: "Other session run",
            updatedAt: "2026-03-24T20:05:00.000Z",
            logFile
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const cancel = run("node", [SCRIPT, "cancel", "task-other", "--json"], {
    cwd: workspace,
    env
  });
  assert.equal(cancel.status, 1);
  assert.match(cancel.stderr, /not an owned background worker/i);
  assert.doesNotMatch(cancel.stderr, /No job found/i);

  const state = JSON.parse(fs.readFileSync(path.join(stateDir, "state.json"), "utf8"));
  assert.equal(state.jobs[0].status, "queued");
});

test("cancel with an explicit id stops another session's owned worker", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  const otherSessionEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-other"
  };
  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "keep running"],
    { cwd: repo, env: otherSessionEnv }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const running = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.worker ? job : null;
  }, { timeoutMs: 15000 });
  t.after(() => {
    try {
      forceStopTestWorker(running.worker);
    } catch {
      // The worker already stopped.
    }
  });

  const restartedSessionEnv = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-restarted"
  };
  const cancelled = run(
    "node",
    [SCRIPT, "cancel", jobId, "--json"],
    { cwd: repo, env: restartedSessionEnv }
  );

  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");
  assert.equal(loadState(repo).jobs.find((job) => job.id === jobId).status, "cancelled");
  await waitFor(() => {
    try {
      process.kill(running.worker.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });
});

test("background task owns a direct app-server and cancellation stops its process tree", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "investigate the flaky worker timeout"], {
    cwd: repo,
    env
  });

  assert.equal(launched.status, 0, launched.stderr);
  const launchPayload = JSON.parse(launched.stdout);
  const jobId = launchPayload.jobId;
  assert.ok(jobId);

  const runningJob = await waitFor(() => {
    const state = loadState(repo);
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    if (job?.status === "running" && job.threadId && job.turnId) {
      return job;
    }
    return null;
  }, { timeoutMs: 15000 });

  const cancelResult = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });

  assert.equal(cancelResult.status, 0, cancelResult.stderr);
  const cancelPayload = JSON.parse(cancelResult.stdout);
  assert.equal(cancelPayload.status, "cancelled");
  assert.equal(cancelPayload.workerTerminated, true);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.lastInterrupt, null);
  await waitFor(() => {
    try {
      process.kill(runningJob.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });
});

test("cancellation keeps the task worker anchor until a TERM-resistant app-server is killed", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "term-resistant-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "keep the resistant child alive"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const runningJob = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.turnId && job.worker?.token ? job : null;
  }, { timeoutMs: 15000 });

  t.after(() => {
    try {
      forceStopTestWorker(runningJob.worker);
    } catch {
      // Cancellation already stopped the owned worker tree.
    }
  });

  const cancelled = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });
  assert.equal(cancelled.status, 0, cancelled.stderr);
  assert.equal(JSON.parse(cancelled.stdout).status, "cancelled");

  await waitFor(() => {
    try {
      process.kill(runningJob.worker.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });
});

test("background task fails closed when its direct app-server cannot initialize", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "app-server-initialize-exits");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--json", "prove direct startup failure"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  const failedJob = await waitFor(() => {
    const state = loadState(repo);
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "failed" ? job : null;
  }, { timeoutMs: 8000 });

  assert.match(failedJob.errorMessage, /app-server.*exited|connection closed/i);
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 1);
});

test("early cancellation stops the direct app-server before turn-start can continue", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "delayed-turn-start");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = buildEnv(binDir);
  const launched = run("node", [SCRIPT, "task", "--background", "--write", "--json", "start slowly"], {
    cwd: repo,
    env
  });
  assert.equal(launched.status, 0, launched.stderr);
  const jobId = JSON.parse(launched.stdout).jobId;
  await waitFor(() => {
    const state = loadState(repo);
    const job = state.jobs.find((candidate) => candidate.id === jobId);
    return job?.status === "running" && job.threadId && !job.turnId;
  }, { timeoutMs: 15000 });

  const cancelled = run("node", [SCRIPT, "cancel", jobId, "--json"], {
    cwd: repo,
    env
  });
  assert.equal(cancelled.status, 0, cancelled.stderr);

  await new Promise((resolve) => setTimeout(resolve, 800));
  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.delayedTurnStartContinued, false);
});

test("session end fully cleans up jobs for the ending session", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "interruptible-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-current"
  };
  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "keep running until session cleanup"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 0, launched.stderr);
  const runningJobId = JSON.parse(launched.stdout).jobId;
  const runningJob = await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === runningJobId);
    return job?.status === "running" && job.worker?.token ? job : null;
  });

  t.after(() => {
    try {
      forceStopTestWorker(runningJob.worker);
    } catch {
      // The session hook already stopped the owned worker tree.
    }
  });

  const completedLog = resolveJobLogFile(repo, "review-completed");
  const otherSessionLog = resolveJobLogFile(repo, "review-other");
  fs.writeFileSync(completedLog, "completed\n", { encoding: "utf8", mode: 0o600 });
  fs.writeFileSync(otherSessionLog, "other\n", { encoding: "utf8", mode: 0o600 });
  upsertJob(repo, {
    id: "review-completed",
    status: "completed",
    title: "Codex Review",
    sessionId: "sess-current",
    logFile: completedLog,
    createdAt: "2026-03-18T15:30:00.000Z",
    updatedAt: "2026-03-18T15:31:00.000Z"
  });
  upsertJob(repo, {
    id: "review-other",
    status: "completed",
    title: "Codex Review",
    sessionId: "sess-other",
    logFile: otherSessionLog,
    createdAt: "2026-03-18T15:34:00.000Z",
    updatedAt: "2026-03-18T15:35:00.000Z"
  });
  assert.deepEqual(
    loadState(repo).jobs.map((job) => [job.id, job.sessionId]).sort(),
    [
      ["review-completed", "sess-current"],
      ["review-other", "sess-other"],
      [runningJobId, "sess-current"]
    ].sort()
  );

  const result = await runAsync("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-current",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(otherSessionLog), true);

  await waitFor(() => {
    try {
      process.kill(runningJob.worker.pid, 0);
      return false;
    } catch (error) {
      return error?.code === "ESRCH";
    }
  });

  const state = loadState(repo);
  assert.deepEqual(state.jobs.map((job) => job.id), ["review-other"]);
  const otherJob = state.jobs[0];
  assert.equal(otherJob.logFile, otherSessionLog);
});

test("session end removes an unclaimed queued manifest from the ending session", async () => {
  const repo = makeTempDir();
  const env = {
    ...process.env,
    CODEX_COMPANION_SESSION_ID: "sess-unclaimed"
  };
  upsertJob(repo, {
    id: "task-unclaimed",
    status: "queued",
    sessionId: "sess-unclaimed",
    launchToken: "launch-unclaimed",
    worker: null
  });

  const result = await runAsync("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-unclaimed",
      cwd: repo
    })
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(loadState(repo).jobs.some((job) => job.id === "task-unclaimed"), false);
});

test("session end rejects arrays and invalid field types without writing a tombstone", async (t) => {
  const cases = [
    ["array input", []],
    ["invalid cwd", { cwd: 42 }],
    ["invalid session id", { session_id: null }],
    ["invalid transcript path", { transcript_path: [] }],
    ["invalid event name", { hook_event_name: {} }]
  ];

  for (const [name, invalidInput] of cases) {
    await t.test(name, () => {
      const repo = makeTempDir();
      const input = Array.isArray(invalidInput)
        ? invalidInput
        : {
            hook_event_name: "SessionEnd",
            session_id: "sess-invalid",
            cwd: repo,
            ...invalidInput
          };
      const result = run(process.execPath, [SESSION_HOOK, "SessionEnd"], {
        cwd: repo,
        input: JSON.stringify(input)
      });

      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /must be a JSON object|must be a string/i);
      assert.deepEqual(loadState(repo).endedSessions, []);
    });
  }
});

test("session end records its tombstone and exits within the host budget while the state lock is held", async () => {
  const repo = makeTempDir();
  const barrierDir = makeTempDir();
  const enteredFile = path.join(barrierDir, "entered");
  const releaseFile = path.join(barrierDir, "release");
  const sessionId = "sess-host-budget";
  upsertJob(repo, {
    id: "task-host-budget",
    status: "completed",
    sessionId
  });
  const stateModuleUrl = new URL(
    "../plugins/codex/scripts/lib/state.mjs",
    import.meta.url
  ).href;
  const lockOwner = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
        import fs from "node:fs";
        import { withStateTransaction } from ${JSON.stringify(stateModuleUrl)};
        const sleep = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        withStateTransaction(process.env.TEST_WORKSPACE, () => {
          fs.writeFileSync(process.env.TEST_ENTERED, "entered");
          while (!fs.existsSync(process.env.TEST_RELEASE)) sleep();
        });
      `
    ],
    {
      env: {
        ...process.env,
        TEST_WORKSPACE: repo,
        TEST_ENTERED: enteredFile,
        TEST_RELEASE: releaseFile
      },
      stdio: "ignore"
    }
  );

  try {
    await waitFor(() => fs.existsSync(enteredFile));
    const startedAt = Date.now();
    const result = await runAsync("node", [SESSION_HOOK, "SessionEnd"], {
      cwd: repo,
      env: {
        ...process.env,
        CODEX_COMPANION_SESSION_ID: sessionId
      },
      timeoutMs: 1450,
      input: JSON.stringify({
        hook_event_name: "SessionEnd",
        session_id: sessionId,
        cwd: repo
      })
    });
    const elapsedMs = Date.now() - startedAt;

    assert.equal(result.timedOut, false, result.stderr);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(elapsedMs < 1450, `SessionEnd took ${elapsedMs} ms`);
    assert.equal(
      loadState(repo).endedSessions.some((entry) => entry.sessionId === sessionId),
      true
    );
  } finally {
    fs.writeFileSync(releaseFile, "release");
    await new Promise((resolve, reject) => {
      lockOwner.once("error", reject);
      lockOwner.once("close", resolve);
    });
  }
});

test("session end rejects a background job published after the final scan", async () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-ended-before-launch"
  };

  const ended = await runAsync("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-ended-before-launch",
      cwd: repo
    })
  });
  assert.equal(ended.status, 0, ended.stderr);

  const launched = run(
    "node",
    [SCRIPT, "task", "--background", "--json", "must not start"],
    { cwd: repo, env }
  );
  assert.equal(launched.status, 1);
  assert.match(launched.stderr, /session has ended/i);
  assert.equal(loadState(repo).jobs.length, 0);
  assert.deepEqual(
    fs
      .readdirSync(path.join(resolveStateDir(repo), "jobs"))
      .filter((entry) => entry.endsWith(".log")),
    []
  );
});

// The shutdown window is budget-bounded by design (FORK_MAINTENANCE invariants 12 and 18), so a
// partial drain is contractual: see the vault task 2026-07-24-flakes-integration-codex-plugin-cc.
test("session end drains resistant workers within its bounded shutdown window without losing a job", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "term-resistant-slow-task");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-many"
  };
  const runningJobs = [];
  for (const prompt of [
    "worker one",
    "worker two",
    "worker three",
    "worker four",
    "worker five"
  ]) {
    const launched = run(
      "node",
      [SCRIPT, "task", "--background", "--json", prompt],
      { cwd: repo, env }
    );
    assert.equal(launched.status, 0, launched.stderr);
    const jobId = JSON.parse(launched.stdout).jobId;
    const runningJob = await waitFor(() => {
      const job = loadState(repo).jobs.find((candidate) => candidate.id === jobId);
      return job?.status === "running" && job.turnId && job.worker?.token ? job : null;
    }, { timeoutMs: 15000 });
    runningJobs.push(runningJob);
  }
  t.after(() => {
    for (const job of runningJobs) {
      try {
        forceStopTestWorker(job.worker);
      } catch {
        // Session cleanup already stopped the owned worker tree.
      }
    }
  });

  const result = await runAsync("node", [SESSION_HOOK, "SessionEnd"], {
    cwd: repo,
    env,
    timeoutMs: 4500,
    input: JSON.stringify({
      hook_event_name: "SessionEnd",
      session_id: "sess-many",
      cwd: repo
    })
  });

  assert.equal(result.timedOut, false);
  assert.equal(result.status, 0, result.stderr);
  // Sabotaging the drain itself is covered by "session end fully cleans up jobs for the
  // ending session" and "cancellation keeps the task worker anchor until a TERM-resistant
  // app-server is killed"; this asserts the effect SessionEnd owns deterministically.
  assert.equal(
    loadState(repo).endedSessions.some((entry) => entry.sessionId === "sess-many"),
    true
  );

  const remaining = loadState(repo).jobs.filter(
    (job) => job.sessionId === "sess-many"
  );
  const drained = runningJobs.filter(
    (job) => !remaining.some((candidate) => candidate.id === job.id)
  );

  for (const job of drained) {
    assert.equal(
      inspectOwnedWorker(job.worker).status,
      "gone",
      `drained job ${job.id} left its worker alive`
    );
  }

  for (const job of remaining) {
    if (job.status === "running") {
      assert.ok(
        job.worker?.token,
        `running job ${job.id} lost the worker identity it needs to be reconciled`
      );
    }
  }

  for (const job of remaining) {
    if (job.worker) {
      try {
        forceStopTestWorker(job.worker);
      } catch {
        // The worker already died inside the shutdown window.
      }
    }
  }

  for (const job of remaining) {
    if (job.worker) {
      await waitFor(() => inspectOwnedWorker(job.worker).status === "gone");
    }
    const reconciled = run("node", [SCRIPT, "status", job.id, "--json"], {
      cwd: repo,
      env
    });
    assert.equal(reconciled.status, 0, reconciled.stderr);
    const reconciledStatus = JSON.parse(reconciled.stdout).job.status;
    assert.ok(
      reconciledStatus === "failed" || reconciledStatus === "completed",
      `job ${job.id} stayed ${reconciledStatus} after its worker died`
    );
  }

  assert.equal(
    loadState(repo).jobs.some(
      (job) => job.sessionId === "sess-many" && job.status === "running"
    ),
    false
  );
});

test("stop hook runs a stop-time review task and blocks on findings when the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);
  const setupPayload = JSON.parse(setup.stdout);
  assert.equal(setupPayload.reviewGateEnabled, true);

  const taskResult = run("node", [SCRIPT, "task", "--write", "fix the issue"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(taskResult.status, 0, taskResult.stderr);

  const longAssistantMessage =
    "I completed the refactor and updated the retry logic.\n" +
    "x".repeat(40_000) +
    "\nEND-OF-LONG-RESPONSE";
  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({
      cwd: repo,
      session_id: "sess-stop-review",
      last_assistant_message: longAssistantMessage
    })
  });
  assert.equal(blocked.status, 0, blocked.stderr);
  const blockedPayload = JSON.parse(blocked.stdout);
  assert.equal(blockedPayload.decision, "block");
  assert.match(blockedPayload.reason, /Codex stop-time review found issues that still need fixes/i);
  assert.match(blockedPayload.reason, /Missing empty-state guard/i);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.match(fakeState.lastTurnStart.prompt, /<task>/i);
  assert.match(fakeState.lastTurnStart.prompt, /<compact_output_contract>/i);
  assert.match(fakeState.lastTurnStart.prompt, /Only review the work from the previous Claude turn/i);
  assert.match(fakeState.lastTurnStart.prompt, /I completed the refactor and updated the retry logic\./);
  assert.match(fakeState.lastTurnStart.prompt, /END-OF-LONG-RESPONSE/);

  const status = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: {
      ...buildEnv(binDir),
      CODEX_COMPANION_SESSION_ID: "sess-stop-review"
    }
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Codex Stop Gate Review/);
});

test("stop-gate singleton reuses an identical prompt but starts a new job for a different response", async (t) => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const steeringRoot = makeTempDir();
  installFakeCodex(binDir, "steerable-slow-task");
  initGitRepo(repo);

  const env = {
    ...buildEnv(binDir),
    CODEX_COMPANION_SESSION_ID: "sess-stop-singleton",
    CODEX_COMPANION_STEERING_ROOT: steeringRoot
  };
  const firstPrompt = [
    "Run a stop-gate review of the previous Claude turn.",
    "Previous Claude response:",
    "First response"
  ].join("\n");
  const secondPrompt = [
    "Run a stop-gate review of the previous Claude turn.",
    "Previous Claude response:",
    "Revised response"
  ].join("\n");

  t.after(() => {
    for (const job of loadState(repo).jobs) {
      if (job.worker) {
        try {
          forceStopTestWorker(job.worker);
        } catch {
          // The background worker already finished.
        }
      }
    }
  });

  const first = run(
    "node",
    [SCRIPT, "task", "--background", "--json", firstPrompt],
    { cwd: repo, env }
  );
  assert.equal(first.status, 0, first.stderr);
  const firstJobId = JSON.parse(first.stdout).jobId;
  await waitFor(() => {
    const job = loadState(repo).jobs.find((candidate) => candidate.id === firstJobId);
    return job?.status === "running" ? job : null;
  }, { timeoutMs: 15000 });

  const identical = run(
    "node",
    [SCRIPT, "task", "--background", "--json", firstPrompt],
    { cwd: repo, env }
  );
  assert.equal(identical.status, 0, identical.stderr);
  assert.equal(JSON.parse(identical.stdout).jobId, firstJobId);

  const revised = run(
    "node",
    [SCRIPT, "task", "--background", "--json", secondPrompt],
    { cwd: repo, env }
  );
  assert.equal(revised.status, 0, revised.stderr);
  const revisedJobId = JSON.parse(revised.stdout).jobId;
  assert.notEqual(revisedJobId, firstJobId);

  const stopJobs = loadState(repo).jobs.filter(
    (job) => job.title === "Codex Stop Gate Review"
  );
  assert.equal(stopJobs.length, 2);
  assert.notEqual(stopJobs[0].singletonKey, stopJobs[1].singletonKey);
});

test("stop hook logs running tasks to stderr without blocking when the review gate is disabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const stateDir = resolveStateDir(repo);
  const jobsDir = path.join(stateDir, "jobs");
  fs.mkdirSync(jobsDir, { recursive: true, mode: 0o700 });

  const runningLog = path.join(jobsDir, "task-live.log");
  fs.writeFileSync(runningLog, "running\n", { encoding: "utf8", mode: 0o600 });

  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify(
      {
        version: 1,
        config: {
          stopReviewGate: false
        },
        jobs: [
          {
            id: "task-live",
            ...activeLauncherFields(),
            title: "Codex Task",
            jobClass: "task",
            sessionId: "sess-current",
            logFile: runningLog,
            createdAt: "2026-03-18T15:32:00.000Z",
            updatedAt: "2026-03-18T15:33:00.000Z"
          }
        ]
      },
      null,
      2
    )}\n`,
    { encoding: "utf8", mode: 0o600 }
  );

  const blocked = run("node", [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      CODEX_COMPANION_SESSION_ID: "sess-current"
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stdout.trim(), "");
  assert.match(blocked.stderr, /Codex task task-live is still launching/i);
  assert.match(blocked.stderr, /\/codex:status/i);
  assert.match(blocked.stderr, /launching/i);
  assert.doesNotMatch(blocked.stderr, /\/codex:cancel task-live/i);
});

test("stop hook allows the stop when the review gate is enabled and the stop-time review task is clean", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "adversarial-clean");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo, session_id: "sess-stop-clean" })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(allowed.stdout.trim(), "");
});

test("stop hook blocks with the setup error when Codex is unavailable and the review gate is enabled", () => {
  const repo = makeTempDir();
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo
  });
  assert.equal(setup.status, 0, setup.stderr);

  const blocked = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: {
      ...process.env,
      PATH: ""
    },
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  const payload = JSON.parse(blocked.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Codex is not set up for the review gate/i);
  assert.match(payload.reason, /Run \/codex:setup/i);
});

test("stop hook fails closed when its input is malformed", () => {
  const repo = makeTempDir();
  const blocked = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    input: "["
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  assert.equal(blocked.stderr, "");
  const payload = JSON.parse(blocked.stdout);
  assert.deepEqual(Object.keys(payload).sort(), ["decision", "reason"]);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /review gate failed unexpectedly/i);
});

test("stop hook fails closed on arrays and invalid field types", async (t) => {
  const cases = [
    ["array input", []],
    ["invalid cwd", { cwd: 42 }],
    ["invalid session id", { session_id: null }],
    ["invalid assistant message", { last_assistant_message: [] }]
  ];

  for (const [name, input] of cases) {
    await t.test(name, () => {
      const repo = makeTempDir();
      const blocked = run(process.execPath, [STOP_HOOK], {
        cwd: repo,
        input: JSON.stringify(input)
      });

      assert.equal(blocked.status, 0, blocked.stderr);
      assert.equal(blocked.stderr, "");
      const payload = JSON.parse(blocked.stdout);
      assert.deepEqual(Object.keys(payload).sort(), ["decision", "reason"]);
      assert.equal(payload.decision, "block");
      assert.match(payload.reason, /review gate failed unexpectedly/i);
    });
  }
});

test("stop hook blocks with the compatibility error when Codex is incompatible and the review gate is enabled", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "old-codex");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run(process.execPath, [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const blocked = run(process.execPath, [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(blocked.status, 0, blocked.stderr);
  const payload = JSON.parse(blocked.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Codex is not set up for the review gate/i);
  assert.match(payload.reason, /0\.145\.0 or later is required/i);
  assert.match(payload.reason, /Run \/codex:setup/i);
});

test("stop hook runs the actual task when auth status looks stale", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "refreshable-auth");
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });

  const setup = run("node", [SCRIPT, "setup", "--enable-review-gate", "--json"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(setup.status, 0, setup.stderr);

  const allowed = run("node", [STOP_HOOK], {
    cwd: repo,
    env: buildEnv(binDir),
    input: JSON.stringify({ cwd: repo })
  });

  assert.equal(allowed.status, 0, allowed.stderr);
  assert.doesNotMatch(allowed.stderr, /Codex is not set up for the review gate/i);
  const payload = JSON.parse(allowed.stdout);
  assert.equal(payload.decision, "block");
  assert.match(payload.reason, /Missing empty-state guard/i);
});

test("commands each own and close their direct app-server", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const adversarial = run("node", [SCRIPT, "adversarial-review"], {
    cwd: repo,
    env
  });
  assert.equal(adversarial.status, 0, adversarial.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 2);
});

test("setup owns a fresh direct app-server after a review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  const fakeStatePath = path.join(binDir, "fake-codex-state.json");

  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const env = buildEnv(binDir);

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env
  });
  assert.equal(review.status, 0, review.stderr);

  const setup = run("node", [SCRIPT, "setup", "--json"], {
    cwd: repo,
    env
  });
  assert.equal(setup.status, 0, setup.stderr);

  const fakeState = JSON.parse(fs.readFileSync(fakeStatePath, "utf8"));
  assert.equal(fakeState.appServerStarts, 2);
});

test("status reports direct runtime after a review", () => {
  const repo = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir);
  initGitRepo(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "hello\n");
  run("git", ["add", "README.md"], { cwd: repo });
  run("git", ["commit", "-m", "init"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "hello again\n");

  const review = run("node", [SCRIPT, "review"], {
    cwd: repo,
    env: buildEnv(binDir)
  });
  assert.equal(review.status, 0, review.stderr);

  const result = run("node", [SCRIPT, "status"], {
    cwd: repo,
    env: buildEnv(binDir)
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Session runtime: direct process per invocation/);
});

test("setup and status report direct runtime when invoked with --cwd", () => {
  const targetWorkspace = makeTempDir();
  const invocationWorkspace = makeTempDir();

  const status = run("node", [SCRIPT, "status", "--cwd", targetWorkspace], {
    cwd: invocationWorkspace
  });
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Session runtime: direct process per invocation/);

  const setup = run("node", [SCRIPT, "setup", "--cwd", targetWorkspace, "--json"], {
    cwd: invocationWorkspace
  });
  assert.equal(setup.status, 0, setup.stderr);
  const payload = JSON.parse(setup.stdout);
  assert.equal(payload.sessionRuntime.mode, "direct");
  assert.equal(payload.sessionRuntime.endpoint, null);
});
