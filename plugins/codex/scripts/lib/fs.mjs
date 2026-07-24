import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** @param {string} cwd @param {string} maybePath */
export function ensureAbsolutePath(cwd, maybePath) {
  return path.isAbsolute(maybePath) ? maybePath : path.resolve(cwd, maybePath);
}

/** @param {string} [prefix] */
export function createTempDir(prefix = "codex-plugin-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** @param {string} filePath @returns {unknown} */
export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/** @param {string} filePath @param {unknown} value */
export function writeJsonFile(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** @param {string} filePath */
export function safeReadFile(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}

/** @param {Buffer} buffer */
export function isProbablyText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  for (const value of sample) {
    if (value === 0) {
      return false;
    }
  }
  return true;
}

/** @returns {string} */
export function readStdinIfPiped() {
  if (process.stdin.isTTY) {
    return "";
  }
  return fs.readFileSync(0, "utf8");
}
