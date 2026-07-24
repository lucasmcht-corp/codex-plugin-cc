// @ts-check

import fs from "node:fs";
import process from "node:process";

import { sameOwnedWorkerGeneration } from "./job-lifecycle.mjs";
import { isActiveJobStatus } from "./job-lifecycle.mjs";
import { mutateJobIf, resolveJobLogFile } from "./state.mjs";

/**
 * @typedef {import("./reliability-contracts").JobRecord} JobRecord
 * @typedef {import("./reliability-contracts").OwnedWorker} OwnedWorker
 * @typedef {{
 *   message: string,
 *   phase: string | null,
 *   threadId: string | null,
 *   turnId: string | null,
 *   stderrMessage: string | null,
 *   logTitle: string | null,
 *   logBody: string | null
 * }} ProgressEvent
 * @typedef {{
 *   exitStatus: number,
 *   threadId?: string | null,
 *   turnId?: string | null,
 *   summary: string,
 *   payload: unknown,
 *   rendered: string
 * }} JobExecution
 */

export const SESSION_ID_ENV = "CODEX_COMPANION_SESSION_ID";
export const DEFAULT_JOB_LOG_TAIL_BYTES = 64 * 1024;

export function nowIso() {
  return new Date().toISOString();
}

/** @param {fs.Stats} stats @param {string} logFile */
function assertPrivateLogFile(stats, logFile) {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`Job log is not a regular file: ${logFile}.`);
  }
  if (process.platform !== "win32") {
    if (
      typeof process.getuid === "function" &&
      stats.uid !== process.getuid()
    ) {
      throw new Error(`Job log has the wrong owner: ${logFile}.`);
    }
    if ((stats.mode & 0o777) !== 0o600) {
      throw new Error(`Job log must use mode 600: ${logFile}.`);
    }
  }
}

/** @param {fs.Stats} left @param {fs.Stats} right */
function isSameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/** @param {string} logFile @param {fs.Stats | null} createdStats */
function removeCreatedLogFile(logFile, createdStats) {
  let currentStats;
  try {
    currentStats = fs.lstatSync(logFile);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (createdStats !== null && !isSameFile(currentStats, createdStats)) {
    throw new Error(`Job log changed before cleanup: ${logFile}.`);
  }
  if (createdStats === null) {
    if (!currentStats.isFile() || currentStats.isSymbolicLink()) {
      throw new Error(`Job log changed before cleanup: ${logFile}.`);
    }
    if (
      process.platform !== "win32" &&
      typeof process.getuid === "function" &&
      currentStats.uid !== process.getuid()
    ) {
      throw new Error(`Job log owner changed before cleanup: ${logFile}.`);
    }
  }
  fs.unlinkSync(logFile);
}

/** @param {string} logFile @param {(fileDescriptor: number) => void} write */
function writeExistingLogFile(logFile, write) {
  const pathStats = fs.lstatSync(logFile);
  assertPrivateLogFile(pathStats, logFile);
  const fileDescriptor = fs.openSync(
    logFile,
    fs.constants.O_WRONLY |
      fs.constants.O_APPEND |
      (fs.constants.O_NOFOLLOW ?? 0)
  );
  /** @type {unknown} */
  let writeError = null;
  try {
    const descriptorStats = fs.fstatSync(fileDescriptor);
    assertPrivateLogFile(descriptorStats, logFile);
    if (!isSameFile(pathStats, descriptorStats)) {
      throw new Error(`Job log changed while opening it: ${logFile}.`);
    }
    write(fileDescriptor);
  } catch (error) {
    writeError = error;
  }
  try {
    fs.closeSync(fileDescriptor);
  } catch (closeError) {
    if (writeError !== null) {
      throw new AggregateError(
        [writeError, closeError],
        `Failed to write and close job log ${logFile}.`
      );
    }
    throw closeError;
  }
  if (writeError !== null) {
    throw writeError;
  }
}

/** @param {string | null | undefined} logFile @param {number} [maxBytes] */
export function readJobLogTail(
  logFile,
  maxBytes = DEFAULT_JOB_LOG_TAIL_BYTES
) {
  if (!logFile) {
    return { content: "", truncated: false };
  }
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new RangeError("Job log tail size must be a positive integer.");
  }

  let pathStats;
  try {
    pathStats = fs.lstatSync(logFile);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { content: "", truncated: false };
    }
    throw error;
  }
  assertPrivateLogFile(pathStats, logFile);
  const fileDescriptor = fs.openSync(
    logFile,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
  );
  /** @type {unknown} */
  let readError = null;
  /** @type {{ content: string, truncated: boolean } | null} */
  let result = null;
  try {
    const descriptorStats = fs.fstatSync(fileDescriptor);
    assertPrivateLogFile(descriptorStats, logFile);
    if (!isSameFile(pathStats, descriptorStats)) {
      throw new Error(`Job log changed while opening it: ${logFile}.`);
    }
    const byteCount = Math.min(descriptorStats.size, maxBytes);
    const buffer = Buffer.alloc(byteCount);
    if (byteCount > 0) {
      fs.readSync(
        fileDescriptor,
        buffer,
        0,
        byteCount,
        descriptorStats.size - byteCount
      );
    }
    result = {
      content: buffer.toString("utf8"),
      truncated: descriptorStats.size > byteCount
    };
  } catch (error) {
    readError = error;
  }
  try {
    fs.closeSync(fileDescriptor);
  } catch (closeError) {
    if (readError !== null) {
      throw new AggregateError(
        [readError, closeError],
        `Failed to read and close job log ${logFile}.`
      );
    }
    throw closeError;
  }
  if (readError !== null) {
    throw readError;
  }
  if (result === null) {
    throw new Error(`Job log read produced no result: ${logFile}.`);
  }
  return result;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {ProgressEvent} */
function normalizeProgressEvent(value) {
  if (isRecord(value)) {
    return {
      message: String(value.message ?? "").trim(),
      phase: typeof value.phase === "string" && value.phase.trim() ? value.phase.trim() : null,
      threadId: typeof value.threadId === "string" && value.threadId.trim() ? value.threadId.trim() : null,
      turnId: typeof value.turnId === "string" && value.turnId.trim() ? value.turnId.trim() : null,
      stderrMessage: value.stderrMessage == null ? null : String(value.stderrMessage).trim(),
      logTitle: typeof value.logTitle === "string" && value.logTitle.trim() ? value.logTitle.trim() : null,
      logBody: value.logBody == null ? null : String(value.logBody).trimEnd()
    };
  }

  return {
    message: String(value ?? "").trim(),
    phase: null,
    threadId: null,
    turnId: null,
    stderrMessage: String(value ?? "").trim(),
    logTitle: null,
    logBody: null
  };
}

/** @param {string | null | undefined} logFile @param {unknown} message */
export function appendLogLine(logFile, message) {
  const normalized = String(message ?? "").trim();
  if (!logFile || !normalized) {
    return;
  }
  writeExistingLogFile(logFile, (fileDescriptor) => {
    fs.writeFileSync(
      fileDescriptor,
      `[${nowIso()}] ${normalized}\n`,
      "utf8"
    );
  });
}

/** @param {string | null | undefined} logFile @param {string | null | undefined} title @param {unknown} body */
export function appendLogBlock(logFile, title, body) {
  if (!logFile || !body) {
    return;
  }
  writeExistingLogFile(logFile, (fileDescriptor) => {
    fs.writeFileSync(
      fileDescriptor,
      `\n[${nowIso()}] ${title}\n${String(body).trimEnd()}\n`,
      "utf8"
    );
  });
}

/** @param {string} workspaceRoot @param {string} jobId @param {string} title */
export function createJobLogFile(workspaceRoot, jobId, title) {
  const logFile = resolveJobLogFile(workspaceRoot, jobId);
  let fileDescriptor = null;
  let created = false;
  /** @type {fs.Stats | null} */
  let createdStats = null;
  try {
    fileDescriptor = fs.openSync(
      logFile,
      fs.constants.O_WRONLY |
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        (fs.constants.O_NOFOLLOW ?? 0),
      0o600
    );
    created = true;
    createdStats = fs.fstatSync(fileDescriptor);
    if (process.platform !== "win32") {
      fs.fchmodSync(fileDescriptor, 0o600);
    }
    createdStats = fs.fstatSync(fileDescriptor);
    assertPrivateLogFile(createdStats, logFile);
    if (title) {
      fs.writeFileSync(
        fileDescriptor,
        `[${nowIso()}] Starting ${title}.\n`,
        "utf8"
      );
    }
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;
  } catch (error) {
    const cleanupErrors = [];
    if (fileDescriptor !== null) {
      try {
        fs.closeSync(fileDescriptor);
      } catch (closeError) {
        cleanupErrors.push(closeError);
      }
    }
    if (created) {
      try {
        removeCreatedLogFile(logFile, createdStats);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        `Failed to initialize and clean up job log ${logFile}.`
      );
    }
    throw error;
  }
  return logFile;
}

/** @param {string} logFile @param {unknown} cause */
export function removeUnpublishedJobLog(logFile, cause) {
  try {
    fs.unlinkSync(logFile);
  } catch (cleanupError) {
    if (
      cleanupError instanceof Error &&
      "code" in cleanupError &&
      cleanupError.code === "ENOENT"
    ) {
      return;
    }
    throw new AggregateError(
      [cause, cleanupError],
      `Failed to remove unpublished job log ${logFile}.`
    );
  }
}

/**
 * @param {JobRecord} base
 * @param {{ env?: NodeJS.ProcessEnv, sessionIdEnv?: string }} options
 * @returns {JobRecord}
 */
export function createJobRecord(base, options = {}) {
  const env = options.env ?? process.env;
  const sessionId = env[options.sessionIdEnv ?? SESSION_ID_ENV];
  return {
    ...base,
    createdAt: nowIso(),
    ...(sessionId ? { sessionId } : {})
  };
}

/**
 * @param {string} workspaceRoot
 * @param {string} jobId
 * @param {OwnedWorker | null} worker
 * @returns {(event: unknown) => void}
 */
export function createJobProgressUpdater(workspaceRoot, jobId, worker = null) {
  /** @type {string | null} */
  let lastPhase = null;
  /** @type {string | null} */
  let lastThreadId = null;
  /** @type {string | null} */
  let lastTurnId = null;

  return (event) => {
    const normalized = normalizeProgressEvent(event);
    /** @type {Partial<JobRecord> & { id: string }} */
    const patch = { id: jobId };
    let changed = false;

    if (normalized.phase && normalized.phase !== lastPhase) {
      lastPhase = normalized.phase;
      patch.phase = normalized.phase;
      changed = true;
    }

    if (normalized.threadId && normalized.threadId !== lastThreadId) {
      lastThreadId = normalized.threadId;
      patch.threadId = normalized.threadId;
      changed = true;
    }

    if (normalized.turnId && normalized.turnId !== lastTurnId) {
      lastTurnId = normalized.turnId;
      patch.turnId = normalized.turnId;
      changed = true;
    }

    if (!changed) {
      return;
    }

    mutateJobIf(
      workspaceRoot,
      jobId,
      /** @param {JobRecord} current */
      (current) =>
        isActiveJobStatus(current.status) &&
        current.status !== "cancelling" &&
        (worker == null || sameOwnedWorkerGeneration(current.worker, worker)),
      () => patch
    );
  };
}

/**
 * @param {{
 *   stderr?: boolean,
 *   logFile?: string | null,
 *   onEvent?: ((event: ProgressEvent) => void) | null
 * }} options
 * @returns {((event: unknown) => void) | null}
 */
export function createProgressReporter({ stderr = false, logFile = null, onEvent = null } = {}) {
  if (!stderr && !logFile && !onEvent) {
    return null;
  }

  return (eventOrMessage) => {
    const event = normalizeProgressEvent(eventOrMessage);
    const stderrMessage = event.stderrMessage ?? event.message;
    if (stderr && stderrMessage) {
      process.stderr.write(`[codex] ${stderrMessage}\n`);
    }
    appendLogLine(logFile, event.message);
    appendLogBlock(logFile, event.logTitle, event.logBody);
    onEvent?.(event);
  };
}

/**
 * @param {JobRecord} job
 * @param {(job: JobRecord) => Promise<JobExecution>} runner
 * @param {{ logFile?: string | null }} options
 * @returns {Promise<JobExecution>}
 */
export async function runTrackedJob(job, runner, options = {}) {
  if (typeof job.workspaceRoot !== "string") {
    throw new Error(`Job ${job.id} has no workspace root.`);
  }
  const workspaceRoot = job.workspaceRoot;
  /** @type {JobRecord} */
  const runningRecord = {
    ...job,
    status: "running",
    startedAt: nowIso(),
    phase: "starting",
    pid: job.worker?.pid ?? null,
    worker: job.worker ?? null,
    launcher: null,
    logFile: options.logFile ?? job.logFile ?? null
  };
  if (!runningRecord.worker?.token) {
    throw new Error(`Job ${job.id} has no owned worker generation.`);
  }
  const started = mutateJobIf(
    workspaceRoot,
    job.id,
    /** @param {JobRecord} current */
    (current) =>
      current.status === "queued" &&
      current.launchToken === job.launchToken &&
      (current.worker == null ||
        sameOwnedWorkerGeneration(current.worker, runningRecord.worker)),
    () => runningRecord
  );
  if (!started.matched) {
    throw new Error(`Job ${job.id} was cancelled or replaced before worker execution.`);
  }

  try {
    const execution = await runner(runningRecord);
    const completionStatus = execution.exitStatus === 0 ? "completed" : "failed";
    const completedAt = nowIso();
    const completion = mutateJobIf(
      workspaceRoot,
      job.id,
      /** @param {JobRecord} current */
      (current) =>
        current.status === "running" &&
        sameOwnedWorkerGeneration(current.worker, runningRecord.worker),
      () => ({
        status: completionStatus,
        threadId: execution.threadId ?? null,
        turnId: execution.turnId ?? null,
        summary: execution.summary,
        phase: completionStatus === "completed" ? "done" : "failed",
        pid: null,
        worker: null,
        completedAt,
        exitStatus: execution.exitStatus,
        result: execution.payload,
        rendered: execution.rendered
      })
    );
    if (!completion.matched) {
      throw new Error(`Job ${job.id} finished after its worker generation was cancelled or replaced.`);
    }
    appendLogBlock(options.logFile ?? job.logFile ?? null, "Final output", execution.rendered);
    return execution;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const completedAt = nowIso();
    mutateJobIf(
      workspaceRoot,
      job.id,
      /** @param {JobRecord} current */
      (current) =>
        current.status === "running" &&
        sameOwnedWorkerGeneration(current.worker, runningRecord.worker),
      /** @param {JobRecord} current */
      (current) => ({
        status: "failed",
        phase: "failed",
        errorMessage,
        exitStatus: 1,
        pid: current.steering ? current.pid : null,
        worker: current.steering ? current.worker : null,
        completedAt,
        logFile: options.logFile ?? job.logFile ?? current.logFile ?? null
      })
    );
    throw error;
  }
}
