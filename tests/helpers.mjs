import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

import { ownedWindowsJobName } from "../plugins/codex/scripts/lib/job-lifecycle.mjs";

export function makeTempDir(prefix = "codex-plugin-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makePosixWorker({
  pid = 1234,
  token = "worker-token",
  startKey = "worker-start",
  platform = "linux",
  processGroupId = pid
} = {}) {
  return {
    version: 1,
    pid,
    token,
    startKey,
    platform,
    processGroupId
  };
}

export function makeWindowsWorker({
  pid = 1234,
  token = "worker-token",
  startKey = "worker-start",
  jobName = ownedWindowsJobName(token)
} = {}) {
  return {
    version: 2,
    pid,
    token,
    startKey,
    platform: "win32",
    processGroupId: null,
    jobName
  };
}

export function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o755 });
}

export function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    shell: options.shell ?? (process.platform === "win32" && !path.isAbsolute(command)),
    windowsHide: true
  });
}

export function initGitRepo(cwd) {
  run("git", ["init", "-b", "main"], { cwd });
  run("git", ["config", "user.name", "Codex Plugin Tests"], { cwd });
  run("git", ["config", "user.email", "tests@example.com"], { cwd });
  run("git", ["config", "commit.gpgsign", "false"], { cwd });
  run("git", ["config", "tag.gpgsign", "false"], { cwd });
}
