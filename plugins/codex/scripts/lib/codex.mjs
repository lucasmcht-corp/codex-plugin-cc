/**
 * @typedef {import("./app-server-protocol").AppServerNotification} AppServerNotification
 * @typedef {import("./app-server-protocol").ExternalAgentConfigImportParams} ExternalAgentConfigImportParams
 * @typedef {import("./app-server-protocol").ReviewTarget} ReviewTarget
 * @typedef {import("./app-server-protocol").ThreadItem} ThreadItem
 * @typedef {import("./app-server-protocol").ThreadResumeParams} ThreadResumeParams
 * @typedef {import("./app-server-protocol").ThreadStartParams} ThreadStartParams
 * @typedef {import("./app-server-protocol").Turn} Turn
 * @typedef {import("./app-server-protocol").UserInput} UserInput
 * @typedef {Awaited<ReturnType<typeof CodexAppServerClient.connect>>} AppServerClient
 * @typedef {Record<string, unknown>} UnknownRecord
 * @typedef {{ id: string, status: string }} CapturedTurn
 * @typedef {{
 *   turn: CapturedTurn,
 *   reviewThreadId?: string
 * }} TurnResponse
 * @typedef {((update: string | { message: string, phase: string | null, threadId?: string | null, turnId?: string | null, stderrMessage?: string | null, logTitle?: string | null, logBody?: string | null }) => void)} ProgressReporter
 * @typedef {{
 *   model?: string | null,
 *   approvalPolicy?: ThreadStartParams["approvalPolicy"],
 *   sandbox?: ThreadStartParams["sandbox"],
 *   ephemeral?: boolean
 * }} ThreadRuntimeOptions
 * @typedef {{
 *   message?: string,
 *   phase?: string | null,
 *   stderrMessage?: string | null,
 *   logTitle?: string | null,
 *   logBody?: string | null
 * }} ProgressEvent
 * @typedef {{
 *   threadName?: string | null,
 *   name?: string | null,
 *   agentNickname?: string | null,
 *   agentRole?: string | null
 * }} ThreadLabelOptions
 * @typedef {{
 *   threadId: string,
 *   rootThreadId: string,
 *   threadIds: Set<string>,
 *   threadTurnIds: Map<string, string>,
 *   threadLabels: Map<string, string>,
 *   turnId: string | null,
 *   bufferedNotifications: AppServerNotification[],
 *   completion: Promise<TurnCaptureState>,
 *   resolveCompletion: (state: TurnCaptureState) => void,
 *   rejectCompletion: (error: unknown) => void,
 *   finalTurn: CapturedTurn | null,
 *   completed: boolean,
 *   finalAnswerSeen: boolean,
 *   pendingCollaborations: Set<string>,
 *   activeSubagentTurns: Set<string>,
 *   completionTimer: ReturnType<typeof setTimeout> | null,
 *   completionConfirmationActive: boolean,
 *   confirmCompletion: (() => Promise<void>) | null,
 *   lastAgentMessage: string,
 *   reviewText: string,
 *   reasoningSummary: string[],
 *   error: unknown,
 *   messages: Array<{ lifecycle: string, phase: string | null, text: string }>,
 *   fileChanges: ThreadItem[],
 *   commandExecutions: ThreadItem[],
 *   onProgress: ProgressReporter | null
 * }} TurnCaptureState
 *
 * @typedef {{
 *   onProgress?: ProgressReporter | null,
 *   onResponse?: (response: TurnResponse, state: TurnCaptureState) => void,
 *   onActiveTurn?: (activeTurn: {
 *     threadId: string,
 *     turnId: string,
 *     steer: (request: { requestId: string, instruction: string }) => Promise<{ threadId: string, turnId: string }>
 *   }) => Promise<(() => Promise<void> | void) | null | undefined>
 * }} CaptureTurnOptions
 * @typedef {ThreadRuntimeOptions & { threadName?: string | null }} StartThreadOptions
 * @typedef {{
 *   onProgress?: ProgressReporter | null,
 *   model?: string | null,
 *   threadName?: string | null,
 *   delivery?: "inline" | "detached",
 *   target?: ReviewTarget
 * }} ReviewRunOptions
 * @typedef {{ onProgress?: ProgressReporter | null, sourcePath?: string }} ImportSessionOptions
 * @typedef {{
 *   onProgress?: ProgressReporter | null,
 *   onActiveTurn?: CaptureTurnOptions["onActiveTurn"],
 *   resumeThreadId?: string | null,
 *   model?: string | null,
 *   sandbox?: ThreadStartParams["sandbox"],
 *   persistThread?: boolean,
 *   threadName?: string | null,
 *   prompt?: string,
 *   defaultPrompt?: string,
 *   effort?: string | null,
 *   outputSchema?: unknown
 * }} TurnRunOptions
 * @typedef {{
 *   loggedIn?: boolean,
 *   detail?: string,
 *   source?: string,
 *   authMethod?: string | null,
 *   verified?: boolean | null,
 *   requiresOpenaiAuth?: boolean | null,
 *   provider?: string | null
 * }} AuthStatusFields
 * @typedef {{
 *   request: AppServerClient["request"],
 *   close: AppServerClient["close"]
 * }} AuthStatusClient
 * @typedef {{
 *   env?: NodeJS.ProcessEnv,
 *   availabilityImpl?: typeof getCodexAvailability,
 *   connectImpl?: (cwd: string, options: { env?: NodeJS.ProcessEnv }) => Promise<AuthStatusClient>
 * }} AuthStatusOptions
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { readJsonFile } from "./fs.mjs";
import {
  AppServerRequestError,
  CodexAppServerClient
} from "./app-server.mjs";
import { binaryAvailable, runCommand } from "./process.mjs";
import {
  MINIMUM_CODEX_VERSION,
  requireMinimumVersion
} from "./version-support.mjs";
import {
  EXTERNAL_AGENT_IMPORT_TIMEOUT_MS,
  TURN_COMPLETION_CONFIRM_DELAY_MS,
  TURN_COMPLETION_CONFIRM_POLL_MS,
  TURN_COMPLETION_CONFIRM_TIMEOUT_MS
} from "./runtime-config.mjs";

const SERVICE_NAME = "claude_code_codex_plugin";
const TASK_THREAD_PREFIX = "Codex Companion Task";
const DEFAULT_CONTINUE_PROMPT =
  "Continue from the current thread state. Pick the next highest-value step and follow through until the task is resolved.";
const EXTERNAL_AGENT_IMPORT_COMPLETED = "externalAgentConfig/import/completed";

/** @param {unknown} value @returns {value is UnknownRecord} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @param {string} key */
function readStringProperty(value, key) {
  if (!isRecord(value)) {
    return null;
  }
  return typeof value[key] === "string" ? value[key] : null;
}

/** @param {unknown} value @param {string} key */
function readRecordProperty(value, key) {
  if (!isRecord(value)) {
    return null;
  }
  return isRecord(value[key]) ? value[key] : null;
}

/** @param {string} stderr */
function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

/** @param {string} cwd @param {ThreadRuntimeOptions} [options] @returns {ThreadStartParams} */
function buildThreadParams(cwd, options = {}) {
  return {
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only",
    serviceName: SERVICE_NAME,
    ephemeral: options.ephemeral ?? true
  };
}

/** @param {string} threadId @param {string} cwd @param {ThreadRuntimeOptions} [options] @returns {ThreadResumeParams} */
function buildResumeParams(threadId, cwd, options = {}) {
  return {
    threadId,
    cwd,
    model: options.model ?? null,
    approvalPolicy: options.approvalPolicy ?? "never",
    sandbox: options.sandbox ?? "read-only"
  };
}

/** @param {string} prompt @returns {UserInput[]} */
function buildTurnInput(prompt) {
  return [{ type: "text", text: prompt, text_elements: [] }];
}

/** @param {unknown} text @param {number} [limit] */
function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

/** @param {string} command */
function looksLikeVerificationCommand(command) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    command
  );
}

/** @param {string} prompt */
function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

/** @param {AppServerNotification} message */
function extractThreadId(message) {
  return readStringProperty(message.params, "threadId");
}

/** @param {AppServerNotification} message */
function extractTurnId(message) {
  const turnId = readStringProperty(message.params, "turnId");
  if (turnId) {
    return turnId;
  }
  const turn = readRecordProperty(message.params, "turn");
  const nestedTurnId = readStringProperty(turn, "id");
  if (nestedTurnId) {
    return nestedTurnId;
  }
  return null;
}

/** @param {ThreadItem[]} fileChanges */
function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    if (fileChange.type !== "fileChange") {
      continue;
    }
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

/** @param {unknown} text */
function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/** @param {unknown} value @returns {string[]} */
function extractReasoningSections(value) {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }

  if (isRecord(value)) {
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }

  return [];
}

/** @param {string[]} existingSections @param {string[]} nextSections */
function mergeReasoningSections(existingSections, nextSections) {
  /** @type {string[]} */
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

/**
 * @param {ProgressReporter | null | undefined} onProgress
 * @param {string | null | undefined} message
 * @param {string | null | undefined} [phase]
 */
function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  if (!phase && Object.keys(extra).length === 0) {
    onProgress(message);
    return;
  }
  onProgress({ message, phase, ...extra });
}

/** @param {ProgressReporter | null | undefined} onProgress @param {ProgressEvent} [options] */
function emitLogEvent(onProgress, options = {}) {
  if (!onProgress) {
    return;
  }

  onProgress({
    message: options.message ?? "",
    phase: options.phase ?? null,
    stderrMessage: options.stderrMessage ?? null,
    logTitle: options.logTitle ?? null,
    logBody: options.logBody ?? null
  });
}

/** @param {TurnCaptureState} state @param {string | null | undefined} threadId */
function labelForThread(state, threadId) {
  if (!threadId || threadId === state.rootThreadId || threadId === state.threadId) {
    return null;
  }
  return state.threadLabels.get(threadId) ?? threadId;
}

/** @param {TurnCaptureState} state @param {string} threadId @param {ThreadLabelOptions} [options] */
function registerThread(state, threadId, options = {}) {
  if (!threadId) {
    return;
  }

  state.threadIds.add(threadId);
  const label =
    options.threadName ??
    options.name ??
    options.agentNickname ??
    options.agentRole ??
    state.threadLabels.get(threadId) ??
    null;
  if (label) {
    state.threadLabels.set(threadId, label);
  }
}

/** @param {TurnCaptureState} state @param {ThreadItem} item */
function describeStartedItem(state, item) {
  switch (item.type) {
    case "enteredReviewMode":
      return { message: `Reviewer started: ${item.review}`, phase: "reviewing" };
    case "commandExecution":
      return {
        message: `Running command: ${shorten(item.command, 96)}`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Starting subagent ${subagents.join(", ")} via collaboration tool: ${item.tool}.`
          : `Starting collaboration tool: ${item.tool}.`;
      return { message: summary, phase: "investigating" };
    }
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

/** @param {TurnCaptureState} state @param {ThreadItem} item */
function describeCompletedItem(state, item) {
  switch (item.type) {
    case "commandExecution": {
      const exitCode = item.exitCode ?? "?";
      const statusLabel = item.status === "completed" ? "completed" : item.status;
      return {
        message: `Command ${statusLabel}: ${shorten(item.command, 96)} (exit ${exitCode})`,
        phase: looksLikeVerificationCommand(item.command) ? "verifying" : "running"
      };
    }
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    case "collabAgentToolCall": {
      const subagents = (item.receiverThreadIds ?? []).map((threadId) => labelForThread(state, threadId) ?? threadId);
      const summary =
        subagents.length > 0
          ? `Subagent ${subagents.join(", ")} ${item.status}.`
          : `Collaboration tool ${item.tool} ${item.status}.`;
      return { message: summary, phase: "investigating" };
    }
    case "exitedReviewMode":
      return { message: "Reviewer finished.", phase: "finalizing" };
    default:
      return null;
  }
}

/** @param {string} threadId @param {{ onProgress?: ProgressReporter | null }} [options] @returns {TurnCaptureState} */
function createTurnCaptureState(threadId, options = {}) {
  /** @type {(state: TurnCaptureState) => void} */
  let resolveCompletion = () => {};
  /** @type {(error: unknown) => void} */
  let rejectCompletion = () => {};
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    threadLabels: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    completionConfirmationActive: false,
    confirmCompletion: null,
    lastAgentMessage: "",
    reviewText: "",
    reasoningSummary: [],
    error: null,
    messages: [],
    fileChanges: [],
    commandExecutions: [],
    onProgress: options.onProgress ?? null
  };
}

/** @param {TurnCaptureState} state */
function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

/** @param {TurnCaptureState} state @param {CapturedTurn} turn */
function completeTurn(state, turn) {
  if (state.completed) {
    return;
  }

  clearCompletionTimer(state);
  state.completed = true;

  state.finalTurn = turn;
  if (!state.turnId) {
    state.turnId = turn.id;
  }

  state.resolveCompletion(state);
}

/** @param {number} delayMs */
function waitForTurnConfirmation(delayMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

/**
 * @param {AppServerClient} client
 * @param {TurnCaptureState} state
 * @param {number} timeoutMs
 */
async function readAuthoritativeTurn(client, state, timeoutMs) {
  let timeout = null;
  /** @type {Promise<never>} */
  const deadline = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(
        new AppServerRequestError(
          `Timed out while reading authoritative state for turn ${state.turnId}.`
        )
      );
    }, timeoutMs);
    timeout.unref?.();
  });

  try {
    const response = await Promise.race([
      client.request("thread/read", {
        threadId: state.threadId,
        includeTurns: true
      }),
      deadline
    ]);
    return response.thread.turns.find((turn) => turn.id === state.turnId) ?? null;
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
  }
}

/** @param {AppServerClient} client @param {TurnCaptureState} state */
async function confirmTerminalTurn(client, state) {
  const deadline = Date.now() + TURN_COMPLETION_CONFIRM_TIMEOUT_MS;
  let lastObservedStatus = "missing";

  while (!state.completed && Date.now() < deadline) {
    if (
      state.pendingCollaborations.size === 0 &&
      state.activeSubagentTurns.size === 0
    ) {
      const turn = await readAuthoritativeTurn(
        client,
        state,
        Math.max(1, deadline - Date.now())
      );
      lastObservedStatus = turn?.status ?? "missing";
      if (turn && turn.status !== "inProgress") {
        emitProgress(
          state.onProgress,
          `Turn ${turn.status} confirmed by thread/read.`,
          "finalizing"
        );
        completeTurn(state, turn);
        return;
      }
    }

    await waitForTurnConfirmation(
      Math.min(TURN_COMPLETION_CONFIRM_POLL_MS, Math.max(1, deadline - Date.now()))
    );
  }

  if (!state.completed) {
    throw new AppServerRequestError(
      `Codex did not confirm a terminal state for turn ${state.turnId} within ${TURN_COMPLETION_CONFIRM_TIMEOUT_MS}ms (last observed: ${lastObservedStatus}).`
    );
  }
}

/** @param {TurnCaptureState} state */
function scheduleCompletionConfirmation(state) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }

  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }

  if (state.completionTimer || state.completionConfirmationActive) {
    return;
  }
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    state.completionConfirmationActive = true;
    void state.confirmCompletion?.().catch((error) => {
      if (!state.completed) {
        state.rejectCompletion(error);
      }
    });
  }, TURN_COMPLETION_CONFIRM_DELAY_MS);
  state.completionTimer.unref?.();
}

/** @param {TurnCaptureState} state @param {AppServerNotification} message */
function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

/** @param {TurnCaptureState} state @param {ThreadItem} item @param {string} lifecycle @param {string | null} [threadId] */
function recordItem(state, item, lifecycle, threadId = null) {
  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
        scheduleCompletionConfirmation(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      registerThread(state, receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    state.messages.push({
      lifecycle,
      phase: item.phase ?? null,
      text: item.text ?? ""
    });
    if (item.text) {
      if (!threadId || threadId === state.threadId) {
        state.lastAgentMessage = item.text;
        if (lifecycle === "completed" && item.phase === "final_answer") {
          state.finalAnswerSeen = true;
          scheduleCompletionConfirmation(state);
        }
      }
      if (lifecycle === "completed") {
        const sourceLabel = labelForThread(state, threadId);
        emitLogEvent(state.onProgress, {
          message: sourceLabel ? `Subagent ${sourceLabel}: ${shorten(item.text, 96)}` : `Assistant message captured: ${shorten(item.text, 96)}`,
          stderrMessage: null,
          phase: item.phase === "final_answer" ? "finalizing" : null,
          logTitle: sourceLabel ? `Subagent ${sourceLabel} message` : "Assistant message",
          logBody: item.text
        });
      }
    }
    return;
  }

  if (item.type === "exitedReviewMode") {
    state.reviewText = item.review ?? "";
    if (lifecycle === "completed" && item.review) {
      emitLogEvent(state.onProgress, {
        message: "Review output captured.",
        stderrMessage: null,
        phase: "finalizing",
        logTitle: "Review output",
        logBody: item.review
      });
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    const nextSections = extractReasoningSections(item.summary);
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, nextSections);
    if (nextSections.length > 0) {
      const sourceLabel = labelForThread(state, threadId);
      emitLogEvent(state.onProgress, {
        message: sourceLabel
          ? `Subagent ${sourceLabel} reasoning: ${shorten(nextSections[0], 96)}`
          : `Reasoning summary captured: ${shorten(nextSections[0], 96)}`,
        stderrMessage: null,
        logTitle: sourceLabel ? `Subagent ${sourceLabel} reasoning summary` : "Reasoning summary",
        logBody: nextSections.map((section) => `- ${section}`).join("\n")
      });
    }
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

/** @param {TurnCaptureState} state @param {AppServerNotification} message */
function applyTurnNotification(state, message) {
  switch (message.method) {
    case "thread/started":
      registerThread(state, message.params.thread.id, {
        threadName: message.params.thread.name,
        name: message.params.thread.name,
        agentNickname: message.params.thread.agentNickname,
        agentRole: message.params.thread.agentRole
      });
      break;
    case "thread/name/updated":
      registerThread(state, message.params.threadId, {
        threadName: message.params.threadName ?? null
      });
      break;
    case "turn/started":
      registerThread(state, message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(
        state.onProgress,
        `Turn started (${message.params.turn.id}).`,
        "starting",
        (message.params.threadId ?? null) === state.threadId
          ? {
              threadId: message.params.threadId ?? null,
              turnId: message.params.turn.id ?? null
            }
          : {}
      );
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(state, message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "error":
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleCompletionConfirmation(state);
        break;
      }
      emitProgress(
        state.onProgress,
        `Turn ${message.params.turn.status === "completed" ? "completed" : message.params.turn.status}.`,
        "finalizing"
      );
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

/**
 * @param {AppServerClient} client
 * @param {string} threadId
 * @param {() => Promise<TurnResponse>} startRequest
 * @param {CaptureTurnOptions} [options]
 */
async function captureTurn(client, threadId, startRequest, options = {}) {
  const state = createTurnCaptureState(threadId, options);
  state.confirmCompletion = () => confirmTerminalTurn(client, state);
  const previousHandler = client.notificationHandler;
  let deactivateActiveTurn = null;

  client.setNotificationHandler(
    /** @param {AppServerNotification} message */ (message) => {
      if (!state.turnId) {
        state.bufferedNotifications.push(message);
        return;
      }

      if (
        message.method === "thread/started" ||
        message.method === "thread/name/updated"
      ) {
        applyTurnNotification(state, message);
        return;
      }

      if (!belongsToTurn(state, message)) {
        if (previousHandler) {
          previousHandler(message);
        }
        return;
      }

      applyTurnNotification(state, message);
    }
  );

  try {
    const response = await startRequest();
    options.onResponse?.(response, state);
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
    }
    for (const message of state.bufferedNotifications) {
      if (belongsToTurn(state, message)) {
        applyTurnNotification(state, message);
      } else {
        if (previousHandler) {
          previousHandler(message);
        }
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    if (!state.completed && state.turnId && options.onActiveTurn) {
      const activeThreadId = state.threadId;
      const activeTurnId = state.turnId;
      deactivateActiveTurn = await options.onActiveTurn({
        threadId: activeThreadId,
        turnId: activeTurnId,
        steer: async ({ requestId, instruction }) => {
          if (state.completed) {
            throw new Error(`Turn ${activeTurnId} is no longer active.`);
          }
          const steerResponse = await client.request("turn/steer", {
            threadId: activeThreadId,
            input: buildTurnInput(instruction),
            expectedTurnId: activeTurnId,
            clientUserMessageId: requestId
          });
          if (
            typeof steerResponse.turnId !== "string" ||
            !steerResponse.turnId.trim()
          ) {
            throw new AppServerRequestError(
              "Codex returned a malformed turn/steer acknowledgement."
            );
          }
          if (steerResponse.turnId !== activeTurnId) {
            throw new AppServerRequestError(
              `Codex acknowledged turn ${steerResponse.turnId}, expected ${activeTurnId}.`
            );
          }
          return {
            threadId: activeThreadId,
            turnId: steerResponse.turnId
          };
        }
      });
    }

    /** @type {Promise<TurnCaptureState>} */
    const controlledExit = client.waitForExit().then(() => {
      throw new Error("Codex app-server exited before the turn completed.");
    });
    return await Promise.race([state.completion, controlledExit]);
  } finally {
    try {
      await deactivateActiveTurn?.();
    } finally {
      clearCompletionTimer(state);
      client.setNotificationHandler(previousHandler ?? null);
    }
  }
}

/**
 * @template T
 * @param {string} cwd
 * @param {(client: AppServerClient) => Promise<T>} fn
 * @param {(clientCwd: string) => Promise<AppServerClient>} [connectImpl]
 * @returns {Promise<T>}
 */
export async function withAppServer(
  cwd,
  fn,
  connectImpl = (clientCwd) => CodexAppServerClient.connect(clientCwd)
) {
  const client = await connectImpl(cwd);
  /** @type {{ ok: true, value: T } | { ok: false, error: unknown }} */
  let outcome;
  try {
    outcome = { ok: true, value: await fn(client) };
  } catch (error) {
    outcome = { ok: false, error };
  }

  try {
    await client.close();
  } catch (closeError) {
    if (!outcome.ok) {
      throw new AggregateError(
        [outcome.error, closeError],
        "Codex app-server operation failed and its process could not be closed."
      );
    }
    throw closeError;
  }

  if (!outcome.ok) {
    throw outcome.error;
  }
  return outcome.value;
}

function resolveCodexHome() {
  return path.resolve(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

/** @param {string} sourcePath */
function sourceContentSha256(sourcePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(sourcePath)).digest("hex");
}

/** @param {string} sourcePath */
function importedThreadIdForSource(sourcePath) {
  const ledgerPath = path.join(resolveCodexHome(), "external_agent_session_imports.json");
  if (!fs.existsSync(ledgerPath)) {
    return null;
  }
  const ledger = readJsonFile(ledgerPath);
  const canonicalSource = fs.realpathSync(sourcePath);
  const contentSha256 = sourceContentSha256(canonicalSource);
  const records = isRecord(ledger) && Array.isArray(ledger.records)
    ? ledger.records
    : [];
  const match = records
    .filter(
      (record) =>
        isRecord(record) &&
        record.source_path === canonicalSource &&
        record.content_sha256 === contentSha256 &&
        typeof record.imported_thread_id === "string"
    )
    .at(-1);
  return isRecord(match) && typeof match.imported_thread_id === "string"
    ? match.imported_thread_id
    : null;
}

/** @param {string} sourcePath @param {string} cwd @returns {ExternalAgentConfigImportParams} */
function externalAgentSessionMigration(sourcePath, cwd) {
  return {
    migrationItems: [
      {
        itemType: "SESSIONS",
        description: `Transfer Claude session ${path.basename(sourcePath)}`,
        cwd: null,
        details: {
          plugins: [],
          skills: [],
          sessions: [{ path: sourcePath, cwd, title: null }],
          mcpServers: [],
          hooks: [],
          subagents: [],
          commands: []
        }
      }
    ]
  };
}

/**
 * @param {AppServerClient} client
 * @param {ExternalAgentConfigImportParams} params
 * @param {number} [timeoutMs]
 */
export async function requestExternalAgentSessionImport(
  client,
  params,
  timeoutMs = EXTERNAL_AGENT_IMPORT_TIMEOUT_MS
) {
  const previousHandler = client.notificationHandler;
  let timeout = null;
  /** @type {() => void} */
  let resolveCompleted = () => {};
  /** @type {Promise<void>} */
  const completed = new Promise((resolve) => {
    resolveCompleted = resolve;
  });
  const deadline = new Promise((resolve, reject) => {
    timeout = setTimeout(() => {
      reject(new Error("Timed out while importing the Claude session into Codex."));
    }, timeoutMs);
  });

  client.setNotificationHandler(
    /** @param {AppServerNotification} message */ (message) => {
      if (message.method === EXTERNAL_AGENT_IMPORT_COMPLETED) {
        resolveCompleted();
        return;
      }
      previousHandler?.(message);
    }
  );

  try {
    await Promise.race([
      Promise.all([
        client.request("externalAgentConfig/import", params),
        completed
      ]),
      deadline
    ]);
  } finally {
    if (timeout !== null) {
      clearTimeout(timeout);
    }
    client.setNotificationHandler(previousHandler ?? null);
  }
}

/** @param {AppServerClient} client @param {string} cwd @param {StartThreadOptions} [options] */
async function startThread(client, cwd, options = {}) {
  const response = await client.request("thread/start", buildThreadParams(cwd, options));
  const threadId = response.thread.id;
  if (options.threadName) {
    try {
      await client.request("thread/name/set", { threadId, name: options.threadName });
    } catch (err) {
      // Only suppress "unknown variant/method" errors from older CLI versions
      // that don't support thread/name/set. Rethrow auth, network, or server errors.
      const msg = err instanceof Error ? err.message : String(err ?? "");
      if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
        throw err;
      }
    }
  }
  return response;
}

/** @param {AppServerClient} client @param {string} threadId @param {string} cwd @param {ThreadRuntimeOptions} [options] */
async function resumeThread(client, threadId, cwd, options = {}) {
  return client.request("thread/resume", buildResumeParams(threadId, cwd, options));
}

/** @param {TurnCaptureState} turnState */
function buildResultStatus(turnState) {
  return turnState.finalTurn?.status === "completed" ? 0 : 1;
}

const BUILTIN_PROVIDER_LABELS = new Map([
  ["openai", "OpenAI"],
  ["ollama", "Ollama"],
  ["lmstudio", "LM Studio"]
]);

/** @param {unknown} value */
function normalizeProviderId(value) {
  const providerId = typeof value === "string" ? value.trim() : "";
  return providerId || null;
}

/** @param {string | null} providerId @param {UnknownRecord | null} [providerConfig] */
function formatProviderLabel(providerId, providerConfig = null) {
  const configuredName = typeof providerConfig?.name === "string" ? providerConfig.name.trim() : "";
  if (configuredName) {
    return configuredName;
  }
  if (!providerId) {
    return "The active provider";
  }
  return BUILTIN_PROVIDER_LABELS.get(providerId) ?? providerId;
}

/** @param {AuthStatusFields} [fields] */
function buildAuthStatus(fields = {}) {
  return {
    available: true,
    loggedIn: false,
    detail: "not authenticated",
    source: "unknown",
    authMethod: null,
    verified: null,
    requiresOpenaiAuth: null,
    provider: null,
    ...fields
  };
}

/** @param {unknown} configResponse */
function resolveProviderConfig(configResponse) {
  const config = isRecord(configResponse) ? configResponse.config : null;
  if (!isRecord(config)) {
    return {
      providerId: null,
      providerConfig: null
    };
  }

  const providerId = normalizeProviderId(config.model_provider);
  const providers = isRecord(config.model_providers)
    ? config.model_providers
    : null;
  const providerConfig =
    providerId && providers && isRecord(providers[providerId])
      ? providers[providerId]
      : null;

  return {
    providerId,
    providerConfig
  };
}

/** @param {unknown} accountResponse @param {unknown} configResponse */
function buildAppServerAuthStatus(accountResponse, configResponse) {
  const response = isRecord(accountResponse) ? accountResponse : {};
  const account = isRecord(response.account) ? response.account : null;
  const requiresOpenaiAuth =
    typeof response.requiresOpenaiAuth === "boolean"
      ? response.requiresOpenaiAuth
      : null;
  const { providerId, providerConfig } = resolveProviderConfig(configResponse);
  const providerLabel = formatProviderLabel(providerId, providerConfig);

  if (account?.type === "chatgpt") {
    const email = typeof account.email === "string" && account.email.trim() ? account.email.trim() : null;
    return buildAuthStatus({
      loggedIn: true,
      detail: email ? `ChatGPT login active for ${email}` : "ChatGPT login active",
      source: "app-server",
      authMethod: "chatgpt",
      verified: true,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (account?.type === "apiKey") {
    return buildAuthStatus({
      loggedIn: true,
      detail: "API key configured (unverified)",
      source: "app-server",
      authMethod: "apiKey",
      verified: false,
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  if (requiresOpenaiAuth === false) {
    return buildAuthStatus({
      loggedIn: true,
      detail: `${providerLabel} is configured and does not require OpenAI authentication`,
      source: "app-server",
      requiresOpenaiAuth,
      provider: providerId
    });
  }

  return buildAuthStatus({
    loggedIn: false,
    detail: `${providerLabel} requires OpenAI authentication`,
    source: "app-server",
    requiresOpenaiAuth,
    provider: providerId
  });
}

/** @param {AuthStatusClient} client @param {string} cwd */
async function getCodexAuthStatusFromClient(client, cwd) {
  try {
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const configResponse = await client.request("config/read", {
      includeLayers: false,
      cwd
    });

    return buildAppServerAuthStatus(accountResponse, configResponse);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  }
}

/** @param {string} cwd */
export function getCodexAvailability(cwd) {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }
  const supportedVersion = requireMinimumVersion(
    "Codex",
    versionStatus.detail,
    MINIMUM_CODEX_VERSION
  );
  if (!supportedVersion.available) {
    return supportedVersion;
  }

  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; advanced runtime unavailable: ${appServerStatus.detail}`
    };
  }

  const schemaDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-plugin-schema-"));
  try {
    const generated = runCommand(
      "codex",
      ["app-server", "generate-ts", "--out", schemaDirectory],
      { cwd }
    );
    const paramsPath = path.join(schemaDirectory, "v2", "TurnSteerParams.ts");
    const responsePath = path.join(schemaDirectory, "v2", "TurnSteerResponse.ts");
    const threadReadParamsPath = path.join(
      schemaDirectory,
      "v2",
      "ThreadReadParams.ts"
    );
    const threadReadResponsePath = path.join(
      schemaDirectory,
      "v2",
      "ThreadReadResponse.ts"
    );
    const params = fs.existsSync(paramsPath) ? fs.readFileSync(paramsPath, "utf8") : "";
    const response = fs.existsSync(responsePath) ? fs.readFileSync(responsePath, "utf8") : "";
    const threadReadParams = fs.existsSync(threadReadParamsPath)
      ? fs.readFileSync(threadReadParamsPath, "utf8")
      : "";
    const threadReadResponse = fs.existsSync(threadReadResponsePath)
      ? fs.readFileSync(threadReadResponsePath, "utf8")
      : "";
    const missingCapabilities = [
      ...(!params.includes("expectedTurnId") ||
      !response.includes("turnId")
        ? ["turn/steer"]
        : []),
      ...(!threadReadParams.includes("includeTurns") ||
      !threadReadResponse.includes("Thread")
        ? ["thread/read"]
        : [])
    ];
    if (
      generated.error ||
      generated.status !== 0 ||
      generated.signal ||
      missingCapabilities.length > 0
    ) {
      const detail =
        generated.error?.message ||
        generated.stderr.trim() ||
        generated.stdout.trim() ||
        "generated turn/steer or thread/read schema is missing";
      const unavailable = missingCapabilities.length > 0
        ? missingCapabilities
            .map((capability) => `${capability} capability unavailable`)
            .join("; ")
        : "app-server schema generation unavailable";
      return {
        available: false,
        detail: `${supportedVersion.detail}; required ${unavailable}: ${detail}`
      };
    }
  } finally {
    fs.rmSync(schemaDirectory, { recursive: true, force: true });
  }

  return {
    available: true,
    detail: `${supportedVersion.detail}; advanced runtime, turn/steer, and thread/read available`
  };
}

export function getSessionRuntimeStatus() {
  return {
    mode: "direct",
    label: "direct process per invocation",
    detail: "Each review or task owns and closes its own Codex runtime.",
    endpoint: null
  };
}

/** @param {string} cwd @param {AuthStatusOptions} [options] */
export async function getCodexAuthStatus(cwd, options = {}) {
  const availabilityImpl = options.availabilityImpl ?? getCodexAvailability;
  const connectImpl =
    options.connectImpl ??
    ((clientCwd, clientOptions) => CodexAppServerClient.connect(clientCwd, clientOptions));
  const availability = availabilityImpl(cwd);
  if (!availability.available) {
    return {
      available: false,
      loggedIn: false,
      detail: availability.detail,
      source: "availability",
      authMethod: null,
      verified: null,
      requiresOpenaiAuth: null,
      provider: null
    };
  }

  /** @type {AuthStatusClient | null} */
  let client = null;
  try {
    client = await connectImpl(cwd, {
      env: options.env
    });
    return await getCodexAuthStatusFromClient(client, cwd);
  } catch (error) {
    return buildAuthStatus({
      loggedIn: false,
      detail: error instanceof Error ? error.message : String(error),
      source: "app-server"
    });
  } finally {
    if (client) {
      await client.close();
    }
  }
}

/** @param {string} cwd @param {ReviewRunOptions} options */
export async function runAppServerReview(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
  if (!options.target) {
    throw new Error("A review target is required.");
  }
  const target = options.target;

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Starting Codex review thread.", "starting");
    const thread = await startThread(client, cwd, {
      model: options.model,
      sandbox: "read-only",
      ephemeral: true,
      threadName: options.threadName
    });
    const sourceThreadId = thread.thread.id;
    emitProgress(options.onProgress, `Thread ready (${sourceThreadId}).`, "starting", {
      threadId: sourceThreadId
    });
    const delivery = options.delivery ?? "inline";

    const turnState = await captureTurn(
      client,
      sourceThreadId,
      () =>
        client.request("review/start", {
          threadId: sourceThreadId,
          delivery,
          target
        }),
      {
        onProgress: options.onProgress,
        onResponse(response, state) {
          if (response.reviewThreadId) {
            state.threadIds.add(response.reviewThreadId);
            if (delivery === "detached") {
              state.threadId = response.reviewThreadId;
            }
          }
        }
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId: turnState.threadId,
      sourceThreadId,
      turnId: turnState.turnId,
      reviewText: turnState.reviewText,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

/** @param {string} cwd @param {ImportSessionOptions} options */
export async function importExternalAgentSession(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
  if (!options.sourcePath) {
    throw new Error("A Claude session source path is required.");
  }
  const sourcePath = options.sourcePath;

  return withAppServer(cwd, async (client) => {
    emitProgress(options.onProgress, "Importing Claude session into Codex.", "transferring");
    try {
      await requestExternalAgentSessionImport(client, externalAgentSessionMigration(sourcePath, cwd));
    } catch (error) {
      if (
        isRecord(error) &&
        error.rpcCode === -32601
      ) {
        throw new Error(
          "This Codex version does not support Claude session transfer. Update Codex with `npm install -g @openai/codex@latest`, then retry.",
          { cause: error }
        );
      }
      throw error;
    }
    const threadId = importedThreadIdForSource(sourcePath);
    if (!threadId) {
      const stderr = cleanCodexStderr(client.stderr);
      throw new Error(
        `Codex reported that the Claude import completed, but did not record an imported thread.${stderr ? `\n${stderr}` : " Check the Codex app-server logs for the underlying import error."}`
      );
    }
    emitProgress(options.onProgress, `Claude session imported (${threadId}).`, "completed", { threadId });
    return {
      threadId,
      stderr: cleanCodexStderr(client.stderr)
    };
  });
}

/** @param {string} cwd @param {TurnRunOptions} [options] */
export async function runAppServerTurn(cwd, options = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    let threadId;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await resumeThread(client, options.resumeThreadId, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: false
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await startThread(client, cwd, {
        model: options.model,
        sandbox: options.sandbox,
        ephemeral: options.persistThread ? false : true,
        threadName: options.persistThread ? options.threadName : options.threadName ?? null
      });
      threadId = response.thread.id;
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", {
      threadId
    });

    const prompt = options.prompt?.trim() || options.defaultPrompt || "";
    if (!prompt) {
      throw new Error("A prompt is required for this Codex run.");
    }

    const turnState = await captureTurn(
      client,
      threadId,
      () =>
        client.request("turn/start", {
          threadId,
          input: buildTurnInput(prompt),
          model: options.model ?? null,
          effort: options.effort ?? null,
          outputSchema: options.outputSchema ?? null
        }),
      {
        onProgress: options.onProgress,
        onActiveTurn: options.onActiveTurn
      }
    );

    return {
      status: buildResultStatus(turnState),
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      commandExecutions: turnState.commandExecutions
    };
  });
}

/** @param {string} cwd */
export async function findLatestTaskThread(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }

  return withAppServer(cwd, async (client) => {
    const response = await client.request("thread/list", {
      cwd,
      limit: 20,
      sortKey: "updated_at",
      sourceKinds: ["appServer"],
      searchTerm: TASK_THREAD_PREFIX
    });

    return (
      response.data.find((thread) => typeof thread.name === "string" && thread.name.startsWith(TASK_THREAD_PREFIX)) ??
      null
    );
  });
}

/** @param {string} prompt */
export function buildPersistentTaskThreadName(prompt) {
  return buildTaskThreadName(prompt);
}

/** @param {string} rawOutput @param {{ failureMessage?: string, [key: string]: unknown }} [fallback] */
export function parseStructuredOutput(rawOutput, fallback = {}) {
  if (!rawOutput) {
    return {
      parsed: null,
      parseError: fallback.failureMessage ?? "Codex did not return a final structured message.",
      rawOutput: rawOutput ?? "",
      ...fallback
    };
  }

  try {
    return {
      parsed: JSON.parse(rawOutput),
      parseError: null,
      rawOutput,
      ...fallback
    };
  } catch (error) {
    return {
      parsed: null,
      parseError: error instanceof Error ? error.message : String(error),
      rawOutput,
      ...fallback
    };
  }
}

/** @param {string} schemaPath */
export function readOutputSchema(schemaPath) {
  return readJsonFile(schemaPath);
}

export { DEFAULT_CONTINUE_PROMPT, TASK_THREAD_PREFIX };
