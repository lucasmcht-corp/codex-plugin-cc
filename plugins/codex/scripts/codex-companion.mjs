#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  parseArgs,
  splitRawArgumentString,
  tokenizeRawArgumentString
} from "./lib/args.mjs";
import {
  buildPersistentTaskThreadName,
  DEFAULT_CONTINUE_PROMPT,
  findLatestTaskThread,
  getCodexAuthStatus,
  getCodexAvailability,
  getSessionRuntimeStatus,
  importExternalAgentSession,
  parseStructuredOutput,
  readOutputSchema,
  runAppServerReview,
  runAppServerTurn
} from "./lib/codex.mjs";
import { resolveClaudeSessionPath } from "./lib/claude-session-transfer.mjs";
import { readStdinIfPiped } from "./lib/fs.mjs";
import { collectReviewContext, ensureGitRepository, resolveReviewTarget } from "./lib/git.mjs";
import { isActiveJobStatus, sameOwnedWorkerGeneration } from "./lib/job-lifecycle.mjs";
import {
  assertOwnedWorkerPlatformSupported,
  binaryAvailable,
  captureOwnedWorkerIdentity,
  createOwnedWorkerLaunch,
  installBoundedWorkerTermination,
  inspectProcessIdentity,
  inspectOwnedWorker,
  stopOwnedWorkerTree
} from "./lib/process.mjs";
import { loadPromptTemplate, interpolateTemplate } from "./lib/prompts.mjs";
import { loadRuntimeConfig } from "./lib/runtime-config.mjs";
import { reconcileWorkspaceJobs } from "./lib/session-cleanup.mjs";
import {
  createJobIfSessionActive,
  generateJobId,
  getConfig,
  listJobs,
  mutateJobIf,
  setConfig,
  upsertJob
} from "./lib/state.mjs";
import {
  buildSingleJobSnapshot,
  buildStatusSnapshot,
  readStoredJob,
  readStoredSessionJob,
  resolveCancelableJob,
  resolveResultJob,
  resolveSessionJob,
  sortJobsNewestFirst
} from "./lib/job-control.mjs";
import {
  appendLogLine,
  createJobLogFile,
  createJobProgressUpdater,
  createJobRecord,
  createProgressReporter,
  nowIso,
  removeUnpublishedJobLog,
  runTrackedJob,
  SESSION_ID_ENV
} from "./lib/tracked-jobs.mjs";
import {
  assertSteeringDescriptor,
  cleanupSteeringEndpoint,
  createSteeringRequestId,
  deliverSteeringRequest,
  openSteeringServer,
  resolveNativeSteer
} from "./lib/steering-channel.mjs";
import {
  cleanupFailedWorkerLaunch,
  recordSpawnedWorker,
  waitForWorkerClaim
} from "./lib/worker-claim.mjs";
import { resolveWorkspaceRoot } from "./lib/workspace.mjs";
import {
  MINIMUM_CLAUDE_CODE_VERSION,
  requireMinimumVersion
} from "./lib/version-support.mjs";
import {
  renderNativeReviewResult,
  renderReviewResult,
  renderStoredJobResult,
  renderCancelReport,
  renderJobStatusReport,
  renderSetupReport,
  renderStatusReport,
  renderSteeringReport,
  renderTaskResult
} from "./lib/render.mjs";

/**
 * @typedef {import("./lib/reliability-contracts").JobRecord} JobRecord
 * @typedef {import("./lib/reliability-contracts").OwnedWorker} OwnedWorker
 * @typedef {ReturnType<typeof captureOwnedWorkerIdentity>} OwnedWorkerIdentity
 * @typedef {import("./lib/reliability-contracts").SteeringRequest} SteeringRequest
 * @typedef {import("./lib/app-server-protocol").ReviewTarget} NativeReviewTarget
 * @typedef {Record<string, unknown>} UnknownRecord
 * @typedef {Record<string, string | boolean>} ParsedOptions
 * @typedef {NonNullable<Parameters<typeof parseArgs>[1]>} ArgumentParserConfig
 * @typedef {ReturnType<typeof resolveReviewTarget>} ResolvedReviewTarget
 * @typedef {ReturnType<typeof collectReviewContext>} ReviewContext
 * @typedef {ReturnType<typeof buildSingleJobSnapshot>} SingleJobSnapshot
 * @typedef {ReturnType<typeof createProgressReporter>} ProgressReporter
 *
 * @typedef {object} WaitOptions
 * @property {number | null} [timeoutMs]
 * @property {number} [pollIntervalMs]
 *
 * @typedef {object} ReviewRunRequest
 * @property {string} cwd
 * @property {string} reviewName
 * @property {string} [base]
 * @property {"auto" | "working-tree" | "branch"} [scope]
 * @property {string} [focusText]
 * @property {string | null} [model]
 * @property {ProgressReporter} [onProgress]
 *
 * @typedef {object} TaskRunRequest
 * @property {string} cwd
 * @property {string | null} model
 * @property {string | null} effort
 * @property {string} prompt
 * @property {boolean} write
 * @property {boolean} resumeLast
 * @property {string} jobId
 * @property {ProgressReporter} [onProgress]
 * @property {(activeTurn: ActiveTurn) => Promise<() => Promise<void>>} [onActiveTurn]
 *
 * @typedef {ReviewRunRequest | TaskRunRequest} OwnedJobRequest
 *
 * @typedef {object} ActiveTurn
 * @property {string} threadId
 * @property {string} turnId
 * @property {(input: { requestId: string, instruction: string }) => Promise<{ threadId: string, turnId: string }>} steer
 *
 * @typedef {object} TaskMetadata
 * @property {string} title
 * @property {string} summary
 * @property {string} [singletonKey]
 *
 * @typedef {JobRecord & {
 *   workspaceRoot: string,
 *   title: string,
 *   jobClass: string,
 *   kind: string,
 *   summary: string
 * }} RunnableJob
 *
 * @typedef {object} ReviewCommandConfig
 * @property {string} reviewName
 * @property {(target: ResolvedReviewTarget, focusText: string) => void} [validateRequest]
 *
 * @typedef {object} ExecuteSendInput
 * @property {string} cwd
 * @property {string | null} sessionId
 * @property {string} jobId
 * @property {string} instruction
 *
 * @typedef {object} SteeringActivationInput
 * @property {string} workspaceRoot
 * @property {JobRecord} job
 * @property {OwnedWorkerIdentity} worker
 * @property {string} threadId
 * @property {string} turnId
 * @property {(input: { requestId: string, instruction: string }) => Promise<{ threadId: string, turnId: string }>} steer
 *
 * @typedef {object} CompanionJobInput
 * @property {string} prefix
 * @property {string} kind
 * @property {string} title
 * @property {string} workspaceRoot
 * @property {string} jobClass
 * @property {string} summary
 * @property {string | null} [singletonKey]
 * @property {boolean} [write]
 */

const ROOT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const REVIEW_SCHEMA = path.join(ROOT_DIR, "schemas", "review-output.schema.json");
const DEFAULT_STATUS_WAIT_TIMEOUT_MS = 240000;
const MAX_STATUS_WAIT_TIMEOUT_MS = 13 * 60 * 1000;
const DEFAULT_STATUS_POLL_INTERVAL_MS = 2000;
const VALID_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const MODEL_ALIASES = new Map([["spark", "gpt-5.3-codex-spark"]]);
const STOP_REVIEW_TASK_MARKER = "Run a stop-gate review of the previous Claude turn.";
const RUNTIME_CONFIG = loadRuntimeConfig(process.env);
const REVIEW_COMMAND_ARGUMENT_CONFIG = {
  valueOptions: ["base", "scope", "model", "cwd"],
  booleanOptions: ["json", "background", "wait"],
  aliasMap: {
    m: "model"
  }
};

/** @param {unknown} error */
function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} error */
function isUnknownDelivery(error) {
  return (
    typeof error === "object" &&
    error !== null &&
    "delivery" in error &&
    error.delivery === "unknown"
  );
}

/** @param {string} workspaceRoot */
function reconcileWorkspaceRuntime(workspaceRoot) {
  const sessionId = getCurrentClaudeSessionId();
  reconcileWorkspaceJobs(workspaceRoot, {
    steeringConfig: RUNTIME_CONFIG.steering,
    ...(sessionId ? { sessionId } : {})
  });
}

/** @param {string} workspaceRoot @param {string} jobId @param {string | null} [sessionId] */
function reconcileJobRuntime(
  workspaceRoot,
  jobId,
  sessionId = getCurrentClaudeSessionId()
) {
  if (
    sessionId &&
    !readStoredSessionJob(workspaceRoot, jobId, sessionId)
  ) {
    throw new Error(`No stored job found for ${jobId} in the current Claude session.`);
  }
  reconcileWorkspaceJobs(workspaceRoot, {
    steeringConfig: RUNTIME_CONFIG.steering,
    ...(sessionId ? { sessionId } : {}),
    jobIds: [jobId]
  });
}

function printUsage() {
  console.log(
    [
      "Usage:",
      "  node scripts/codex-companion.mjs setup [--enable-review-gate|--disable-review-gate] [--json]",
      "  node scripts/codex-companion.mjs review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>]",
      "  node scripts/codex-companion.mjs adversarial-review [--wait|--background] [--base <ref>] [--scope <auto|working-tree|branch>] [focus text]",
      "  node scripts/codex-companion.mjs task [--background] [--write] [--resume-last|--resume|--fresh] [--model <model|spark>] [--effort <none|minimal|low|medium|high|xhigh>] [prompt]",
      "  node scripts/codex-companion.mjs transfer [--source <claude-jsonl>] [--json]",
      "  node scripts/codex-companion.mjs status [job-id] [--all] [--json]",
      "  node scripts/codex-companion.mjs result [job-id] [--json]",
      "  node scripts/codex-companion.mjs send <job-id> <instruction> [--json]",
      "  node scripts/codex-companion.mjs cancel [job-id] [--json]"
    ].join("\n")
  );
}

/** @param {unknown} value @param {boolean} asJson */
function outputResult(value, asJson) {
  if (asJson) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    process.stdout.write(String(value ?? ""));
  }
}

/** @param {ParsedOptions} options @param {string} key */
function readStringOption(options, key) {
  const value = options[key];
  return typeof value === "string" ? value : undefined;
}

/** @param {ParsedOptions} options @param {string} key */
function readBooleanOption(options, key) {
  return options[key] === true;
}

/** @param {ParsedOptions} options @param {string} key */
function readNumberOption(options, key) {
  const value = readStringOption(options, key);
  if (value === undefined) {
    return undefined;
  }
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`Option --${key} requires a finite number.`);
  }
  return number;
}

/** @param {ParsedOptions} options */
function readStatusTimeout(options) {
  const timeoutMs = readNumberOption(options, "timeout-ms");
  if (timeoutMs === undefined) {
    return undefined;
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_STATUS_WAIT_TIMEOUT_MS
  ) {
    throw new RangeError(
      `Option --timeout-ms must be an integer from 1 to ${MAX_STATUS_WAIT_TIMEOUT_MS}.`
    );
  }
  return timeoutMs;
}

/** @param {ParsedOptions} options @returns {"auto" | "working-tree" | "branch" | undefined} */
function readScopeOption(options) {
  const scope = readStringOption(options, "scope");
  if (
    scope !== undefined &&
    scope !== "auto" &&
    scope !== "working-tree" &&
    scope !== "branch"
  ) {
    throw new Error(
      `Unsupported review scope "${scope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }
  return scope;
}

/** @param {unknown} value @returns {value is UnknownRecord} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {JobRecord} job @param {string} workspaceRoot @returns {RunnableJob} */
function requireRunnableJob(job, workspaceRoot) {
  if (
    typeof job.title !== "string" ||
    typeof job.jobClass !== "string" ||
    typeof job.kind !== "string" ||
    typeof job.summary !== "string"
  ) {
    throw new Error(`Stored job ${job.id} is missing runnable job metadata.`);
  }
  return {
    ...job,
    workspaceRoot,
    title: job.title,
    jobClass: job.jobClass,
    kind: job.kind,
    summary: job.summary
  };
}

/** @param {unknown} value @returns {ReviewRunRequest & { type: "review" }} */
function requireReviewRunRequest(value) {
  if (
    !isRecord(value) ||
    value.type !== "review" ||
    typeof value.cwd !== "string" ||
    typeof value.reviewName !== "string"
  ) {
    throw new Error("Stored review request is missing required fields.");
  }
  const scope =
    value.scope === "auto" ||
    value.scope === "working-tree" ||
    value.scope === "branch"
      ? value.scope
      : undefined;
  return {
    type: "review",
    cwd: value.cwd,
    reviewName: value.reviewName,
    base: typeof value.base === "string" ? value.base : undefined,
    scope,
    focusText: typeof value.focusText === "string" ? value.focusText : undefined,
    model: typeof value.model === "string" ? value.model : null
  };
}

/** @param {unknown} value @returns {TaskRunRequest & { type: "task" }} */
function requireTaskRunRequest(value) {
  if (
    !isRecord(value) ||
    value.type !== "task" ||
    typeof value.cwd !== "string" ||
    typeof value.prompt !== "string" ||
    typeof value.write !== "boolean" ||
    typeof value.resumeLast !== "boolean" ||
    typeof value.jobId !== "string"
  ) {
    throw new Error("Stored task request is missing required fields.");
  }
  return {
    type: "task",
    cwd: value.cwd,
    model: typeof value.model === "string" ? value.model : null,
    effort: typeof value.effort === "string" ? value.effort : null,
    prompt: value.prompt,
    write: value.write,
    resumeLast: value.resumeLast,
    jobId: value.jobId
  };
}

/** @param {unknown} payload @param {string} rendered @param {boolean} asJson */
function outputCommandResult(payload, rendered, asJson) {
  outputResult(asJson ? payload : rendered, asJson);
}

/** @param {unknown} model */
function normalizeRequestedModel(model) {
  if (model == null) {
    return null;
  }
  const normalized = String(model).trim();
  if (!normalized) {
    return null;
  }
  return MODEL_ALIASES.get(normalized.toLowerCase()) ?? normalized;
}

/** @param {unknown} effort */
function normalizeReasoningEffort(effort) {
  if (effort == null) {
    return null;
  }
  const normalized = String(effort).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!VALID_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Unsupported reasoning effort "${effort}". Use one of: none, minimal, low, medium, high, xhigh.`
    );
  }
  return normalized;
}

/** @param {string[]} argv */
function normalizeArgv(argv) {
  if (argv.length === 1) {
    const [raw] = argv;
    if (!raw || !raw.trim()) {
      return [];
    }
    return splitRawArgumentString(raw);
  }
  return argv;
}

/** @param {unknown} encoded */
function decodeBase64Arguments(encoded) {
  if (
    typeof encoded !== "string" ||
    encoded.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error("Review arguments must use canonical base64.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.toString("base64") !== encoded) {
    throw new Error("Review arguments must use canonical base64.");
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** @param {string} rawArguments */
function encodeBase64Arguments(rawArguments) {
  return Buffer.from(rawArguments, "utf8").toString("base64");
}

/** @param {string} token @param {ArgumentParserConfig} config */
function rawTokenConsumesValue(token, config) {
  if (token.startsWith("--")) {
    const [rawKey, inlineValue] = token.slice(2).split("=", 2);
    const key = config.aliasMap?.[rawKey] ?? rawKey;
    return config.valueOptions?.includes(key) === true && inlineValue === undefined;
  }
  if (!token.startsWith("-") || token === "-") {
    return false;
  }
  const rawKey = token.slice(1);
  const key = config.aliasMap?.[rawKey] ?? rawKey;
  return config.valueOptions?.includes(key) === true;
}

/** @param {string} token @param {ArgumentParserConfig} config */
function isRawRoutingOption(token, config) {
  if (token === "--") {
    return false;
  }
  const rawKey = token.startsWith("--")
    ? token.slice(2).split("=", 1)[0]
    : token.startsWith("-") && token !== "-"
      ? token.slice(1)
      : "";
  if (!rawKey) {
    return false;
  }
  const key = config.aliasMap?.[rawKey] ?? rawKey;
  return (
    config.valueOptions?.includes(key) === true ||
    config.booleanOptions?.includes(key) === true
  );
}

/**
 * @param {string[]} argv
 * @param {ArgumentParserConfig} config
 * @returns {{ options: ParsedOptions, focusText: string }}
 */
function parseReviewCommandInput(argv, config) {
  const effectiveConfig = {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  };
  const argumentIndexes = argv.flatMap((value, index) =>
    value === "--arguments-base64" ? [index] : []
  );
  if (argumentIndexes.length === 0) {
    const { options, positionals } = parseCommandInput(argv, effectiveConfig);
    return { options, focusText: positionals.join(" ").trim() };
  }
  if (argumentIndexes.length !== 1) {
    throw new Error("Review arguments may be encoded only once.");
  }

  const argumentIndex = argumentIndexes[0];
  const encoded = argv[argumentIndex + 1];
  if (encoded === undefined) {
    throw new Error("Missing value for --arguments-base64.");
  }
  const rawArguments = decodeBase64Arguments(encoded);
  const tokens = tokenizeRawArgumentString(rawArguments);
  let routingTokenCount = 0;
  while (
    routingTokenCount < tokens.length &&
    isRawRoutingOption(tokens[routingTokenCount].value, effectiveConfig)
  ) {
    const consumesValue = rawTokenConsumesValue(
      tokens[routingTokenCount].value,
      effectiveConfig
    );
    routingTokenCount += 1;
    if (consumesValue) {
      if (routingTokenCount >= tokens.length) {
        throw new Error(
          `Missing value for ${tokens[routingTokenCount - 1].value}`
        );
      }
      routingTokenCount += 1;
    }
  }

  const outerArgv = [
    ...argv.slice(0, argumentIndex),
    ...tokens.slice(0, routingTokenCount).map((token) => token.value),
    ...argv.slice(argumentIndex + 2)
  ];
  const { options, positionals } = parseCommandInput(outerArgv, effectiveConfig);
  if (positionals.length > 0) {
    throw new Error("Review routing arguments contain unexpected positionals.");
  }
  const focusStart = tokens[routingTokenCount]?.start;
  return {
    options,
    focusText:
      focusStart === undefined ? "" : rawArguments.slice(focusStart)
  };
}

/** @param {string[]} argv */
function expandEncodedArguments(argv) {
  const argumentIndexes = argv.flatMap((value, index) =>
    value === "--arguments-base64" ? [index] : []
  );
  if (argumentIndexes.length === 0) {
    return argv;
  }
  if (argumentIndexes.length !== 1) {
    throw new Error("Review arguments may be encoded only once.");
  }
  const argumentIndex = argumentIndexes[0];
  const encoded = argv[argumentIndex + 1];
  if (encoded === undefined) {
    throw new Error("Missing value for --arguments-base64.");
  }
  const rawArguments = decodeBase64Arguments(encoded);
  return [
    ...argv.slice(0, argumentIndex),
    ...splitRawArgumentString(rawArguments),
    ...argv.slice(argumentIndex + 2)
  ];
}

/** @param {string[]} argv @param {ArgumentParserConfig} [config] */
function parseCommandInput(argv, config = {}) {
  return parseArgs(expandEncodedArguments(normalizeArgv(argv)), {
    ...config,
    aliasMap: {
      C: "cwd",
      ...(config.aliasMap ?? {})
    }
  });
}

/** @param {ParsedOptions} [options] */
function resolveCommandCwd(options = {}) {
  const cwd = options.cwd;
  return typeof cwd === "string" ? path.resolve(process.cwd(), cwd) : process.cwd();
}

/** @param {ParsedOptions} [options] */
function resolveCommandWorkspace(options = {}) {
  return resolveWorkspaceRoot(resolveCommandCwd(options));
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** @param {unknown} text @param {number} [limit] */
function shorten(text, limit = 96) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

/** @param {unknown} text @param {string} fallback */
function firstMeaningfulLine(text, fallback) {
  const line = String(text ?? "")
    .split(/\r?\n/)
    .map((value) => value.trim())
    .find(Boolean);
  return line ?? fallback;
}

/** @param {string} cwd @param {string[]} [actionsTaken] */
async function buildSetupReport(cwd, actionsTaken = []) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const nodeStatus = binaryAvailable("node", ["--version"], { cwd });
  const npmStatus = binaryAvailable("npm", ["--version"], { cwd });
  const claudeBinaryStatus = binaryAvailable("claude", ["--version"], { cwd });
  const claudeStatus = claudeBinaryStatus.available
    ? requireMinimumVersion(
        "Claude Code",
        claudeBinaryStatus.detail,
        MINIMUM_CLAUDE_CODE_VERSION
      )
    : claudeBinaryStatus;
  const codexStatus = getCodexAvailability(cwd);
  const authStatus = await getCodexAuthStatus(cwd);
  const config = getConfig(workspaceRoot);

  const nextSteps = [];
  if (!claudeStatus.available) {
    nextSteps.push(`Upgrade Claude Code to ${MINIMUM_CLAUDE_CODE_VERSION} or later.`);
  }
  if (!codexStatus.available) {
    nextSteps.push("Install Codex with `npm install -g @openai/codex`.");
  }
  if (codexStatus.available && !authStatus.loggedIn && authStatus.requiresOpenaiAuth) {
    nextSteps.push("Run `!codex login`.");
    nextSteps.push("If browser login is blocked, retry with `!codex login --device-auth` or `!codex login --with-api-key`.");
  }
  if (!config.stopReviewGate) {
    nextSteps.push("Optional: run `/codex:setup --enable-review-gate` to require a fresh review before stop.");
  }

  return {
    ready:
      nodeStatus.available &&
      claudeStatus.available &&
      codexStatus.available &&
      authStatus.loggedIn,
    node: nodeStatus,
    npm: npmStatus,
    claude: claudeStatus,
    codex: codexStatus,
    auth: authStatus,
    sessionRuntime: getSessionRuntimeStatus(),
    reviewGateEnabled: Boolean(config.stopReviewGate),
    actionsTaken,
    nextSteps
  };
}

/** @param {string[]} argv */
async function handleSetup(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json", "enable-review-gate", "disable-review-gate"]
  });

  if (options["enable-review-gate"] && options["disable-review-gate"]) {
    throw new Error("Choose either --enable-review-gate or --disable-review-gate.");
  }

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  reconcileWorkspaceRuntime(workspaceRoot);
  const actionsTaken = [];

  if (options["enable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", true);
    actionsTaken.push(`Enabled the stop-time review gate for ${workspaceRoot}.`);
  } else if (options["disable-review-gate"]) {
    setConfig(workspaceRoot, "stopReviewGate", false);
    actionsTaken.push(`Disabled the stop-time review gate for ${workspaceRoot}.`);
  }

  const finalReport = await buildSetupReport(cwd, actionsTaken);
  const asJson = readBooleanOption(options, "json");
  outputResult(asJson ? finalReport : renderSetupReport(finalReport), asJson);
}

/** @param {ReviewContext} context @param {string} focusText */
function buildAdversarialReviewPrompt(context, focusText) {
  const template = loadPromptTemplate(ROOT_DIR, "adversarial-review");
  return interpolateTemplate(template, {
    REVIEW_KIND: "Adversarial Review",
    TARGET_LABEL: context.target.label,
    USER_FOCUS: focusText || "No extra focus provided.",
    REVIEW_COLLECTION_GUIDANCE: context.collectionGuidance,
    REVIEW_INPUT: context.content
  });
}

/** @param {string} cwd */
function ensureCodexAvailable(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error("Codex CLI is not installed or is missing required runtime support. Install it with `npm install -g @openai/codex`, then rerun `/codex:setup`.");
  }
}

/** @param {ResolvedReviewTarget} target @returns {NativeReviewTarget | null} */
function buildNativeReviewTarget(target) {
  if (target.mode === "working-tree") {
    return { type: "uncommittedChanges" };
  }

  if (target.mode === "branch") {
    return { type: "baseBranch", branch: target.baseRef };
  }

  return null;
}

/** @param {ResolvedReviewTarget} target @param {string} focusText */
function validateNativeReviewRequest(target, focusText) {
  if (focusText.trim()) {
    throw new Error(
      `\`/codex:review\` now maps directly to the built-in reviewer and does not support custom focus text. Retry with \`/codex:adversarial-review ${focusText.trim()}\` for focused review instructions.`
    );
  }

  const nativeTarget = buildNativeReviewTarget(target);
  if (!nativeTarget) {
    throw new Error("This `/codex:review` target is not supported by the built-in reviewer. Retry with `/codex:adversarial-review` for custom targeting.");
  }

  return nativeTarget;
}

/** @param {ReturnType<typeof buildStatusSnapshot>} report @param {boolean} asJson */
function renderStatusPayload(report, asJson) {
  return asJson ? report : renderStatusReport(report);
}

function getCurrentClaudeSessionId() {
  return process.env[SESSION_ID_ENV] ?? null;
}

/** @param {JobRecord[]} jobs */
function filterJobsForCurrentClaudeSession(jobs) {
  const sessionId = getCurrentClaudeSessionId();
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

/** @param {JobRecord[]} jobs */
function findLatestResumableTaskJob(jobs) {
  return (
    jobs.find(
      (job) =>
        job.jobClass === "task" &&
        job.threadId &&
        !isActiveJobStatus(job.status)
    ) ?? null
  );
}

/** @param {string} cwd @param {string} reference @param {WaitOptions} [options] */
async function waitForTrackedJob(cwd, reference, options = {}) {
  const timeoutMs =
    options.timeoutMs === null
      ? null
      : Math.max(
          0,
          Number(options.timeoutMs) || DEFAULT_STATUS_WAIT_TIMEOUT_MS
        );
  const pollIntervalMs = Math.max(100, Number(options.pollIntervalMs) || DEFAULT_STATUS_POLL_INTERVAL_MS);
  const deadline = timeoutMs === null ? null : Date.now() + timeoutMs;
  const authorized = resolveSessionJob(cwd, reference);
  const workspaceRoot = authorized.workspaceRoot;
  const jobId = authorized.job.id;
  reconcileJobRuntime(workspaceRoot, jobId);
  let snapshot = buildSingleJobSnapshot(cwd, jobId);

  while (
    isActiveJobStatus(snapshot.job.status) &&
    (deadline === null || Date.now() < deadline)
  ) {
    const sleepMs =
      deadline === null
        ? pollIntervalMs
        : Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()));
    await sleep(sleepMs);
    reconcileJobRuntime(workspaceRoot, jobId);
    snapshot = buildSingleJobSnapshot(cwd, jobId);
  }

  return {
    ...snapshot,
    waitTimedOut: isActiveJobStatus(snapshot.job.status),
    timeoutMs
  };
}

/** @param {string} cwd @param {{ excludeJobId?: string }} [options] */
async function resolveLatestTrackedTaskThread(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) => job.id !== options.excludeJobId);
  const visibleJobs = filterJobsForCurrentClaudeSession(jobs);
  const activeTask = visibleJobs.find((job) => job.jobClass === "task" && isActiveJobStatus(job.status));
  if (activeTask) {
    throw new Error(`Task ${activeTask.id} is still running. Use /codex:status before continuing it.`);
  }

  const trackedTask = findLatestResumableTaskJob(visibleJobs);
  if (trackedTask) {
    return { id: trackedTask.threadId };
  }

  if (sessionId) {
    return null;
  }

  return findLatestTaskThread(workspaceRoot);
}

/** @param {ReviewRunRequest} request */
async function executeReviewRun(request) {
  ensureCodexAvailable(request.cwd);
  ensureGitRepository(request.cwd);

  const target = resolveReviewTarget(request.cwd, {
    base: request.base,
    scope: request.scope
  });
  const rawFocusText = request.focusText ?? "";
  const focusText = rawFocusText.trim() ? rawFocusText : "";
  const reviewName = request.reviewName ?? "Review";
  if (reviewName === "Review") {
    const reviewTarget = validateNativeReviewRequest(target, focusText);
    const result = await runAppServerReview(request.cwd, {
      target: reviewTarget,
      model: request.model,
      onProgress: request.onProgress
    });
    const payload = {
      review: reviewName,
      target,
      threadId: result.threadId,
      sourceThreadId: result.sourceThreadId,
      codex: {
        status: result.status,
        stderr: result.stderr,
        stdout: result.reviewText,
        reasoning: result.reasoningSummary
      }
    };
    const rendered = renderNativeReviewResult(
      {
        status: result.status,
        stdout: result.reviewText,
        stderr: result.stderr
      },
      { reviewLabel: reviewName, targetLabel: target.label, reasoningSummary: result.reasoningSummary }
    );

    return {
      exitStatus: result.status,
      threadId: result.threadId,
      turnId: result.turnId,
      payload,
      rendered,
      summary: firstMeaningfulLine(result.reviewText, `${reviewName} completed.`),
      jobTitle: `Codex ${reviewName}`,
      jobClass: "review",
      targetLabel: target.label
    };
  }

  const context = collectReviewContext(request.cwd, target);
  const prompt = buildAdversarialReviewPrompt(context, focusText);
  const result = await runAppServerTurn(context.repoRoot, {
    prompt,
    model: request.model,
    sandbox: "read-only",
    outputSchema: readOutputSchema(REVIEW_SCHEMA),
    onProgress: request.onProgress
  });
  const parsed = parseStructuredOutput(result.finalMessage, {
    status: result.status,
    failureMessage:
      result.error == null ? result.stderr : getErrorMessage(result.error)
  });
  const payload = {
    review: reviewName,
    target,
    threadId: result.threadId,
    context: {
      repoRoot: context.repoRoot,
      branch: context.branch,
      summary: context.summary
    },
    codex: {
      status: result.status,
      stderr: result.stderr,
      stdout: result.finalMessage,
      reasoning: result.reasoningSummary
    },
    result: parsed.parsed,
    rawOutput: parsed.rawOutput,
    parseError: parsed.parseError,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered: renderReviewResult(parsed, {
      reviewLabel: reviewName,
      targetLabel: context.target.label,
      reasoningSummary: result.reasoningSummary
    }),
    summary: parsed.parsed?.summary ?? parsed.parseError ?? firstMeaningfulLine(result.finalMessage, `${reviewName} finished.`),
    jobTitle: `Codex ${reviewName}`,
    jobClass: "review",
    targetLabel: context.target.label
  };
}


/** @param {TaskRunRequest} request */
async function executeTaskRun(request) {
  const workspaceRoot = resolveWorkspaceRoot(request.cwd);
  ensureCodexAvailable(request.cwd);

  const taskMetadata = buildTaskRunMetadata({
    prompt: request.prompt,
    resumeLast: request.resumeLast
  });

  let resumeThreadId = null;
  if (request.resumeLast) {
    reconcileWorkspaceRuntime(workspaceRoot);
    const latestThread = await resolveLatestTrackedTaskThread(workspaceRoot, {
      excludeJobId: request.jobId
    });
    if (!latestThread) {
      throw new Error("No previous Codex task thread was found for this repository.");
    }
    resumeThreadId = latestThread.id;
  }

  if (!request.prompt && !resumeThreadId) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }

  const result = await runAppServerTurn(workspaceRoot, {
    resumeThreadId,
    prompt: request.prompt,
    defaultPrompt: resumeThreadId ? DEFAULT_CONTINUE_PROMPT : "",
    model: request.model,
    effort: request.effort,
    sandbox: request.write ? "workspace-write" : "read-only",
    onProgress: request.onProgress,
    onActiveTurn: request.onActiveTurn,
    persistThread: true,
    threadName: resumeThreadId ? null : buildPersistentTaskThreadName(request.prompt || DEFAULT_CONTINUE_PROMPT)
  });

  const rawOutput = typeof result.finalMessage === "string" ? result.finalMessage : "";
  const failureMessage =
    result.error == null ? result.stderr ?? "" : getErrorMessage(result.error);
  const rendered = renderTaskResult(
    {
      rawOutput,
      failureMessage,
      reasoningSummary: result.reasoningSummary
    },
    {
      title: taskMetadata.title,
      jobId: request.jobId ?? null,
      write: Boolean(request.write)
    }
  );
  const payload = {
    status: result.status,
    threadId: result.threadId,
    rawOutput,
    touchedFiles: result.touchedFiles,
    reasoningSummary: result.reasoningSummary
  };

  return {
    exitStatus: result.status,
    threadId: result.threadId,
    turnId: result.turnId,
    payload,
    rendered,
    summary: firstMeaningfulLine(rawOutput, firstMeaningfulLine(failureMessage, `${taskMetadata.title} finished.`)),
    jobTitle: taskMetadata.title,
    jobClass: "task",
    write: Boolean(request.write)
  };
}

/** @param {SteeringActivationInput} input */
async function activateWorkerSteering({
  workspaceRoot,
  job,
  worker,
  threadId,
  turnId,
  steer
}) {
  const channel = await openSteeringServer({
    workspaceRoot,
    jobId: job.id,
    worker,
    threadId,
    turnId,
    config: RUNTIME_CONFIG.steering,
    onError: (error, descriptor, endpointRemoved) => {
      appendLogLine(job.logFile, `Steering server failed: ${error.message}`);
      if (!endpointRemoved) {
        return;
      }
      mutateJobIf(
        workspaceRoot,
        job.id,
        (current) =>
          sameOwnedWorkerGeneration(current.worker, worker) &&
          current.steering?.address === descriptor.address &&
          sameOwnedWorkerGeneration(current.steering?.worker, descriptor.worker),
        () => ({ steering: null })
      );
    },
    handleSteer: async (request) => {
      const current = readStoredJob(workspaceRoot, job.id);
      if (
        !current ||
        current.status !== "running" ||
        current.jobClass !== "task" ||
        current.sessionId !== job.sessionId ||
        current.threadId !== threadId ||
        current.turnId !== turnId ||
        !sameOwnedWorkerGeneration(current.worker, worker)
      ) {
        throw new Error(`Job ${job.id} is no longer running on this worker generation and turn.`);
      }
      assertSteeringDescriptor(current.steering, {
        workspaceRoot,
        jobId: job.id,
        worker,
        threadId,
        turnId,
        config: RUNTIME_CONFIG.steering
      });

      appendLogLine(
        current.logFile,
        `Steering received request=${request.requestId} expectedTurn=${turnId} instruction="${shorten(request.instruction)}".`
      );
      return resolveNativeSteer({
        steer: () => steer({
          requestId: request.requestId,
          instruction: request.instruction
        }),
        logAccepted: (result) =>
          appendLogLine(
            current.logFile,
            `Steering accepted request=${request.requestId} expectedTurn=${turnId} acceptedTurn=${result.turnId}.`
          ),
        logRejected: (error) =>
          appendLogLine(
            current.logFile,
            `Steering rejected request=${request.requestId} expectedTurn=${turnId} error="${shorten(getErrorMessage(error))}".`
          ),
        onLogError: (error) => {
          process.stderr.write(
            `Steering logging failed after request=${request.requestId}: ${getErrorMessage(error)}\n`
          );
        }
      });
    }
  });

  let published;
  try {
    published = mutateJobIf(
      workspaceRoot,
      job.id,
      (current) =>
        current.status === "running" &&
        current.launchToken === job.launchToken &&
        sameOwnedWorkerGeneration(current.worker, worker),
      () => ({
        threadId,
        turnId,
        steering: channel.descriptor
      })
    );
  } catch (error) {
    await channel.close();
    throw error;
  }
  if (!published.matched) {
    await channel.close();
    throw new Error(`Cannot publish steering for ${job.id}: its worker generation changed.`);
  }

  return async () => {
    await channel.close();
    mutateJobIf(
      workspaceRoot,
      job.id,
      (current) =>
        sameOwnedWorkerGeneration(current.worker, worker) &&
        current.steering?.address === channel.descriptor.address &&
        sameOwnedWorkerGeneration(
          current.steering?.worker,
          channel.descriptor.worker
        ),
      () => ({
        steering: null
      })
    );
  };
}

/** @param {string} reviewName @param {ResolvedReviewTarget} target */
function buildReviewJobMetadata(reviewName, target) {
  return {
    kind: reviewName === "Adversarial Review" ? "adversarial-review" : "review",
    title: reviewName === "Review" ? "Codex Review" : `Codex ${reviewName}`,
    summary: `${reviewName} ${target.label}`
  };
}

/** @param {{ prompt: string, resumeLast?: boolean }} input @returns {TaskMetadata} */
function buildTaskRunMetadata({ prompt, resumeLast = false }) {
  if (!resumeLast && String(prompt ?? "").includes(STOP_REVIEW_TASK_MARKER)) {
    const promptDigest = createHash("sha256").update(prompt, "utf8").digest("hex");
    return {
      title: "Codex Stop Gate Review",
      summary: "Stop-gate review of previous Claude turn",
      singletonKey: `stop-review:${promptDigest}`
    };
  }

  const title = resumeLast ? "Codex Resume" : "Codex Task";
  const fallbackSummary = resumeLast ? DEFAULT_CONTINUE_PROMPT : "Task";
  return {
    title,
    summary: shorten(prompt || fallbackSummary)
  };
}

/** @param {{ title?: string, jobId: string }} payload */
function renderQueuedTaskLaunch(payload) {
  return `${payload.title ?? "Codex task"} started in the background as ${payload.jobId}. Check /codex:status ${payload.jobId} for progress.\n`;
}

/** @param {string} kind @param {string} jobClass */
function getJobKindLabel(kind, jobClass) {
  if (kind === "adversarial-review") {
    return "adversarial-review";
  }
  return jobClass === "review" ? "review" : "rescue";
}

/** @param {CompanionJobInput} input @returns {RunnableJob} */
function createCompanionJob({
  prefix,
  kind,
  title,
  workspaceRoot,
  jobClass,
  summary,
  singletonKey = null,
  write = false
}) {
  const record = createJobRecord({
    id: generateJobId(prefix),
    status: "queued",
    kind,
    kindLabel: getJobKindLabel(kind, jobClass),
    title,
    workspaceRoot,
    jobClass,
    summary,
    ...(singletonKey ? { singletonKey } : {}),
    write
  });
  return {
    ...record,
    workspaceRoot,
    title,
    jobClass,
    kind,
    summary
  };
}

/**
 * @param {RunnableJob} job
 * @param {{ logFile?: string, stderr?: boolean, worker?: OwnedWorkerIdentity | null }} [options]
 */
function createTrackedProgress(job, options = {}) {
  const logFile = options.logFile ?? createJobLogFile(job.workspaceRoot, job.id, job.title);
  return {
    logFile,
    progress: createProgressReporter({
      stderr: Boolean(options.stderr),
      logFile,
      onEvent: createJobProgressUpdater(
        job.workspaceRoot,
        job.id,
        options.worker ?? null
      )
    })
  };
}

/** @param {string} workspaceRoot @param {TaskMetadata} taskMetadata @param {boolean} write */
function buildTaskJob(workspaceRoot, taskMetadata, write) {
  return createCompanionJob({
    prefix: "task",
    kind: "task",
    title: taskMetadata.title,
    workspaceRoot,
    jobClass: "task",
    summary: taskMetadata.summary,
    singletonKey: taskMetadata.singletonKey,
    write
  });
}

/** @param {TaskRunRequest} input @returns {TaskRunRequest & { type: "task" }} */
function buildTaskRequest({ cwd, model, effort, prompt, write, resumeLast, jobId }) {
  return {
    type: "task",
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId
  };
}

/** @param {{ threadId: string, resumeCommand: string, sourcePath: string, sessionId: string }} payload */
function renderTransferResult(payload) {
  const lines = [
    "Transferred the Claude session into a Codex thread with visible turn history.",
    `Codex session ID: ${payload.threadId}`,
    `Resume in Codex: ${payload.resumeCommand}`
  ];
  return `${lines.join("\n")}\n`;
}

/** @param {string} cwd @param {{ source?: string }} [options] */
async function executeTransfer(cwd, options = {}) {
  const sourcePath = resolveClaudeSessionPath(cwd, {
    source: options.source
  });
  const result = await importExternalAgentSession(cwd, { sourcePath });
  const payload = {
    threadId: result.threadId,
    resumeCommand: `codex resume ${result.threadId}`,
    sourcePath,
    sessionId: path.basename(sourcePath, ".jsonl")
  };

  return {
    payload,
    rendered: renderTransferResult(payload)
  };
}

/** @param {string} cwd @param {ParsedOptions} options @param {string[]} positionals */
function readTaskPrompt(cwd, options, positionals) {
  const promptFile = options["prompt-file"];
  if (typeof promptFile === "string") {
    return fs.readFileSync(path.resolve(cwd, promptFile), "utf8");
  }

  const positionalPrompt = positionals.join(" ");
  return positionalPrompt || readStdinIfPiped();
}

/** @param {string} prompt @param {boolean} resumeLast */
function requireTaskRequest(prompt, resumeLast) {
  if (!prompt && !resumeLast) {
    throw new Error("Provide a prompt, a prompt file, piped stdin, or use --resume-last.");
  }
}

/**
 * @param {string} cwd
 * @param {string} jobId
 * @param {string} workerToken
 * @param {{ spawnImpl?: typeof spawn }} [options]
 */
function spawnDetachedTaskWorker(cwd, jobId, workerToken, options = {}) {
  const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
  const launch = createOwnedWorkerLaunch(
    process.execPath,
    [
      scriptPath,
      "task-worker",
      "--cwd",
      cwd,
      "--job-id",
      jobId,
      "--worker-token",
      workerToken
    ],
    workerToken,
    {
      cwd,
      env: process.env,
      stdio: "ignore"
    }
  );
  return (options.spawnImpl ?? spawn)(
    launch.command,
    launch.args,
    launch.spawnOptions
  );
}

/**
 * @param {string} cwd
 * @param {RunnableJob} job
 * @param {OwnedJobRequest & { type: string }} request
 * @param {{
 *   background?: boolean,
 *   spawnWorkerOptions?: Parameters<typeof spawnDetachedTaskWorker>[3],
 *   cleanupOptions?: NonNullable<Parameters<typeof cleanupFailedWorkerLaunch>[5]>
 * }} [options]
 */
export async function enqueueOwnedJob(cwd, job, request, options = {}) {
  assertOwnedWorkerPlatformSupported();
  const launchToken = randomUUID();
  const launcherProcess = inspectProcessIdentity(process.pid);
  if (!launcherProcess?.startKey) {
    throw new Error(`Cannot identify background launcher ${process.pid}.`);
  }
  const logFile = createJobLogFile(
    job.workspaceRoot,
    job.id,
    job.title
  );
  /** @type {JobRecord} */
  let queuedRecord;
  let creation;
  try {
    if (options.background) {
      appendLogLine(logFile, "Queued for background execution.");
    }
    queuedRecord = {
      ...job,
      status: "queued",
      phase: "spawning",
      pid: null,
      worker: null,
      launcher: {
        pid: launcherProcess.pid,
        startKey: launcherProcess.startKey
      },
      launchToken,
      logFile,
      request
    };
    creation = createJobIfSessionActive(job.workspaceRoot, queuedRecord);
  } catch (error) {
    removeUnpublishedJobLog(logFile, error);
    throw error;
  }
  if (!creation.created) {
    const publicationError = new Error(
      "The session ended before the background job could be published."
    );
    removeUnpublishedJobLog(logFile, publicationError);
    if (creation.job) {
      return {
        payload: {
          jobId: creation.job.id,
          status: creation.job.status,
          title: creation.job.title,
          summary: creation.job.summary,
          logFile: creation.job.logFile
        },
        logFile: creation.job.logFile,
        reused: true
      };
    }
    throw new Error("Cannot start a background job after its Claude session has ended.");
  }

  /** @type {ReturnType<typeof spawnDetachedTaskWorker> | null} */
  let child = null;
  try {
    const spawnedChild = spawnDetachedTaskWorker(
      cwd,
      job.id,
      launchToken,
      options.spawnWorkerOptions
    );
    child = spawnedChild;
    await new Promise((resolve, reject) => {
      spawnedChild.once("spawn", resolve);
      spawnedChild.once("error", reject);
    });
    spawnedChild.unref();
    const childPid = spawnedChild.pid;
    if (typeof childPid !== "number") {
      throw new Error(`Background worker ${job.id} started without a process id.`);
    }
    const recording = recordSpawnedWorker(
      job.workspaceRoot,
      job.id,
      childPid,
      launchToken
    );
    if (!recording.recorded) {
      throw new Error(
        `Background worker ${job.id} could not publish its owned process identity.`
      );
    }
    await waitForWorkerClaim(job.workspaceRoot, job.id, launchToken, {
      worker: recording.worker
    });
  } catch (error) {
    await cleanupFailedWorkerLaunch(
      job.workspaceRoot,
      queuedRecord,
      child?.pid,
      launchToken,
      error,
      {
        ...options.cleanupOptions,
        workerConfig: RUNTIME_CONFIG.worker
      }
    );
    throw error;
  }

  return {
    payload: {
      jobId: job.id,
      status: "queued",
      title: job.title,
      summary: job.summary,
      logFile
    },
    logFile
  };
}

/**
 * @param {string} cwd
 * @param {RunnableJob} job
 * @param {OwnedJobRequest & { type: string }} request
 * @param {{ json?: boolean }} [options]
 */
async function runForegroundCommand(cwd, job, request, options = {}) {
  await enqueueOwnedJob(cwd, job, request);
  const completed = (
    await waitForTrackedJob(job.workspaceRoot, job.id, {
      timeoutMs: null,
      pollIntervalMs: 500
    })
  ).job;
  if (completed.rendered != null || completed.result != null) {
    outputResult(
      options.json ? completed.result : completed.rendered ?? "",
      options.json === true
    );
    const exitStatusValue =
      "exitStatus" in completed ? completed.exitStatus : undefined;
    const exitStatus =
      typeof exitStatusValue === "number"
        ? exitStatusValue
        : completed.status === "completed"
          ? 0
          : 1;
    process.exitCode = exitStatus;
    return completed;
  }
  throw new Error(completed.errorMessage ?? `Owned worker job ${job.id} failed without a result.`);
}

/** @param {string[]} argv @param {ReviewCommandConfig} config */
async function handleReviewCommand(argv, config) {
  const { options, focusText } = parseReviewCommandInput(
    argv,
    REVIEW_COMMAND_ARGUMENT_CONFIG
  );

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  reconcileWorkspaceRuntime(workspaceRoot);
  const target = resolveReviewTarget(cwd, {
    base: readStringOption(options, "base"),
    scope: readScopeOption(options)
  });

  config.validateRequest?.(target, focusText);
  const metadata = buildReviewJobMetadata(config.reviewName, target);
  const job = createCompanionJob({
    prefix: "review",
    kind: metadata.kind,
    title: metadata.title,
    workspaceRoot,
    jobClass: "review",
    summary: metadata.summary
  });
  if (options.background) {
    /** @type {ReviewRunRequest & { type: "review" }} */
    const request = {
      type: "review",
      cwd,
      base: readStringOption(options, "base"),
      scope: readScopeOption(options),
      model: normalizeRequestedModel(options.model),
      focusText,
      reviewName: config.reviewName
    };
    const { payload } = await enqueueOwnedJob(cwd, job, request, {
      background: true
    });
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), readBooleanOption(options, "json"));
    return;
  }
  /** @type {ReviewRunRequest & { type: "review" }} */
  const request = {
    type: "review",
    cwd,
    base: readStringOption(options, "base"),
    scope: readScopeOption(options),
    model: normalizeRequestedModel(options.model),
    focusText,
    reviewName: config.reviewName
  };
  await runForegroundCommand(
    cwd,
    job,
    request,
    { json: readBooleanOption(options, "json") }
  );
}

/** @param {string[]} argv */
async function handleReview(argv) {
  return handleReviewCommand(argv, {
    reviewName: "Review",
    validateRequest: validateNativeReviewRequest
  });
}

/** @param {string[]} argv */
async function handleTask(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["model", "effort", "cwd", "prompt-file"],
    booleanOptions: ["json", "write", "resume-last", "resume", "fresh", "background"],
    aliasMap: {
      m: "model"
    }
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  reconcileWorkspaceRuntime(workspaceRoot);
  const model = normalizeRequestedModel(options.model);
  const effort = normalizeReasoningEffort(options.effort);
  const prompt = readTaskPrompt(cwd, options, positionals);

  const resumeLast = Boolean(options["resume-last"] || options.resume);
  const fresh = Boolean(options.fresh);
  if (resumeLast && fresh) {
    throw new Error("Choose either --resume/--resume-last or --fresh.");
  }
  const write = Boolean(options.write);
  const taskMetadata = buildTaskRunMetadata({
    prompt,
    resumeLast
  });

  if (options.background) {
    ensureCodexAvailable(cwd);
    requireTaskRequest(prompt, resumeLast);

    const job = buildTaskJob(workspaceRoot, taskMetadata, write);
    const request = buildTaskRequest({
      cwd,
      model,
      effort,
      prompt,
      write,
      resumeLast,
      jobId: job.id
    });
    const { payload } = await enqueueOwnedJob(cwd, job, request, {
      background: true
    });
    outputCommandResult(payload, renderQueuedTaskLaunch(payload), readBooleanOption(options, "json"));
    return;
  }

  const job = buildTaskJob(workspaceRoot, taskMetadata, write);
  const request = buildTaskRequest({
    cwd,
    model,
    effort,
    prompt,
    write,
    resumeLast,
    jobId: job.id
  });
  await runForegroundCommand(
    cwd,
    job,
    request,
    { json: readBooleanOption(options, "json") }
  );
}

/** @param {string[]} argv */
async function handleTransfer(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "source"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  reconcileWorkspaceRuntime(resolveCommandWorkspace(options));
  const { payload, rendered } = await executeTransfer(cwd, {
    source: readStringOption(options, "source")
  });
  outputCommandResult(payload, rendered, readBooleanOption(options, "json"));
}

/** @param {string[]} argv */
async function handleTaskWorker(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd", "job-id", "worker-token"]
  });

  const jobId = readStringOption(options, "job-id");
  const workerToken = readStringOption(options, "worker-token");
  if (!jobId) {
    throw new Error("Missing required --job-id for task-worker.");
  }
  if (!workerToken) {
    throw new Error("Missing required --worker-token for task-worker.");
  }

  let disposeTermination = () => {};
  try {
    const cwd = resolveCommandCwd(options);
    const workspaceRoot = resolveCommandWorkspace(options);
    const storedJob = readStoredJob(workspaceRoot, jobId);
    if (!storedJob) {
      throw new Error(`No stored job found for ${jobId}.`);
    }
    if (storedJob.launchToken !== workerToken || storedJob.status !== "queued") {
      throw new Error(`Stored job ${jobId} does not match this worker launch.`);
    }

    if (!isRecord(storedJob.request)) {
      throw new Error(`Stored job ${jobId} is missing its task request payload.`);
    }
    const request =
      storedJob.request.type === "review"
        ? requireReviewRunRequest(storedJob.request)
        : requireTaskRunRequest(storedJob.request);
    const runnableJob = requireRunnableJob(storedJob, workspaceRoot);

    const worker = captureOwnedWorkerIdentity(process.pid, workerToken);
    disposeTermination = installBoundedWorkerTermination(worker, RUNTIME_CONFIG.worker);

    const { logFile, progress } = createTrackedProgress(
      runnableJob,
      {
        logFile: storedJob.logFile ?? undefined,
        worker
      }
    );
    await runTrackedJob(
      {
        ...runnableJob,
        logFile,
        worker
      },
      (runningJob) =>
        request.type === "review"
          ? executeReviewRun({
              ...request,
              onProgress: progress
            })
          : executeTaskRun({
              ...request,
              onProgress: progress,
              onActiveTurn: ({ threadId, turnId, steer }) =>
                activateWorkerSteering({
                  workspaceRoot,
                  job: runningJob,
                  worker,
                  threadId,
                  turnId,
                  steer
                })
            }),
      { logFile }
    );
  } finally {
    disposeTermination();
  }
}

/** @param {string[]} argv */
async function handleStatus(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd", "timeout-ms", "poll-interval-ms"],
    booleanOptions: ["json", "all", "wait"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  if (reference) {
    let snapshot;
    if (options.wait) {
      snapshot = await waitForTrackedJob(cwd, reference, {
        timeoutMs: readStatusTimeout(options),
        pollIntervalMs: readNumberOption(options, "poll-interval-ms")
      });
    } else {
      const authorized = resolveSessionJob(cwd, reference);
      reconcileJobRuntime(authorized.workspaceRoot, authorized.job.id);
      snapshot = buildSingleJobSnapshot(cwd, authorized.job.id);
    }
    outputCommandResult(
      snapshot,
      renderJobStatusReport(snapshot.job),
      readBooleanOption(options, "json")
    );
    return;
  }

  if (options.wait) {
    throw new Error("`status --wait` requires a job id.");
  }

  reconcileWorkspaceRuntime(resolveCommandWorkspace(options));
  const asJson = readBooleanOption(options, "json");
  const report = buildStatusSnapshot(cwd, { all: readBooleanOption(options, "all") });
  outputResult(renderStatusPayload(report, asJson), asJson);
}

/** @param {string[]} argv */
function handleResult(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  let authorizedReference = reference;
  if (reference) {
    const authorized = resolveSessionJob(cwd, reference);
    reconcileJobRuntime(authorized.workspaceRoot, authorized.job.id);
    authorizedReference = authorized.job.id;
  } else {
    reconcileWorkspaceRuntime(resolveCommandWorkspace(options));
  }
  const { workspaceRoot, job } = resolveResultJob(cwd, authorizedReference);
  const storedJob = job;
  const payload = {
    job,
    storedJob
  };

  outputCommandResult(
    payload,
    renderStoredJobResult(job, storedJob),
    readBooleanOption(options, "json")
  );
}

/** @param {ExecuteSendInput} input */
async function executeSend({ cwd, sessionId, jobId, instruction }) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  if (!jobId) {
    throw new Error("`send` requires an explicit background job id.");
  }
  if (!instruction.trim()) {
    throw new Error("`send` requires a non-empty instruction.");
  }
  if (!sessionId) {
    throw new Error("Cannot steer without the current Claude session id.");
  }
  let job = readStoredSessionJob(workspaceRoot, jobId, sessionId);
  if (!job) {
    throw new Error(`No stored job found for ${jobId} in the current Claude session.`);
  }
  reconcileJobRuntime(workspaceRoot, job.id, sessionId);
  job = readStoredSessionJob(workspaceRoot, job.id, sessionId);
  if (!job) {
    throw new Error(`No stored job found for ${jobId} in the current Claude session.`);
  }
  if (job.jobClass !== "task" || job.status !== "running") {
    throw new Error(`Cannot steer ${job.id}: it is not a running background task.`);
  }
  if (!job.worker?.token || !job.threadId || !job.turnId || !job.steering) {
    throw new Error(`Cannot steer ${job.id}: its active worker turn is not ready.`);
  }

  const inspection = inspectOwnedWorker(job.worker);
  if (inspection.status !== "same") {
    throw new Error(`Cannot steer ${job.id}: its owned worker is ${inspection.status}.`);
  }
  const descriptor = assertSteeringDescriptor(job.steering, {
    workspaceRoot,
    jobId: job.id,
    worker: job.worker,
    threadId: job.threadId,
    turnId: job.turnId,
    config: RUNTIME_CONFIG.steering
  });
  const requestId = createSteeringRequestId();
  const request = {
    version: 1,
    requestId,
    jobId: job.id,
    worker: descriptor.worker,
    threadId: job.threadId,
    turnId: job.turnId,
    instruction
  };
  appendLogLine(
    job.logFile,
    `Steering requested request=${requestId} expectedTurn=${job.turnId} instruction="${shorten(instruction)}".`
  );

  let response;
  try {
    response = await deliverSteeringRequest({
      descriptor,
      request,
      config: RUNTIME_CONFIG.steering
    });
  } catch (error) {
    appendLogLine(
      job.logFile,
      `Steering ${isUnknownDelivery(error) ? "delivery unknown" : "failed"} request=${requestId} expectedTurn=${job.turnId} error="${shorten(getErrorMessage(error))}".`
    );
    throw error;
  }

  const payload = {
    requestId,
    jobId: job.id,
    status: "accepted",
    threadId: response.threadId,
    turnId: response.turnId
  };
  return payload;
}

/** @param {string[]} argv */
async function handleSend(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });
  if (positionals.length > 2) {
    throw new Error("`send` requires the instruction as one quoted argument.");
  }
  const cwd = resolveCommandCwd(options);
  const payload = await executeSend({
    cwd,
    sessionId: getCurrentClaudeSessionId(),
    jobId: positionals[0]?.trim() ?? "",
    instruction: positionals[1] ?? ""
  });
  outputCommandResult(
    payload,
    renderSteeringReport(payload),
    readBooleanOption(options, "json")
  );
}

/** @param {unknown} commandArgs */
function parseSendHookArguments(commandArgs) {
  const source = typeof commandArgs === "string" ? commandArgs : "";
  const match = /^\s*(\S+)/.exec(source);
  if (!match) {
    return { jobId: "", instruction: "" };
  }
  const separatorIndex = match.index + match[0].length;
  return {
    jobId: match[1],
    instruction:
      separatorIndex < source.length
        ? source.slice(separatorIndex + 1)
        : ""
  };
}

async function handleSendHook() {
  let response;
  try {
    const input = JSON.parse(readStdinIfPiped());
    if (input?.hook_event_name !== "UserPromptExpansion") {
      throw new Error("The send hook only accepts UserPromptExpansion input.");
    }
    if (!["send", "codex:send"].includes(input.command_name)) {
      throw new Error(`The send hook cannot handle command ${input.command_name ?? "<missing>"}.`);
    }
    const { jobId, instruction } = parseSendHookArguments(input.command_args);
    const payload = await executeSend({
      cwd: input.cwd,
      sessionId: input.session_id,
      jobId,
      instruction
    });
    response = {
      decision: "block",
      reason: renderSteeringReport(payload)
    };
  } catch (error) {
    response = {
      decision: "block",
      reason: error instanceof Error ? error.message : String(error)
    };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

/**
 * @param {string[]} args
 * @param {string} cwd
 * @param {string} sessionId
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
function runCompanionExec(args, cwd, sessionId) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(ROOT_DIR, "scripts", "codex-companion.mjs");
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd,
      env: {
        ...process.env,
        [SESSION_ID_ENV]: sessionId
      },
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

/** @param {unknown} commandName */
function normalizeReviewHookCommand(commandName) {
  if (typeof commandName !== "string") {
    return null;
  }
  const normalized = commandName.startsWith("codex:")
    ? commandName.slice("codex:".length)
    : commandName;
  return ["review", "adversarial-review"].includes(normalized)
    ? normalized
    : null;
}

/** @param {string} encoded */
function readReviewHookMode(encoded) {
  const argv = ["--arguments-base64", encoded];
  const { options } = parseReviewCommandInput(
    argv,
    REVIEW_COMMAND_ARGUMENT_CONFIG
  );
  return {
    background: options.background === true,
    wait: options.wait === true
  };
}

async function handleReviewHook() {
  let response;
  try {
    const input = JSON.parse(readStdinIfPiped());
    if (input?.hook_event_name !== "UserPromptExpansion") {
      throw new Error("The review hook only accepts UserPromptExpansion input.");
    }
    const command = normalizeReviewHookCommand(input.command_name);
    if (!command) {
      throw new Error(`The review hook cannot handle command ${input.command_name ?? "<missing>"}.`);
    }
    if (typeof input.command_args !== "string") {
      throw new Error("The review hook requires the original command arguments.");
    }
    const rawArguments = input.command_args;
    if (typeof input.cwd !== "string" || !input.cwd) {
      throw new Error("The review hook requires the invocation working directory.");
    }
    if (typeof input.session_id !== "string" || !input.session_id) {
      throw new Error("The review hook requires the invoking Claude session id.");
    }
    const sessionId = input.session_id;
    const encoded = encodeBase64Arguments(rawArguments);
    const mode = readReviewHookMode(encoded);

    if (!mode.wait && !mode.background) {
      response = {
        hookSpecificOutput: {
          hookEventName: "UserPromptExpansion",
          additionalContext: `Deterministic review transport: ${JSON.stringify({ argumentsBase64: encoded })}`
        }
      };
    } else {
      const args = [
        command,
        ...(encoded ? ["--arguments-base64", encoded] : [])
      ];
      const result = await runCompanionExec(args, input.cwd, sessionId);
      const reason =
        result.status === 0
          ? result.stdout
          : result.stderr || result.stdout || `Codex ${command} failed.`;
      response = {
        decision: "block",
        reason
      };
    }
  } catch (error) {
    response = {
      decision: "block",
      reason: getErrorMessage(error)
    };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

/** @param {unknown} commandName */
function normalizeDirectHookCommand(commandName) {
  if (typeof commandName !== "string") {
    return null;
  }
  const normalized = commandName.startsWith("codex:")
    ? commandName.slice("codex:".length)
    : commandName;
  return ["transfer", "status", "result", "cancel", "setup"].includes(
    normalized
  )
    ? normalized
    : null;
}

async function handleCommandHook() {
  let response;
  try {
    const input = JSON.parse(readStdinIfPiped());
    if (input?.hook_event_name !== "UserPromptExpansion") {
      throw new Error("The command hook only accepts UserPromptExpansion input.");
    }
    const command = normalizeDirectHookCommand(input.command_name);
    if (!command) {
      throw new Error(
        `The command hook cannot handle command ${input.command_name ?? "<missing>"}.`
      );
    }
    if (typeof input.command_args !== "string") {
      throw new Error("The command hook requires the original command arguments.");
    }
    if (typeof input.cwd !== "string" || !input.cwd) {
      throw new Error("The command hook requires the invocation working directory.");
    }
    if (typeof input.session_id !== "string" || !input.session_id) {
      throw new Error("The command hook requires the invoking Claude session id.");
    }
    const encoded = encodeBase64Arguments(input.command_args);
    if (command === "setup") {
      response = {
        hookSpecificOutput: {
          hookEventName: "UserPromptExpansion",
          additionalContext: `Deterministic command transport: ${JSON.stringify({ argumentsBase64: encoded })}`
        }
      };
    } else {
      const result = await runCompanionExec(
        [command, ...(encoded ? ["--arguments-base64", encoded] : [])],
        input.cwd,
        input.session_id
      );
      response = {
        decision: "block",
        reason:
          result.status === 0
            ? result.stdout
            : result.stderr || result.stdout || `Codex ${command} failed.`
      };
    }
  } catch (error) {
    response = {
      decision: "block",
      reason: getErrorMessage(error)
    };
  }
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

/** @param {string[]} argv */
function handleTaskResumeCandidate(argv) {
  const { options } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const workspaceRoot = resolveCommandWorkspace(options);
  reconcileWorkspaceRuntime(workspaceRoot);
  const sessionId = getCurrentClaudeSessionId();
  const jobs = filterJobsForCurrentClaudeSession(sortJobsNewestFirst(listJobs(workspaceRoot)));
  const candidate = findLatestResumableTaskJob(jobs);

  const payload = {
    available: Boolean(candidate),
    sessionId,
    candidate:
      candidate == null
        ? null
        : {
            id: candidate.id,
            status: candidate.status,
            title: candidate.title ?? null,
            summary: candidate.summary ?? null,
            threadId: candidate.threadId,
            completedAt: candidate.completedAt ?? null,
            updatedAt: candidate.updatedAt ?? null
          }
  };

  const rendered = candidate
    ? `Resumable task found: ${candidate.id} (${candidate.status}).\n`
    : "No resumable task found for this session.\n";
  outputCommandResult(payload, rendered, readBooleanOption(options, "json"));
}

/** @param {string[]} argv */
async function handleCancel(argv) {
  const { options, positionals } = parseCommandInput(argv, {
    valueOptions: ["cwd"],
    booleanOptions: ["json"]
  });

  const cwd = resolveCommandCwd(options);
  const reference = positionals[0] ?? "";
  let { workspaceRoot, job } = resolveCancelableJob(cwd, reference, {
    env: process.env
  });
  reconcileJobRuntime(workspaceRoot, job.id);
  ({ workspaceRoot, job } = resolveCancelableJob(cwd, job.id, {
    env: process.env
  }));
  const cancellationToken = randomUUID();
  const reservation = mutateJobIf(
    workspaceRoot,
    job.id,
    (current) =>
      isActiveJobStatus(current.status) &&
      sameOwnedWorkerGeneration(current.worker, job.worker),
    () => ({
      status: "cancelling",
      phase: "cancelling",
      cancellation: {
        token: cancellationToken,
        requestedAt: nowIso()
      }
    })
  );
  if (!reservation.matched || !reservation.job?.worker) {
    throw new Error(`Cannot cancel ${job.id}: it finished or its owned worker changed.`);
  }

  const workerStop = await stopOwnedWorkerTree(reservation.job.worker, {
    graceMs: RUNTIME_CONFIG.worker.stopGraceMs,
    killMs: RUNTIME_CONFIG.worker.stopKillMs
  });
  cleanupSteeringEndpoint(reservation.job.steering, {
    workspaceRoot,
    jobId: reservation.job.id,
    worker: reservation.job.worker,
    config: RUNTIME_CONFIG.steering
  });
  appendLogLine(reservation.job.logFile, "Cancelled by user.");

  const completedAt = nowIso();
  const finalized = mutateJobIf(
    workspaceRoot,
    job.id,
    (current) =>
      current.status === "cancelling" &&
      current.cancellation?.token === cancellationToken &&
      sameOwnedWorkerGeneration(current.worker, reservation.job.worker),
    () => ({
      status: "cancelled",
      phase: "cancelled",
      pid: null,
      worker: null,
      errorMessage: "Cancelled by user.",
      completedAt,
      cancelledAt: completedAt,
      steering: null
    })
  );
  const recorded =
    finalized.matched && finalized.job
      ? finalized.job
      : readStoredJob(workspaceRoot, job.id);
  if (
    !recorded ||
    recorded.status !== "cancelled" ||
    recorded.cancellation?.token !== cancellationToken
  ) {
    throw new Error(`Cannot record cancellation of ${job.id}: its worker generation changed.`);
  }

  const payload = {
    jobId: job.id,
    status: "cancelled",
    title: job.title,
    workerTerminated: workerStop.stopped
  };

  outputCommandResult(
    payload,
    renderCancelReport(recorded),
    readBooleanOption(options, "json")
  );
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (!subcommand || subcommand === "help" || subcommand === "--help") {
    printUsage();
    return;
  }

  switch (subcommand) {
    case "setup":
      await handleSetup(argv);
      break;
    case "review":
      await handleReview(argv);
      break;
    case "adversarial-review":
      await handleReviewCommand(argv, {
        reviewName: "Adversarial Review"
      });
      break;
    case "task":
      await handleTask(argv);
      break;
    case "transfer":
      await handleTransfer(argv);
      break;
    case "task-worker":
      await handleTaskWorker(argv);
      break;
    case "status":
      await handleStatus(argv);
      break;
    case "result":
      handleResult(argv);
      break;
    case "send":
      await handleSend(argv);
      break;
    case "send-hook":
      await handleSendHook();
      break;
    case "review-hook":
      await handleReviewHook();
      break;
    case "command-hook":
      await handleCommandHook();
      break;
    case "task-resume-candidate":
      handleTaskResumeCandidate(argv);
      break;
    case "cancel":
      await handleCancel(argv);
      break;
    default:
      throw new Error(`Unknown subcommand: ${subcommand}`);
  }
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
