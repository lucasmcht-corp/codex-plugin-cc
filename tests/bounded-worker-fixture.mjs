import { spawn } from "node:child_process";
import process from "node:process";

import {
  captureOwnedWorkerIdentity,
  installBoundedWorkerTermination
} from "../plugins/codex/scripts/lib/process.mjs";

const tokenIndex = process.argv.indexOf("--worker-token");
const token = process.argv[tokenIndex + 1];
const identity = captureOwnedWorkerIdentity(process.pid, token);
const child = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  { stdio: "ignore" }
);

const disposeTermination = installBoundedWorkerTermination(
  identity,
  {
    signalAnchorMs: 300
  }
);

process.stdout.write(`${child.pid}\n`);
const active = setInterval(() => {}, 1000);
process.on("SIGTERM", () => {
  disposeTermination();
  clearInterval(active);
});
