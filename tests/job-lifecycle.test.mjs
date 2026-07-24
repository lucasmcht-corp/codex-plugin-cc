import test from "node:test";
import assert from "node:assert/strict";

import {
  isOwnedWorker,
  isProcessIdentity,
  ownedWindowsJobName,
  sameProcessGeneration,
  sameOwnedWorkerGeneration
} from "../plugins/codex/scripts/lib/job-lifecycle.mjs";

const posixWorker = {
  version: 1,
  pid: 1234,
  token: "worker-token",
  startKey: "worker-start",
  platform: "linux",
  processGroupId: 1234
};

const windowsWorker = {
  version: 2,
  pid: 1234,
  token: "worker-token",
  startKey: "worker-start",
  platform: "win32",
  processGroupId: null,
  jobName: ownedWindowsJobName("worker-token")
};

test("owned POSIX workers match only with their complete identity", () => {
  assert.equal(sameOwnedWorkerGeneration(posixWorker, { ...posixWorker }), true);
  assert.equal(
    sameOwnedWorkerGeneration(posixWorker, {
      ...posixWorker,
      processGroupId: 4321
    }),
    false
  );
});

test("owned Windows workers match only with their exact Job Object", () => {
  assert.equal(sameOwnedWorkerGeneration(windowsWorker, { ...windowsWorker }), true);
  assert.equal(
    sameOwnedWorkerGeneration(windowsWorker, {
      ...windowsWorker,
      jobName: "Local\\CodexPlugin-other-worker"
    }),
    false
  );
});

test("owned worker identity rejects version, platform, and platform-family mismatches", () => {
  assert.equal(
    sameOwnedWorkerGeneration(posixWorker, {
      ...posixWorker,
      version: 2
    }),
    false
  );
  assert.equal(
    sameOwnedWorkerGeneration(posixWorker, {
      ...posixWorker,
      platform: "darwin"
    }),
    false
  );
  assert.equal(sameOwnedWorkerGeneration(posixWorker, windowsWorker), false);
  assert.equal(sameOwnedWorkerGeneration(windowsWorker, posixWorker), false);
});

test("owned worker validation rejects an unknown persisted platform", () => {
  assert.equal(
    isOwnedWorker({
      ...posixWorker,
      platform: "unknown-platform"
    }),
    false
  );
  assert.equal(
    isOwnedWorker({
      ...posixWorker,
      processGroupId: posixWorker.pid + 1
    }),
    false
  );
  assert.equal(
    isOwnedWorker({
      ...windowsWorker,
      token: "another-token"
    }),
    false
  );
});

test("process generation comparison validates both complete operands", () => {
  const processIdentity = {
    pid: 1234,
    startKey: "process-start"
  };

  assert.equal(isProcessIdentity(processIdentity), true);
  assert.equal(sameProcessGeneration(processIdentity, { ...processIdentity }), true);
  assert.equal(sameProcessGeneration(processIdentity, { pid: 1234 }), false);
  assert.equal(sameProcessGeneration({ pid: 1234 }, processIdentity), false);
  assert.equal(sameProcessGeneration(processIdentity, { pid: 0, startKey: "process-start" }), false);
  assert.equal(sameProcessGeneration(processIdentity, { pid: 1234, startKey: "" }), false);
});

test("owned worker generation comparison rejects partial identities on either side", () => {
  const partialPosix = {
    pid: posixWorker.pid,
    token: posixWorker.token,
    startKey: posixWorker.startKey
  };
  const partialWindows = {
    ...windowsWorker
  };
  delete partialWindows.jobName;

  assert.equal(sameOwnedWorkerGeneration(posixWorker, partialPosix), false);
  assert.equal(sameOwnedWorkerGeneration(partialPosix, posixWorker), false);
  assert.equal(sameOwnedWorkerGeneration(windowsWorker, partialWindows), false);
  assert.equal(sameOwnedWorkerGeneration(partialWindows, windowsWorker), false);
});
