import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import {
  AppServerRequestError,
  CodexAppServerClient
} from "../plugins/codex/scripts/lib/app-server.mjs";
import { buildEnv, installFakeCodex } from "./fake-codex-fixture.mjs";
import { makeTempDir } from "./helpers.mjs";

async function waitForValue(read, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessExit(pid, timeoutMs = 2500) {
  return Boolean(
    await waitForValue(() => (!isProcessAlive(pid) ? true : null), timeoutMs)
  );
}

function forceKill(pid) {
  if (!Number.isFinite(pid)) {
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // The test process already exited.
  }
}

async function readAppServerPid(statePath) {
  return waitForValue(() => {
    if (!fs.existsSync(statePath)) {
      return null;
    }
    try {
      return JSON.parse(fs.readFileSync(statePath, "utf8")).appServerPid ?? null;
    } catch {
      return null;
    }
  });
}

test("connect closes a live app-server after initialize rejects", { timeout: 7000 }, async (t) => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "initialize-rejects-and-stays-alive");
  const appServerPidPromise = readAppServerPid(statePath);
  t.after(async () => forceKill(await appServerPidPromise));

  await assert.rejects(
    CodexAppServerClient.connect(cwd, {
      env: buildEnv(binDir)
    }),
    /initialize rejected/
  );

  const appServerPid = await appServerPidPromise;
  assert.ok(appServerPid);
  assert.equal(await waitForProcessExit(appServerPid), true);
});

test("connect closes a live app-server after malformed protocol output", { timeout: 7000 }, async (t) => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "malformed-jsonl-stays-alive");
  const appServerPidPromise = readAppServerPid(statePath);
  t.after(async () => forceKill(await appServerPidPromise));

  await assert.rejects(
    CodexAppServerClient.connect(cwd, {
      env: buildEnv(binDir)
    }),
    /Failed to parse codex app-server JSONL/
  );

  const appServerPid = await appServerPidPromise;
  assert.ok(appServerPid);
  assert.equal(await waitForProcessExit(appServerPid), true);
});

test("close is idempotent and bounded for a TERM-resistant app-server", { timeout: 7000 }, async (t) => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "term-resistant-app-server");
  const appServerPidPromise = readAppServerPid(statePath);
  t.after(async () => forceKill(await appServerPidPromise));

  const client = await CodexAppServerClient.connect(cwd, {
    env: buildEnv(binDir)
  });
  const appServerPid = await appServerPidPromise;
  assert.ok(appServerPid);

  const startedAt = Date.now();
  const closed = await Promise.race([
    Promise.all([client.close(), client.close()]).then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 2500))
  ]);

  assert.equal(closed, true);
  assert.ok(Date.now() - startedAt < 2500);
  assert.equal(await waitForProcessExit(appServerPid), true);
});

test("close removes a TERM-resistant app-server descendant", { timeout: 7000 }, async (t) => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "term-resistant-app-server-with-child");
  const client = await CodexAppServerClient.connect(cwd, {
    env: buildEnv(binDir)
  });
  const state = await waitForValue(() => {
    if (!fs.existsSync(statePath)) {
      return null;
    }
    try {
      const current = JSON.parse(fs.readFileSync(statePath, "utf8"));
      return current.appServerPid && current.appServerChildPid ? current : null;
    } catch {
      return null;
    }
  });
  assert.ok(state);
  t.after(() => {
    forceKill(state.appServerPid);
    forceKill(state.appServerChildPid);
  });

  await client.close();

  assert.equal(await waitForProcessExit(state.appServerPid), true);
  assert.equal(await waitForProcessExit(state.appServerChildPid), true);
});

test("close removes a late descendant after the app-server root exits", { timeout: 7000 }, async (t) => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "exit-with-late-resistant-child");
  const client = await CodexAppServerClient.connect(cwd, {
    env: buildEnv(binDir)
  });

  await client.close();
  const childPid = await waitForValue(() => {
    if (!fs.existsSync(statePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(statePath, "utf8")).appServerChildPid ?? null;
  });
  t.after(() => forceKill(childPid));

  assert.ok(childPid);
  assert.equal(await waitForProcessExit(childPid), true);
});

test("notification handler failures reject the controlled client lifecycle", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "default");
  const client = await CodexAppServerClient.connect(cwd, {
    env: buildEnv(binDir)
  });

  try {
    client.setNotificationHandler(() => {
      throw new Error("progress persistence failed");
    });
    await client.request("thread/start", { cwd });
    await assert.rejects(client.waitForExit(), /progress persistence failed/);
  } finally {
    await client.close();
  }
});

test("requests fail immediately after the app-server transport exits", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  installFakeCodex(binDir, "app-server-exits-after-initialize");
  const client = await CodexAppServerClient.connect(cwd, {
    env: buildEnv(binDir)
  });

  await assert.rejects(client.waitForExit(), /closed unexpectedly/);
  assert.throws(
    () => client.request("thread/start", { cwd }),
    /closed/
  );
  await client.close();
});

test("turn/steer stays delivery unknown when its written request loses the response", async () => {
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "steer-response-lost");
  const client = await CodexAppServerClient.connect(cwd, {
    env: buildEnv(binDir)
  });

  const threadResponse = await client.request("thread/start", {
    cwd,
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
      input: [{ type: "text", text: "apply this once", text_elements: [] }],
      expectedTurnId: turnId,
      clientUserMessageId: "steer-response-lost"
    }),
    (error) =>
      error instanceof AppServerRequestError &&
      error.delivery === "unknown" &&
      /response was lost after the request was sent/i.test(error.message)
  );

  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(state.steerCalls, 1);
  assert.equal(state.lastSteer.clientUserMessageId, "steer-response-lost");
  await client.close();
});

test("invalid JSON-RPC envelopes keep a written turn/steer delivery unknown without retry", { timeout: 10_000 }, async (t) => {
  const behaviors = [
    "steer-envelope-null",
    "steer-envelope-array",
    "steer-envelope-missing-id",
    "steer-envelope-wrong-id"
  ];

  for (const behavior of behaviors) {
    await t.test(behavior, async () => {
      const cwd = makeTempDir();
      const binDir = makeTempDir();
      const statePath = path.join(binDir, "fake-codex-state.json");
      installFakeCodex(binDir, behavior);
      const client = await CodexAppServerClient.connect(cwd, {
        env: buildEnv(binDir)
      });

      try {
        const threadResponse = await client.request("thread/start", {
          cwd,
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
            input: [{ type: "text", text: "apply this once", text_elements: [] }],
            expectedTurnId: turnId,
            clientUserMessageId: behavior
          }),
          (error) =>
            error instanceof AppServerRequestError &&
            error.delivery === "unknown" &&
            /invalid codex app-server json-rpc envelope/i.test(error.message)
        );

        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.equal(state.appServerStarts, 1);
        assert.equal(state.steerCalls, 1);
        assert.equal(state.lastSteer.clientUserMessageId, behavior);
      } finally {
        await client.close();
      }
    });
  }
});

test("stdin write failures reject pending requests instead of hanging", { timeout: 7000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("The fake stdin close uses a POSIX file descriptor.");
    return;
  }
  const cwd = makeTempDir();
  const binDir = makeTempDir();
  const statePath = path.join(binDir, "fake-codex-state.json");
  installFakeCodex(binDir, "stdin-closes-and-stays-alive");
  const appServerPidPromise = readAppServerPid(statePath);
  t.after(async () => forceKill(await appServerPidPromise));
  const client = await CodexAppServerClient.connect(cwd, {
    env: buildEnv(binDir)
  });

  await new Promise((resolve) => setTimeout(resolve, 50));
  const result = await Promise.race([
    client.request("thread/start", { cwd }).then(
      () => "resolved",
      () => "rejected"
    ),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 1000))
  ]);

  assert.equal(result, "rejected");
  await assert.rejects(client.waitForExit());
  await client.close();
});
