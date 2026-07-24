#!/usr/bin/env node

import fs from "node:fs";
import process from "node:process";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getCodexAvailability } from "./lib/codex.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { getConfig, listJobs } from "./lib/state.mjs";
import { sortJobsNewestFirst } from "./lib/job-control.mjs";
import { SESSION_ID_ENV } from "./lib/tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  STOP_REVIEW_FINALIZE_TIMEOUT_MS,
  STOP_REVIEW_LAUNCH_TIMEOUT_MS,
  STOP_REVIEW_STATUS_TIMEOUT_MS,
  STOP_REVIEW_WAIT_MS
} from "./lib/runtime-config.mjs";

/**
 * @typedef {import("./lib/reliability-contracts").JobRecord} JobRecord
 * @typedef {object} StopHookInput
 * @property {string} [cwd]
 * @property {string} [session_id]
 * @property {string} [last_assistant_message]
 * @typedef {{ ok: true, reason: null } | { ok: false, reason: string }} ReviewDecision
 */

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, "..");

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {string} text @returns {unknown} */
function parseUnknownJson(text) {
  return JSON.parse(text);
}

/** @param {Record<string, unknown>} value @param {string} key */
function optionalString(value, key) {
  if (!Object.hasOwn(value, key)) {
    return undefined;
  }
  const entry = value[key];
  if (typeof entry !== "string") {
    throw new Error(`Stop hook input field ${key} must be a string.`);
  }
  return entry;
}

/** @param {unknown} error */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @returns {StopHookInput} */
function readHookInput() {
  const raw = fs.readFileSync(0, "utf8").trim();
  if (!raw) {
    return {};
  }
  const parsed = parseUnknownJson(raw);
  if (!isRecord(parsed)) {
    throw new Error("Stop hook input must be a JSON object.");
  }
  return {
    cwd: optionalString(parsed, "cwd"),
    session_id: optionalString(parsed, "session_id"),
    last_assistant_message: optionalString(parsed, "last_assistant_message")
  };
}

/** @param {{ decision: "block", reason: string }} payload */
function emitDecision(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** @param {string | null} message */
function logNote(message) {
  if (!message) {
    return;
  }
  process.stderr.write(`${message}\n`);
}

/** @param {JobRecord[]} jobs @param {StopHookInput} [input] */
function filterJobsForCurrentSession(jobs, input = {}) {
  const sessionId = input.session_id || process.env[SESSION_ID_ENV] || null;
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

/** @param {StopHookInput} [input] */
function buildStopReviewPrompt(input = {}) {
  const lastAssistantMessage = String(input.last_assistant_message ?? "").trim();
  const template = loadPromptTemplate(ROOT_DIR, "stop-review-gate");
  const claudeResponseBlock = lastAssistantMessage
    ? ["Previous Claude response:", lastAssistantMessage].join("\n")
    : "";
  return interpolateTemplate(template, {
    CLAUDE_RESPONSE_BLOCK: claudeResponseBlock
  });
}

/** @param {string} cwd */
function buildSetupNote(cwd) {
  const availability = getCodexAvailability(cwd);
  if (availability.available) {
    return null;
  }

  const detail = availability.detail ? ` ${availability.detail}.` : "";
  return `Codex is not set up for the review gate.${detail} Run /codex:setup.`;
}

/** @param {unknown} rawOutput @returns {ReviewDecision} */
function parseStopReviewOutput(rawOutput) {
  const text = String(rawOutput ?? "").trim();
  if (!text) {
    return {
      ok: false,
      reason:
        "The stop-time Codex review task returned no final output. Run /codex:review --wait manually or bypass the gate."
    };
  }

  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  if (firstLine.startsWith("ALLOW:")) {
    return { ok: true, reason: null };
  }
  if (firstLine.startsWith("BLOCK:")) {
    const reason = firstLine.slice("BLOCK:".length).trim() || text;
    return {
      ok: false,
      reason: `Codex stop-time review found issues that still need fixes before ending the session: ${reason}`
    };
  }

  return {
    ok: false,
    reason:
      "The stop-time Codex review task returned an unexpected answer. Run /codex:review --wait manually or bypass the gate."
  };
}

/**
 * @param {string} scriptPath
 * @param {string} cwd
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} childEnv
 * @param {number} timeout
 * @returns {Record<string, unknown>}
 * @param {string} [input]
 */
function runCompanion(scriptPath, cwd, args, childEnv, timeout, input) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: childEnv,
    encoding: "utf8",
    timeout,
    input
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "").trim();
    throw new Error(detail || `Companion command ${args[0]} failed.`);
  }
  const parsed = parseUnknownJson(result.stdout);
  if (!isRecord(parsed)) {
    throw new Error(`Companion command ${args[0]} returned a non-object result.`);
  }
  return parsed;
}

/** @param {string} cwd @param {StopHookInput} [input] @returns {ReviewDecision} */
function runStopReview(cwd, input = {}) {
  const scriptPath = path.join(SCRIPT_DIR, "codex-companion.mjs");
  const prompt = buildStopReviewPrompt(input);
  const childEnv = {
    ...process.env,
    ...(input.session_id ? { [SESSION_ID_ENV]: input.session_id } : {})
  };
  try {
    const start = runCompanion(
      scriptPath,
      cwd,
      ["task", "--background", "--json"],
      childEnv,
      STOP_REVIEW_LAUNCH_TIMEOUT_MS,
      prompt
    );
    const jobId = optionalString(start, "jobId");
    if (!jobId) {
      throw new Error("The stop-time review did not return a job id.");
    }
    const status = runCompanion(
      scriptPath,
      cwd,
      [
        "status",
        jobId,
        "--wait",
        "--timeout-ms",
        String(STOP_REVIEW_WAIT_MS),
        "--json"
      ],
      childEnv,
      STOP_REVIEW_STATUS_TIMEOUT_MS
    );
    if (status.waitTimedOut === true) {
      let cancellationDetail = "";
      try {
        runCompanion(
          scriptPath,
          cwd,
          ["cancel", jobId, "--json"],
          childEnv,
          STOP_REVIEW_FINALIZE_TIMEOUT_MS
        );
      } catch (error) {
        cancellationDetail = ` Cancellation also failed: ${getErrorMessage(error)}`;
      }
      return {
        ok: false,
        reason:
          `The stop-time Codex review timed out after 13 minutes and was stopped.${cancellationDetail}`
      };
    }
    const result = runCompanion(
      scriptPath,
      cwd,
      ["result", jobId, "--json"],
      childEnv,
      STOP_REVIEW_FINALIZE_TIMEOUT_MS
    );
    const storedJob = isRecord(result.storedJob) ? result.storedJob : null;
    const storedResult = storedJob && isRecord(storedJob.result) ? storedJob.result : null;
    return parseStopReviewOutput(storedResult?.rawOutput);
  } catch (error) {
    return {
      ok: false,
      reason: `The stop-time Codex review task failed: ${getErrorMessage(error)}`
    };
  }
}

function main() {
  const input = readHookInput();
  const cwd = input.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);

  const jobs = sortJobsNewestFirst(filterJobsForCurrentSession(listJobs(workspaceRoot), input));
  const runningJob = jobs.find(
    (job) => job.status === "queued" || job.status === "running" || job.status === "cancelling"
  );
  const runningTaskNote = runningJob
    ? runningJob.worker?.token
      ? `Codex task ${runningJob.id} is still running. Check /codex:status and use /codex:cancel ${runningJob.id} if you want to stop it before ending the session.`
      : `Codex task ${runningJob.id} is still launching. Check /codex:status before ending the session.`
    : null;

  if (!config.stopReviewGate) {
    logNote(runningTaskNote);
    return;
  }

  const setupNote = buildSetupNote(cwd);
  if (setupNote) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${setupNote}` : setupNote
    });
    return;
  }

  const review = runStopReview(cwd, input);
  if (!review.ok) {
    emitDecision({
      decision: "block",
      reason: runningTaskNote ? `${runningTaskNote} ${review.reason}` : review.reason
    });
    return;
  }

  logNote(runningTaskNote);
}

try {
  main();
} catch (error) {
  emitDecision({
    decision: "block",
    reason: `The stop-time Codex review gate failed unexpectedly: ${getErrorMessage(error)}`
  });
}
