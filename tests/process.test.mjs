import { spawn } from "node:child_process";
import process from "node:process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  assertOwnedWorkerPlatformSupported,
  captureOwnedWorkerIdentity,
  createOwnedProcessLaunch,
  createOwnedWorkerLaunch,
  installBoundedWorkerTermination,
  inspectOwnedWorker,
  inspectProcessIdentity,
  runCommand,
  runCommandChecked,
  stopOwnedPosixSupervisorGroup,
  stopOwnedWorkerTree
} from "../plugins/codex/scripts/lib/process.mjs";

function missingProcessError() {
  return Object.assign(new Error("missing process"), { code: "ESRCH" });
}

function windowsWorkerFixture(token, startKey = "start-1") {
  const launch = createOwnedWorkerLaunch("node.exe", ["worker.mjs"], token, {
    platform: "win32"
  });
  return {
    launch,
    observed: {
      pid: 1234,
      processGroupId: null,
      startKey,
      argv: null,
      command: `powershell.exe -EncodedCommand ${launch.args.at(-1)}`
    }
  };
}

async function waitForProcessExitForTest(pid, options = {}) {
  const deadline = Date.now() + (options.timeoutMs ?? 2000);
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") {
        return true;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("signal-terminated commands never report success", () => {
  const result = runCommand(process.execPath, [
    "-e",
    "process.kill(process.pid, 'SIGTERM')"
  ]);

  assert.equal(result.status, null);
  assert.ok(result.signal);
  assert.throws(
    () =>
      runCommandChecked(process.execPath, [
        "-e",
        "process.kill(process.pid, 'SIGTERM')"
      ]),
    /signal=/
  );
});

test("owned app-server launch uses a detached stable POSIX supervisor", () => {
  const launch = createOwnedProcessLaunch("codex", ["app-server"], {
    platform: "linux",
    cwd: "/workspace",
    env: { PATH: "/bin" },
    token: "app-server-token"
  });

  assert.equal(launch.command, process.execPath);
  assert.equal(launch.spawnOptions.detached, true);
  assert.equal(launch.spawnOptions.shell, false);
  assert.deepEqual(launch.spawnOptions.stdio, ["pipe", "pipe", "pipe", "ipc"]);
  assert.match(launch.args[1], /owned-posix-supervisor/);
});

test("non-Linux POSIX ownership fails closed before second-resolution identities are used", () => {
  let commandRuns = 0;
  let spawnCalls = 0;
  const runCommandImpl = () => {
    commandRuns += 1;
    return {
      command: "ps",
      args: [],
      status: 0,
      signal: null,
      stdout: "1234 1 1234 Thu Jul 24 12:00:00 2026 node worker.mjs",
      stderr: "",
      error: null
    };
  };

  assert.throws(
    () => assertOwnedWorkerPlatformSupported("darwin"),
    /exact owned-process generation tracking is unsupported/i
  );
  assert.throws(
    () =>
      inspectProcessIdentity(1234, {
        platform: "darwin",
        runCommandImpl
      }),
    /exact process-generation inspection is unsupported/i
  );
  assert.throws(
    () =>
      createOwnedProcessLaunch("codex", ["app-server"], {
        platform: "darwin",
        token: "same-second-token"
      }),
    /exact owned-process generation tracking is unsupported/i
  );
  assert.throws(
    () => {
      const launch = createOwnedWorkerLaunch(
        "node",
        ["worker.mjs"],
        "macos-worker-token",
        { platform: "darwin" }
      );
      spawnCalls += 1;
      spawn(launch.command, launch.args, launch.spawnOptions);
    },
    /exact owned-process generation tracking is unsupported/i
  );
  assert.equal(commandRuns, 0);
  assert.equal(spawnCalls, 0);
});

test("owned Windows launch assigns a suspended child to a kill-on-close Job Object", () => {
  const launch = createOwnedProcessLaunch("codex", ["app-server"], {
    platform: "win32",
    cwd: "C:\\workspace",
    env: { PATH: "C:\\bin" },
    token: "app-server-token"
  });
  const supervisor = Buffer.from(launch.args.at(-1), "base64").toString("utf16le");

  assert.equal(launch.command, "powershell.exe");
  assert.equal(launch.spawnOptions.shell, false);
  assert.equal(launch.spawnOptions.detached, false);
  assert.match(supervisor, /CreateProcess/);
  assert.match(supervisor, /AssignProcessToJobObject/);
  assert.match(supervisor, /ResumeThread/);
  assert.match(supervisor, /JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE/);
  assert.ok(
    supervisor.indexOf("AssignProcessToJobObject") <
      supervisor.indexOf("ResumeThread")
  );
});

test("direct Windows app-server launch monitors the exact owner handle generation", () => {
  const ownerStartKey = "638889984000000000";
  const launch = createOwnedProcessLaunch("codex", ["app-server"], {
    platform: "win32",
    cwd: "C:\\workspace",
    env: { PATH: "C:\\bin" },
    token: "app-server-token",
    terminateWithOwner: true,
    ownerIdentity: {
      pid: process.pid,
      parentPid: 1,
      processGroupId: null,
      startKey: ownerStartKey,
      argv: null,
      command: "node owner.mjs"
    }
  });
  const supervisor = Buffer.from(launch.args.at(-1), "base64").toString("utf16le");

  assert.match(
    supervisor,
    /OpenProcess\(\s*SYNCHRONIZE \| PROCESS_QUERY_LIMITED_INFORMATION/
  );
  assert.match(supervisor, /GetProcessTimes\(owner/);
  assert.match(
    supervisor,
    /DateTime\.FromFileTimeUtc\(creationTime\)\.Ticks != ownerStartTicks/
  );
  assert.match(supervisor, /WaitForMultipleObjects/);
  assert.match(supervisor, /TerminateJobObject\(job, 143\)/);
  assert.match(supervisor, new RegExp(`, ${process.pid}, ${ownerStartKey}\\)`));
  assert.ok(
    supervisor.indexOf("GetProcessTimes(owner") <
      supervisor.indexOf("if (!CreateProcess(")
  );
});

test("background Windows worker launch is not tied to its foreground owner", () => {
  const launch = createOwnedWorkerLaunch(
    "node.exe",
    ["worker.mjs", "--worker-token", "background-token"],
    "background-token",
    { platform: "win32" }
  );
  const supervisor = Buffer.from(launch.args.at(-1), "base64").toString("utf16le");

  assert.match(supervisor, /LaunchAndWait\([^;]+, 0, 0\)/);
});

test("POSIX supervisor remains the process-group anchor through TERM and KILL", async () => {
  const signals = [];
  let alive = true;
  const identity = {
    pid: 4321,
    processGroupId: 4321,
    startKey: "stable-supervisor"
  };
  const result = await stopOwnedPosixSupervisorGroup(identity, {
    graceMs: 0,
    killMs: 25,
    intervalMs: 1,
    inspectProcessImpl() {
      return alive
        ? {
            ...identity,
            parentPid: 1,
            argv: [],
            command: "owned supervisor"
          }
        : null;
    },
    killImpl(pid, signal) {
      signals.push({ pid, signal });
      if (signal === "SIGKILL") {
        alive = false;
      }
      if (signal === 0 && !alive) {
        throw missingProcessError();
      }
    }
  });

  assert.equal(result.forced, true);
  assert.deepEqual(
    signals.filter(({ signal }) => signal !== 0),
    [
      { pid: -4321, signal: "SIGTERM" },
      { pid: -4321, signal: "SIGKILL" }
    ]
  );
});

test("bounded worker termination propagates TERM once and forces the group at its deadline", () => {
  const signals = [];
  let deadline = null;
  let timerCount = 0;
  const dispose = installBoundedWorkerTermination(
    {
      version: 1,
      pid: 1234,
      token: "worker-token",
      startKey: "worker-start",
      platform: "linux",
      processGroupId: 1234
    },
    { signalAnchorMs: 25 },
    {
      killImpl(pid, signal) {
        signals.push({ pid, signal });
      },
      setTimeoutImpl(callback) {
        timerCount += 1;
        deadline = callback;
        return { timerCount };
      },
      clearTimeoutImpl() {}
    }
  );

  try {
    process.emit("SIGTERM");
    dispose();
    process.emit("SIGTERM");
    assert.equal(timerCount, 1);
    assert.deepEqual(signals, [{ pid: -1234, signal: "SIGTERM" }]);
    deadline();
    assert.deepEqual(signals, [
      { pid: -1234, signal: "SIGTERM" },
      { pid: -1234, signal: "SIGKILL" }
    ]);
  } finally {
    dispose();
  }
});

test("bounded Windows termination force-stops the full worker tree", () => {
  let deadline = null;
  let termination = null;
  let exitCode = null;
  const token = "worker-token";
  const launch = createOwnedWorkerLaunch("node.exe", ["worker.mjs"], token, {
    platform: "win32"
  });
  const observed = {
    pid: 1234,
    processGroupId: null,
    startKey: "worker-start",
    argv: null,
    command: `powershell.exe -EncodedCommand ${launch.args.at(-1)}`
  };
  const identity = captureOwnedWorkerIdentity(1234, token, {
    platform: "win32",
    inspectProcessImpl() {
      return observed;
    }
  });
  const dispose = installBoundedWorkerTermination(
    identity,
    { signalAnchorMs: 25, stopKillMs: 50 },
    {
      setTimeoutImpl(callback) {
        deadline = callback;
        return { timer: true };
      },
      runCommandImpl(command, args, options) {
        termination = { command, args, options };
        return {
          command,
          args,
          status: 0,
          signal: null,
          stdout: "",
          stderr: "",
          error: null
        };
      },
      exitImpl(code) {
        exitCode = code;
      }
    }
  );

  try {
    process.emit("SIGTERM");
    deadline();
    assert.equal(termination.command, "powershell.exe");
    assert.equal(termination.options.shell, false);
    assert.ok(termination.options.timeout <= 75);
    assert.doesNotMatch(termination.args.join(" "), /taskkill/i);
    const stopScript = Buffer.from(termination.args.at(-1), "base64").toString("utf16le");
    assert.match(stopScript, /TerminateJobObject/);
    assert.equal(exitCode, 143);
  } finally {
    dispose();
  }
});

test("bounded Windows signal termination limits a blocking Job Object command", () => {
  let forceExit = null;
  let exitCode = null;
  let commandName = null;
  const token = "blocking-worker-token";
  const fixture = windowsWorkerFixture(token);
  const identity = captureOwnedWorkerIdentity(1234, token, {
    platform: "win32",
    inspectProcessImpl() {
      return fixture.observed;
    }
  });
  const dispose = installBoundedWorkerTermination(
    identity,
    { signalAnchorMs: 25, stopKillMs: 75 },
    {
      setTimeoutImpl(callback) {
        forceExit = callback;
        return { timer: true };
      },
      runCommandImpl(command, _args, options) {
        commandName = command;
        const blocked = runCommand(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          options
        );
        return {
          ...blocked,
          status: 0,
          signal: null,
          error: null
        };
      },
      exitImpl(code) {
        exitCode = code;
      }
    }
  );

  try {
    process.emit("SIGTERM");
    const startedAt = Date.now();
    forceExit();
    assert.equal(commandName, "powershell.exe");
    assert.equal(exitCode, 143);
    assert.ok(Date.now() - startedAt < 1000);
  } finally {
    dispose();
  }
});

test("owned worker identity requires an exact worker token argument", () => {
  const matchingProcess = {
    pid: 1234,
    processGroupId: 1234,
    startKey: "start-1",
    argv: ["node", "worker.mjs", "--worker-token", "token-1"],
    command: "node worker.mjs --worker-token token-1"
  };
  const identity = captureOwnedWorkerIdentity(1234, "token-1", {
    platform: "linux",
    inspectProcessImpl() {
      return matchingProcess;
    }
  });

  assert.equal(
    inspectOwnedWorker(identity, {
      inspectProcessImpl() {
        return matchingProcess;
      }
    }).status,
    "same"
  );
  assert.throws(
    () =>
      captureOwnedWorkerIdentity(1234, "token-2", {
        platform: "linux",
        inspectProcessImpl() {
          return matchingProcess;
        }
      }),
    /worker token/i
  );
});

test("Windows process inspection invokes PowerShell directly without cmd.exe", () => {
  let captured = null;
  const fixture = windowsWorkerFixture("token-1");
  const identity = captureOwnedWorkerIdentity(1234, "token-1", {
    platform: "win32",
    runCommandImpl(command, args, options) {
      captured = { command, args, options };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: JSON.stringify({
          pid: 1234,
          startKey: "start-1",
          command: fixture.observed.command
        }),
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(identity.pid, 1234);
  assert.equal(identity.version, 2);
  assert.match(identity.jobName, /^Local\\CodexPlugin-/);
  assert.equal(captured.command, "powershell.exe");
  assert.equal(captured.options.shell, false);
});

test("Windows inspection rejects a persisted identity from another deterministic worker generation", async () => {
  const first = windowsWorkerFixture("token-a");
  const second = windowsWorkerFixture("token-b");
  const captured = captureOwnedWorkerIdentity(1234, "token-a", {
    platform: "win32",
    inspectProcessImpl() {
      return first.observed;
    }
  });
  const replaced = {
    ...captured,
    token: "token-b",
    jobName: second.launch.ownership.jobName
  };
  let terminationCount = 0;

  assert.equal(
    inspectOwnedWorker(replaced, {
      inspectProcessImpl() {
        return first.observed;
      }
    }).status,
    "mismatch"
  );
  await assert.rejects(
    stopOwnedWorkerTree(replaced, {
      inspectProcessImpl() {
        return first.observed;
      },
      runCommandImpl() {
        terminationCount += 1;
        throw new Error("A mismatched Windows worker must not be terminated.");
      }
    }),
    /identity mismatch/i
  );
  assert.equal(terminationCount, 0);
});

test("process inspection passes the absolute deadline to a blocking command", () => {
  const startedAt = Date.now();
  assert.throws(
    () =>
      inspectProcessIdentity(1234, {
        platform: "linux",
        deadlineAt: startedAt + 75,
        runCommandImpl(_command, _args, options) {
          return runCommand(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            options
          );
        }
      }),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ETIMEDOUT"
  );
  assert.ok(Date.now() - startedAt < 1000);
});

test("Windows Job Object termination passes the absolute deadline to a blocking command", async () => {
  const fixture = windowsWorkerFixture("token-1");
  const identity = captureOwnedWorkerIdentity(1234, "token-1", {
    platform: "win32",
    inspectProcessImpl() {
      return fixture.observed;
    }
  });
  const startedAt = Date.now();

  await assert.rejects(
    stopOwnedWorkerTree(identity, {
      deadlineAt: startedAt + 75,
      inspectProcessImpl() {
        return fixture.observed;
      },
      runCommandImpl(_command, _args, options) {
        return runCommand(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          options
        );
      }
    }),
    (error) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "ETIMEDOUT"
  );
  assert.ok(Date.now() - startedAt < 1000);
});

test("owned worker identity mismatch fails before sending a signal", async () => {
  const identity = captureOwnedWorkerIdentity(1234, "token-1", {
    platform: "linux",
    inspectProcessImpl() {
      return {
        pid: 1234,
        processGroupId: 1234,
        startKey: "start-1",
        argv: ["node", "worker.mjs", "--worker-token", "token-1"],
        command: "node worker.mjs --worker-token token-1"
      };
    }
  });
  let signalCount = 0;

  await assert.rejects(
    stopOwnedWorkerTree(identity, {
      inspectProcessImpl() {
        return {
          pid: 1234,
          processGroupId: 1234,
          startKey: "start-2",
          argv: ["node", "worker.mjs", "--worker-token", "token-1"],
          command: "node worker.mjs --worker-token token-1"
        };
      },
      killImpl() {
        signalCount += 1;
      }
    }),
    /identity mismatch/i
  );
  assert.equal(signalCount, 0);
});

test("owned worker with a missing anchor and a live group fails without a terminating signal", async () => {
  const identity = captureOwnedWorkerIdentity(1234, "token-1", {
    platform: "linux",
    inspectProcessImpl() {
      return {
        pid: 1234,
        processGroupId: 1234,
        startKey: "start-1",
        argv: ["node", "worker.mjs", "--worker-token", "token-1"],
        command: "node worker.mjs --worker-token token-1"
      };
    }
  });
  const signals = [];

  await assert.rejects(
    stopOwnedWorkerTree(identity, {
      inspectProcessImpl() {
        return null;
      },
      killImpl(pid, signal) {
        signals.push({ pid, signal });
      }
    }),
    /identity anchor is gone/i
  );
  assert.deepEqual(signals, [{ pid: -1234, signal: 0 }]);
});

test("stopOwnedWorkerTree escalates from TERM to KILL until a resistant POSIX group is gone", {
  skip: process.platform === "win32"
}, async (t) => {
  const token = `token-${process.pid}-${Date.now()}`;
  const childCode = [
    "const { spawn } = require('node:child_process');",
    "process.on('SIGTERM', () => {});",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' });",
    "console.log(child.pid);",
    "setInterval(() => {}, 1000);"
  ].join("");
  const leader = spawn(process.execPath, ["-e", childCode, "--", "--worker-token", token], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"]
  });
  leader.stdout.setEncoding("utf8");
  const childPid = Number(
    await new Promise((resolve) => {
      leader.stdout.once("data", (chunk) => resolve(chunk.trim()));
    })
  );
  t.after(() => {
    try {
      process.kill(-leader.pid, "SIGKILL");
    } catch {
      // The owned group was already stopped.
    }
  });
  await new Promise((resolve) => setTimeout(resolve, 200));

  const identity = captureOwnedWorkerIdentity(leader.pid, token);
  const result = await stopOwnedWorkerTree(identity, {
    graceMs: 100,
    killMs: 2000,
    intervalMs: 20
  });

  assert.equal(result.stopped, true);
  assert.equal(result.forced, true);
  assert.equal(await waitForProcessExitForTest(leader.pid), true);
  assert.equal(await waitForProcessExitForTest(childPid), true);
});

test("a direct SIGTERM to the worker cannot leave its resistant group alive", {
  skip: process.platform === "win32"
}, async (t) => {
  const token = `bounded-${process.pid}-${Date.now()}`;
  const leader = spawn(
    process.execPath,
    ["tests/bounded-worker-fixture.mjs", "--worker-token", token],
    {
      cwd: process.cwd(),
      detached: true,
      stdio: ["ignore", "pipe", "ignore"]
    }
  );
  leader.stdout.setEncoding("utf8");
  const childPid = Number(
    await new Promise((resolve) => {
      leader.stdout.once("data", (chunk) => resolve(chunk.trim()));
    })
  );
  t.after(() => {
    try {
      process.kill(-leader.pid, "SIGKILL");
    } catch {
      // The bounded handler already stopped the group.
    }
  });

  process.kill(leader.pid, "SIGTERM");

  assert.equal(await waitForProcessExitForTest(leader.pid), true);
  assert.equal(await waitForProcessExitForTest(childPid), true);
});

test("stopOwnedWorkerTree terminates the exact Windows Job Object and fails closed", async () => {
  const { observed } = windowsWorkerFixture("token-1");
  const identity = captureOwnedWorkerIdentity(1234, "token-1", {
    platform: "win32",
    inspectProcessImpl() {
      return observed;
    }
  });
  let captured = null;

  await assert.rejects(
    stopOwnedWorkerTree(identity, {
      inspectProcessImpl() {
        return observed;
      },
      runCommandImpl(command, args, options) {
        captured = { command, args, options };
        return {
          command,
          args,
          status: 5,
          signal: null,
          stdout: "",
          stderr: "Access denied",
          error: null
        };
      }
    }),
    /access denied/i
  );
  assert.equal(captured.command, "powershell.exe");
  assert.equal(captured.options.shell, false);
  assert.doesNotMatch(captured.args.join(" "), /taskkill/i);
  const stopScript = Buffer.from(captured.args.at(-1), "base64").toString("utf16le");
  assert.match(stopScript, /OpenJobObject/);
  assert.match(stopScript, /TerminateJobObject/);
});

test("Windows cleanup stops a real owned worker and its descendant", {
  skip: process.platform !== "win32"
}, async (t) => {
  const token = `token-${process.pid}-${Date.now()}`;
  const launch = createOwnedWorkerLaunch(
    process.execPath,
    ["tests/bounded-worker-fixture.mjs", "--worker-token", token],
    token,
    {
      platform: "win32",
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "ignore"]
    }
  );
  const worker = spawn(launch.command, launch.args, launch.spawnOptions);
  worker.stdout.setEncoding("utf8");
  const childPid = Number(
    await new Promise((resolve, reject) => {
      const rejectEarlyExit = (code, signal) => {
        reject(
          new Error(
            `Windows worker fixture exited before cleanup: code=${code}, signal=${signal}.`
          )
        );
      };
      worker.once("error", reject);
      worker.once("exit", rejectEarlyExit);
      worker.stdout.once("data", (chunk) => {
        worker.off("exit", rejectEarlyExit);
        resolve(chunk.trim());
      });
    })
  );
  assert.equal(Number.isInteger(childPid), true);
  assert.equal(childPid > 0, true);
  t.after(() => {
    try {
      worker.kill("SIGKILL");
      process.kill(childPid, "SIGKILL");
    } catch {
      // The owned cleanup already stopped the fixture tree.
    }
  });

  const identity = captureOwnedWorkerIdentity(worker.pid, token, {
    platform: "win32"
  });
  assert.equal(identity.pid, worker.pid);
  assert.equal(identity.version, 2);
  assert.equal(identity.platform, "win32");
  assert.match(identity.jobName, /^Local\\CodexPlugin-/);
  assert.equal(inspectOwnedWorker(identity).status, "same");
  const result = await stopOwnedWorkerTree(identity, {
    graceMs: 100,
    killMs: 2000,
    intervalMs: 20
  });
  assert.equal(result.stopped, true);
  assert.equal(result.forced, true);
  assert.equal(await waitForProcessExitForTest(worker.pid), true);
  assert.equal(await waitForProcessExitForTest(childPid), true);
});

test("Windows owner death stops its direct supervisor and descendant", {
  skip: process.platform !== "win32"
}, async (t) => {
  const owner = spawn(process.execPath, ["tests/windows-owner-lifetime-fixture.mjs"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"]
  });
  owner.stdout.setEncoding("utf8");
  owner.stderr.setEncoding("utf8");
  let stderr = "";
  owner.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const owned = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Windows owner fixture timed out.${stderr ? ` ${stderr}` : ""}`));
    }, 15_000);
    owner.once("error", reject);
    owner.stdout.once("data", (chunk) => {
      clearTimeout(timeout);
      resolve(JSON.parse(chunk.trim()));
    });
  });
  t.after(() => {
    for (const pid of [owner.pid, owned.supervisorPid, owned.childPid]) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The owner sentinel already stopped this process.
      }
    }
  });

  assert.equal(Number.isInteger(owned.supervisorPid), true);
  assert.equal(Number.isInteger(owned.childPid), true);
  owner.kill("SIGKILL");

  assert.equal(
    await waitForProcessExitForTest(owned.supervisorPid, { timeoutMs: 5000 }),
    true
  );
  assert.equal(
    await waitForProcessExitForTest(owned.childPid, { timeoutMs: 5000 }),
    true
  );
});

test("Windows PID reuse after Job Object termination cannot redirect the kill", async () => {
  const { observed } = windowsWorkerFixture("token-1");
  const identity = captureOwnedWorkerIdentity(1234, "token-1", {
    platform: "win32",
    inspectProcessImpl() {
      return observed;
    }
  });
  let inspections = 0;

  let termination = null;
  const result = await stopOwnedWorkerTree(identity, {
    inspectProcessImpl() {
      inspections += 1;
      return inspections === 1
        ? observed
        : {
            ...observed,
            startKey: "start-2"
          };
    },
    runCommandImpl(command, args, options) {
      termination = { command, args, options };
      return {
        command,
        args,
        status: 0,
        signal: null,
        stdout: "",
        stderr: "",
        error: null
      };
    }
  });

  assert.equal(result.stopped, true);
  assert.equal(termination.command, "powershell.exe");
  assert.doesNotMatch(termination.args.join(" "), /1234|taskkill/i);
});
