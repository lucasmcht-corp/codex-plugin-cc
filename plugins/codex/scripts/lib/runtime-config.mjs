// @ts-check

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/**
 * @typedef {{
 *   requestTimeoutMs: number,
 *   maxFrameBytes: number,
 *   socketRoot: string,
 *   directoryMode: number,
 *   socketMode: number
 * }} SteeringConfig
 *
 * @typedef {{
 *   stopGraceMs: number,
 *   stopKillMs: number,
 *   signalAnchorMs: number
 * }} WorkerConfig
 *
 * @typedef {{
 *   recoveryBatchSize: number,
 *   recoveryJobBatchSize: number,
 *   recoveryBudgetMs: number
 * }} SessionStartConfig
 *
 * @typedef {{
 *   cleanupBudgetMs: number
 * }} SessionEndConfig
 *
 * @typedef {{
 *   steering?: Partial<SteeringConfig>,
 *   worker?: Partial<WorkerConfig>,
 *   sessionStart?: Partial<SessionStartConfig>,
 *   sessionEnd?: Partial<SessionEndConfig>
 * }} RuntimeConfigOverrides
 *
 * @typedef {{
 *   steering: SteeringConfig,
 *   worker: WorkerConfig,
 *   sessionStart: SessionStartConfig,
 *   sessionEnd: SessionEndConfig
 * }} RuntimeConfig
 */

function runtimeUserId() {
  return typeof process.getuid === "function"
    ? String(process.getuid())
    : String(process.env.USERNAME ?? process.env.USER ?? "user").replace(
        /[^a-zA-Z0-9._-]+/g,
        "-"
      );
}

export const DEFAULT_STEERING_CONFIG = Object.freeze({
  requestTimeoutMs: 5000,
  maxFrameBytes: 1024 * 1024,
  socketRoot: path.join(
    os.tmpdir(),
    `codex-companion-${runtimeUserId()}`,
    "steering"
  ),
  directoryMode: 0o700,
  socketMode: 0o600
});

export const DEFAULT_WORKER_CONFIG = Object.freeze({
  stopGraceMs: 1000,
  stopKillMs: 2000,
  signalAnchorMs: 4000
});

export const DEFAULT_SESSION_START_CONFIG = Object.freeze({
  recoveryBatchSize: 4,
  recoveryJobBatchSize: 4,
  recoveryBudgetMs: 3500
});

export const DEFAULT_SESSION_END_CONFIG = Object.freeze({
  cleanupBudgetMs: 1000
});

export const DEFAULT_APP_SERVER_CLOSE_CONFIG = Object.freeze({
  gracefulMs: 250,
  termMs: 750,
  killMs: 1000
});

export const EXTERNAL_AGENT_IMPORT_TIMEOUT_MS = 2 * 60 * 1000;
export const TURN_COMPLETION_CONFIRM_DELAY_MS = 250;
export const TURN_COMPLETION_CONFIRM_POLL_MS = 100;
export const TURN_COMPLETION_CONFIRM_TIMEOUT_MS = 5000;
export const STOP_REVIEW_WAIT_MS = 13 * 60 * 1000;
export const STOP_REVIEW_LAUNCH_TIMEOUT_MS = 30 * 1000;
export const STOP_REVIEW_STATUS_TIMEOUT_MS = 14 * 60 * 1000;
export const STOP_REVIEW_FINALIZE_TIMEOUT_MS = 30 * 1000;
export const DEFAULT_PROCESS_COMMAND_TIMEOUT_MS = 2000;
export const DEFAULT_PROCESS_POLL_INTERVAL_MS = 50;
export const DEFAULT_WORKER_CLAIM_TIMEOUT_MS = 2000;
export const DEFAULT_WORKER_CLAIM_POLL_MS = 25;
export const DEFAULT_SESSION_CLEANUP_LAUNCH_WAIT_ATTEMPTS = 80;
export const DEFAULT_SESSION_CLEANUP_LAUNCH_WAIT_POLL_MS = 25;
export const DEFAULT_SESSION_CLEANUP_ROUNDS = 8;

export function ensurePrivateRuntimeDirectory(
  /** @type {string} */
  directoryPath,
  {
    mode = 0o700,
    platform = process.platform,
    expectedUid = typeof process.getuid === "function" ? process.getuid() : null
  } = {}
) {
  fs.mkdirSync(directoryPath, { recursive: true, mode });
  const stats = fs.lstatSync(directoryPath);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Private runtime path is not a directory: ${directoryPath}.`);
  }
  if (platform !== "win32") {
    if (expectedUid != null && stats.uid !== expectedUid) {
      throw new Error(`Private runtime directory has the wrong owner: ${directoryPath}.`);
    }
    if ((stats.mode & 0o777) !== mode) {
      throw new Error(
        `Private runtime directory must use mode ${mode.toString(8)}: ${directoryPath}.`
      );
    }
  }
  return directoryPath;
}

export function assertPrivateRuntimeFile(
  /** @type {string} */
  filePath,
  {
    mode = 0o600,
    platform = process.platform,
    expectedUid = typeof process.getuid === "function" ? process.getuid() : null
  } = {}
) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Private runtime path is not a regular file: ${filePath}.`);
  }
  if (platform !== "win32") {
    if (expectedUid != null && stats.uid !== expectedUid) {
      throw new Error(`Private runtime file has the wrong owner: ${filePath}.`);
    }
    if ((stats.mode & 0o777) !== mode) {
      throw new Error(
        `Private runtime file must use mode ${mode.toString(8)}: ${filePath}.`
      );
    }
  }
  return filePath;
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {RuntimeConfigOverrides} overrides
 * @returns {RuntimeConfig}
 */
export function loadRuntimeConfig(env = process.env, overrides = {}) {
  const config = {
    steering: {
      ...DEFAULT_STEERING_CONFIG,
      ...(env.CODEX_COMPANION_STEERING_ROOT
        ? { socketRoot: path.resolve(env.CODEX_COMPANION_STEERING_ROOT) }
        : {}),
      ...(overrides.steering ?? {})
    },
    worker: {
      ...DEFAULT_WORKER_CONFIG,
      ...(overrides.worker ?? {})
    },
    sessionStart: {
      ...DEFAULT_SESSION_START_CONFIG,
      ...(overrides.sessionStart ?? {})
    },
    sessionEnd: {
      ...DEFAULT_SESSION_END_CONFIG,
      ...(overrides.sessionEnd ?? {})
    }
  };
  for (const [name, value] of Object.entries(config.worker)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(`Worker runtime setting ${name} must be a positive integer.`);
    }
  }
  if (config.worker.signalAnchorMs <= config.worker.stopGraceMs) {
    throw new RangeError("Worker signalAnchorMs must exceed stopGraceMs.");
  }
  for (const [name, value] of Object.entries(config.sessionStart)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(
        `SessionStart runtime setting ${name} must be a positive integer.`
      );
    }
  }
  for (const [name, value] of Object.entries(config.sessionEnd)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new RangeError(
        `SessionEnd runtime setting ${name} must be a positive integer.`
      );
    }
  }
  return config;
}
