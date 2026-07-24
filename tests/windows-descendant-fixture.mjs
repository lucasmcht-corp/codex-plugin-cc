import { spawn } from "node:child_process";
import process from "node:process";

const child = spawn(
  process.execPath,
  ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
  { stdio: "ignore" }
);
process.stdout.write(`${child.pid}\n`);
setInterval(() => {}, 60_000);
