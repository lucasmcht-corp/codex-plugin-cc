import { spawn } from "node:child_process";
import process from "node:process";

import { createOwnedProcessLaunch } from "../plugins/codex/scripts/lib/process.mjs";

const token = `owner-lifetime-${process.pid}-${Date.now()}`;
const launch = createOwnedProcessLaunch(
  process.execPath,
  ["tests/windows-descendant-fixture.mjs"],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: ["ignore", "pipe", "ignore"],
    token,
    terminateWithOwner: true
  }
);
const supervisor = spawn(launch.command, launch.args, launch.spawnOptions);
supervisor.stdout.setEncoding("utf8");
supervisor.once("error", (error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
supervisor.stdout.once("data", (chunk) => {
  const childPid = Number(chunk.trim());
  process.stdout.write(`${JSON.stringify({ supervisorPid: supervisor.pid, childPid })}\n`);
});
setInterval(() => {}, 60_000);
