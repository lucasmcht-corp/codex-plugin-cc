#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";

import { TRANSCRIPT_PATH_ENV } from "./lib/claude-session-transfer.mjs";
import {
  cleanupSessionJobs,
  prepareSessionStart
} from "./lib/session-cleanup.mjs";
import { loadRuntimeConfig } from "./lib/runtime-config.mjs";
import { markSessionEnding } from "./lib/state.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
const COMPANION_DATA_ENV = "CODEX_COMPANION_PLUGIN_DATA";
const PLUGIN_DATA_ENV = "CLAUDE_PLUGIN_DATA";
let eventName = process.argv[2] ?? "";

/**
 * @typedef {object} SessionHookInput
 * @property {string} [cwd]
 * @property {string} [session_id]
 * @property {string} [transcript_path]
 * @property {string} [hook_event_name]
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {Record<string, unknown>} value @param {string} key */
function optionalString(value, key) {
  if (!Object.hasOwn(value, key)) {
    return undefined;
  }
  const entry = value[key];
  if (typeof entry !== "string") {
    throw new Error(`Session hook input field ${key} must be a string.`);
  }
  return entry;
}

/** @param {string} text @returns {unknown} */
function parseUnknownJson(text) {
  return JSON.parse(text);
}

/** @returns {SessionHookInput} */
function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = parseUnknownJson(raw);
  if (!isRecord(parsed)) {
    throw new Error("Session hook input must be a JSON object.");
  }
  return {
    cwd: optionalString(parsed, "cwd"),
    session_id: optionalString(parsed, "session_id"),
    transcript_path: optionalString(parsed, "transcript_path"),
    hook_event_name: optionalString(parsed, "hook_event_name")
  };
}

/** @param {unknown} value */
function shellEscape(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

/** @param {string} name @param {unknown} value */
function appendEnvVar(name, value) {
  if (!process.env.CLAUDE_ENV_FILE || value == null || value === "") {
    return;
  }
  fs.appendFileSync(process.env.CLAUDE_ENV_FILE, `export ${name}=${shellEscape(value)}\n`, "utf8");
}

/**
 * @param {SessionHookInput} input
 * @param {ReturnType<typeof loadRuntimeConfig>} runtimeConfig
 */
async function handleSessionStart(input, runtimeConfig) {
  const workspaceRoot = resolveWorkspaceRoot(input.cwd || process.cwd());
  const companionDataDir =
    process.env[COMPANION_DATA_ENV] ?? process.env[PLUGIN_DATA_ENV];
  if (companionDataDir) {
    process.env[COMPANION_DATA_ENV] = companionDataDir;
  }
  appendEnvVar(SESSION_ID_ENV, input.session_id);
  appendEnvVar(TRANSCRIPT_PATH_ENV, input.transcript_path);
  appendEnvVar(COMPANION_DATA_ENV, companionDataDir);
  await prepareSessionStart(workspaceRoot, {
    steeringConfig: runtimeConfig.steering,
    workerConfig: runtimeConfig.worker,
    sessionStartConfig: runtimeConfig.sessionStart
  });
}

/**
 * @param {SessionHookInput} input
 * @param {ReturnType<typeof loadRuntimeConfig>} runtimeConfig
 */
async function handleSessionEnd(input, runtimeConfig) {
  const cwd = input.cwd || process.cwd();
  const sessionId = input.session_id || process.env[SESSION_ID_ENV];
  if (!cwd || !sessionId) {
    return;
  }
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const deadlineAt = Date.now() + runtimeConfig.sessionEnd.cleanupBudgetMs;
  const sessionEnding = markSessionEnding(workspaceRoot, sessionId);
  try {
    await cleanupSessionJobs(workspaceRoot, sessionId, {
      steeringConfig: runtimeConfig.steering,
      workerConfig: runtimeConfig.worker,
      deadlineAt,
      allowPartial: true,
      sessionEnding
    });
  } catch (error) {
    process.stderr.write(
      `Session cleanup deferred: ${error instanceof Error ? error.message : String(error)}\n`
    );
  }
}

async function main() {
  const input = readHookInput();
  eventName ||= input.hook_event_name ?? "";
  const runtimeConfig = loadRuntimeConfig(process.env);

  if (eventName === "SessionStart") {
    await handleSessionStart(input, runtimeConfig);
    return;
  }

  if (eventName === "SessionEnd") {
    await handleSessionEnd(input, runtimeConfig);
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (eventName === "SessionStart") {
    process.stdout.write(
      `${JSON.stringify({
        continue: false,
        stopReason: message
      })}\n`
    );
    return;
  }
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
