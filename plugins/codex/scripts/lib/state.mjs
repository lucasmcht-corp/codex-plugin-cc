// @ts-check

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import {
  isActiveJobStatus,
  isJobStatus,
  isOwnedWorker,
  isProcessIdentity,
  sameOwnedWorkerGeneration
} from "./job-lifecycle.mjs";
import { inspectProcessIdentity, isProcessAlive } from "./process.mjs";
import {
  assertPrivateRuntimeFile,
  ensurePrivateRuntimeDirectory
} from "./runtime-config.mjs";
import { isSteeringDescriptor } from "./steering-channel.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

/**
 * @typedef {import("./reliability-contracts").JobRecord} JobRecord
 * @typedef {import("./reliability-contracts").PersistedState} PersistedState
 * @typedef {import("./reliability-contracts").PluginConfig} PluginConfig
 * @typedef {import("./reliability-contracts").SessionEnding} SessionEnding
 * @typedef {import("./reliability-contracts").StoredState} StoredState
 * @typedef {{ durable?: boolean, platform?: NodeJS.Platform }} WriteOptions
 * @typedef {{ timeoutMs?: number, pollMs?: number, platform?: NodeJS.Platform, removeFileIfExistsImpl?: (filePath: string) => boolean, inspectProcessIdentityImpl?: typeof inspectProcessIdentity }} TransactionOptions
 * @typedef {{ lockDir: string, ticketFile: string, token: string }} StateLock
 * @typedef {{ version: 2, token: string, pid: number, startKey: string, acquiredAt: string, ticket: number }} LockMetadata
 * @typedef {{ filePath: string, metadata: LockMetadata }} LockEntry
 */

const STATE_VERSION = 1;
const COMPANION_DATA_ENV = "CODEX_COMPANION_PLUGIN_DATA";
const RUNTIME_USER_ID =
  typeof process.getuid === "function"
    ? String(process.getuid())
    : String(process.env.USERNAME ?? process.env.USER ?? "user").replace(
        /[^a-zA-Z0-9._-]+/g,
        "-"
      );
const FALLBACK_STATE_ROOT_DIR = path.join(
  os.tmpdir(),
  `codex-companion-${RUNTIME_USER_ID}`,
  "state"
);
const STATE_FILE_NAME = "state.json";
const STATE_LOCK_DIR_NAME = "state-lock";
const JOBS_DIR_NAME = "jobs";
const SESSION_ENDINGS_DIR_NAME = "session-endings";
const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_POLL_MS = 25;
/** @type {Set<string>} */
const activeStateLocks = new Set();

/** @returns {string} */
function nowIso() {
  return new Date().toISOString();
}

/** @returns {PersistedState} */
function defaultState() {
  return {
    version: STATE_VERSION,
    revision: 0,
    config: {
      stopReviewGate: false
    },
    endedSessions: [],
    retiredLegacyJobIds: [],
    jobs: []
  };
}

/** @param {string} cwd */
export function resolveStateDir(cwd) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  let canonicalWorkspaceRoot = workspaceRoot;
  try {
    canonicalWorkspaceRoot = fs.realpathSync.native(workspaceRoot);
  } catch {
    canonicalWorkspaceRoot = workspaceRoot;
  }

  const slugSource = path.basename(workspaceRoot) || "workspace";
  const slug = slugSource.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
  const hash = createHash("sha256").update(canonicalWorkspaceRoot).digest("hex").slice(0, 16);
  const pluginDataDir = process.env[COMPANION_DATA_ENV];
  const stateRoot = pluginDataDir ? path.join(pluginDataDir, "state") : FALLBACK_STATE_ROOT_DIR;
  return path.join(stateRoot, `${slug}-${hash}`);
}

/** @param {string} cwd */
export function resolveStateFile(cwd) {
  return path.join(resolveStateDir(cwd), STATE_FILE_NAME);
}

/** @param {string} cwd */
export function resolveJobsDir(cwd) {
  return path.join(resolveStateDir(cwd), JOBS_DIR_NAME);
}

/** @param {string} cwd */
function resolveSessionEndingsDir(cwd) {
  return path.join(resolveStateDir(cwd), SESSION_ENDINGS_DIR_NAME);
}

/** @param {string} cwd */
export function ensureStateDir(cwd) {
  hardenOwnedLegacyRuntimePath(resolveStateDir(cwd), "directory");
  hardenOwnedLegacyRuntimePath(resolveJobsDir(cwd), "directory");
  ensurePrivateRuntimeDirectory(resolveStateDir(cwd));
  ensurePrivateRuntimeDirectory(resolveJobsDir(cwd));
  ensurePrivateRuntimeDirectory(resolveSessionEndingsDir(cwd));
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} error @param {string} code */
function isErrorWithCode(error, code) {
  return error instanceof Error && "code" in error && error.code === code;
}

/** @param {string} runtimePath @param {"directory" | "file"} kind @returns {boolean} */
function hardenOwnedLegacyRuntimePath(runtimePath, kind) {
  let stats;
  try {
    stats = fs.lstatSync(runtimePath);
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
  const expectedUid =
    typeof process.getuid === "function" ? process.getuid() : null;
  const isExpectedKind =
    kind === "directory" ? stats.isDirectory() : stats.isFile();
  if (!isExpectedKind || stats.isSymbolicLink()) {
    throw new Error(
      `Legacy runtime path is not a regular ${kind}: ${runtimePath}.`
    );
  }
  if (
    process.platform !== "win32" &&
    expectedUid != null &&
    stats.uid !== expectedUid
  ) {
    throw new Error(`Legacy runtime path has the wrong owner: ${runtimePath}.`);
  }
  if (process.platform !== "win32" && (stats.mode & 0o022) !== 0) {
    throw new Error(
      `Legacy runtime path must not be writable by group or others: ${runtimePath}.`
    );
  }
  if (process.platform !== "win32") {
    fs.chmodSync(runtimePath, kind === "directory" ? 0o700 : 0o600);
  }
  return true;
}

/** @param {unknown} error */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** @param {unknown} jobId @param {string} source */
function assertValidJobId(jobId, source) {
  if (
    typeof jobId !== "string" ||
    !/^(?!\.{1,2}$)[a-zA-Z0-9._-]+$/.test(jobId)
  ) {
    throw new TypeError(`Invalid job id in ${source}.`);
  }
}

/** @param {unknown} job @param {string} source @param {string} jobsDir @returns {asserts job is JobRecord} */
function assertValidJobRecord(job, source, jobsDir) {
  if (
    !isRecord(job) ||
    typeof job.id !== "string" ||
    !isJobStatus(job.status) ||
    !/^(?!\.{1,2}$)[a-zA-Z0-9._-]+$/.test(job.id)
  ) {
    throw new TypeError(`Invalid job record in ${source}.`);
  }
  if (job.worker !== undefined && job.worker !== null && !isOwnedWorker(job.worker)) {
    throw new TypeError(`Invalid owned worker in ${source}.`);
  }
  if (
    job.launcher !== undefined &&
    job.launcher !== null &&
    !isProcessIdentity(job.launcher)
  ) {
    throw new TypeError(`Invalid launcher identity in ${source}.`);
  }
  if (job.steering !== undefined && job.steering !== null) {
    if (!isSteeringDescriptor(job.steering)) {
      throw new TypeError(`Invalid steering descriptor in ${source}.`);
    }
    if (!sameOwnedWorkerGeneration(job.worker, job.steering.worker)) {
      throw new TypeError(`Steering worker does not match its job in ${source}.`);
    }
  }
  if (
    job.logFile !== undefined &&
    job.logFile !== null &&
    (typeof job.logFile !== "string" ||
      job.logFile !== path.join(jobsDir, `${job.id}.log`))
  ) {
    throw new TypeError(`Invalid job log path in ${source}.`);
  }
}

/** @param {JobRecord} job */
function hardenJobLogArtifact(job) {
  if (job.logFile && hardenOwnedLegacyRuntimePath(job.logFile, "file")) {
    assertPrivateRuntimeFile(job.logFile);
  }
}

/** @param {unknown} parsed @param {string} stateFile @returns {asserts parsed is StoredState} */
function validatePersistedState(parsed, stateFile) {
  if (!isRecord(parsed)) {
    throw new TypeError(`Invalid state file ${stateFile}: expected an object.`);
  }
  if (parsed.version !== STATE_VERSION) {
    throw new Error(
      `Unsupported state version in ${stateFile}: expected ${STATE_VERSION}.`
    );
  }
  if (!Array.isArray(parsed.jobs)) {
    throw new TypeError(`Invalid state file ${stateFile}: jobs must be an array.`);
  }
  const jobsDir = path.join(path.dirname(stateFile), JOBS_DIR_NAME);
  for (const job of parsed.jobs) {
    assertValidJobRecord(job, stateFile, jobsDir);
  }
  if (parsed.config !== undefined && !isRecord(parsed.config)) {
    throw new TypeError(`Invalid state file ${stateFile}: config must be an object.`);
  }
  if (
    parsed.endedSessions !== undefined &&
    (!Array.isArray(parsed.endedSessions) ||
      parsed.endedSessions.some(
        (entry) =>
          !isRecord(entry) ||
          typeof entry.sessionId !== "string" ||
          entry.sessionId.length === 0 ||
          typeof entry.endedAt !== "string" ||
          (entry.token !== undefined && typeof entry.token !== "string")
      ))
  ) {
    throw new TypeError(
      `Invalid state file ${stateFile}: endedSessions entries are invalid.`
    );
  }
  if (
    parsed.retiredLegacyJobIds !== undefined &&
    (!Array.isArray(parsed.retiredLegacyJobIds) ||
      parsed.retiredLegacyJobIds.some(
        (jobId) =>
          typeof jobId !== "string" ||
          !/^(?!\.{1,2}$)[a-zA-Z0-9._-]+$/.test(jobId)
      ))
  ) {
    throw new TypeError(
      `Invalid state file ${stateFile}: retiredLegacyJobIds entries are invalid.`
    );
  }
}

/** @param {string} cwd */
function listLegacyJobEntries(cwd) {
  const jobsDir = resolveJobsDir(cwd);
  try {
    const entries = fs
      .readdirSync(jobsDir, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(".json"));
    for (const entry of entries) {
      if (!entry.isFile()) {
        throw new Error(
          `Legacy job manifest is not a regular file: ${path.join(jobsDir, entry.name)}.`
        );
      }
    }
    return entries;
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return [];
    }
    throw error;
  }
}

/** @param {string} cwd @param {string[]} retiredLegacyJobIds @returns {JobRecord[]} */
function readLegacyJobManifests(cwd, retiredLegacyJobIds = []) {
  const retiredIds = new Set(retiredLegacyJobIds);
  const jobsDir = resolveJobsDir(cwd);
  return listLegacyJobEntries(cwd)
    .filter(
      (entry) =>
        !retiredIds.has(entry.name.slice(0, -".json".length))
    )
    .map((entry) => {
      const jobId = entry.name.slice(0, -".json".length);
      const manifestFile = path.join(jobsDir, entry.name);
      assertValidJobId(jobId, manifestFile);
      hardenOwnedLegacyRuntimePath(manifestFile, "file");
      assertPrivateRuntimeFile(manifestFile);
      /** @type {unknown} */
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      assertValidJobRecord(manifest, manifestFile, jobsDir);
      if (manifest.id !== jobId) {
        throw new TypeError(
          `Invalid legacy job manifest ${manifestFile}: id must match its filename.`
        );
      }
      hardenJobLogArtifact(manifest);
      return manifest;
    });
}

/** @param {string} cwd @param {JobRecord[]} jobs @param {string[]} retiredLegacyJobIds */
function mergeLegacyJobManifests(cwd, jobs, retiredLegacyJobIds) {
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  for (const manifest of readLegacyJobManifests(cwd, retiredLegacyJobIds)) {
    const indexedJob = jobsById.get(manifest.id);
    jobsById.set(
      manifest.id,
      indexedJob
        ? { ...manifest, ...indexedJob, id: manifest.id }
        : manifest
    );
  }
  return [...jobsById.values()];
}

/** @param {unknown} parsed @param {string} markerFile @returns {SessionEnding & { token: string }} */
function validateSessionEndingMarker(parsed, markerFile) {
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.sessionId !== "string" ||
    parsed.sessionId.length === 0 ||
    typeof parsed.endedAt !== "string" ||
    typeof parsed.token !== "string" ||
    parsed.token.length === 0
  ) {
    throw new TypeError(`Invalid session ending marker ${markerFile}.`);
  }
  return {
    sessionId: parsed.sessionId,
    endedAt: parsed.endedAt,
    token: parsed.token
  };
}

/** @param {string} cwd @returns {Array<SessionEnding & { token: string, markerFile: string }>} */
function readSessionEndingMarkers(cwd) {
  const markerDir = resolveSessionEndingsDir(cwd);
  ensurePrivateRuntimeDirectory(markerDir);
  return fs
    .readdirSync(markerDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => {
      const markerFile = path.join(markerDir, entry.name);
      assertPrivateRuntimeFile(markerFile);
      const marker = validateSessionEndingMarker(
        JSON.parse(fs.readFileSync(markerFile, "utf8")),
        markerFile
      );
      if (entry.name !== `${marker.token}.json`) {
        throw new TypeError(
          `Invalid session ending marker filename ${markerFile}.`
        );
      }
      return { ...marker, markerFile };
    });
}

/** @param {SessionEnding[]} persistedEntries @param {SessionEnding[]} markerEntries @returns {SessionEnding[]} */
function mergeEndedSessions(persistedEntries, markerEntries) {
  const newestBySession = new Map();
  for (const entry of [...persistedEntries, ...markerEntries]) {
    const current = newestBySession.get(entry.sessionId);
    if (
      current == null ||
      entry.endedAt > current.endedAt
    ) {
      newestBySession.set(entry.sessionId, {
        sessionId: entry.sessionId,
        endedAt: entry.endedAt,
        ...(entry.token === undefined ? {} : { token: entry.token })
      });
    }
  }
  return [...newestBySession.values()];
}

/** @param {string} cwd @returns {PersistedState} */
export function loadState(cwd) {
  ensureStateDir(cwd);
  const stateFile = resolveStateFile(cwd);
  /** @type {StoredState} */
  let parsed;
  try {
    hardenOwnedLegacyRuntimePath(stateFile, "file");
    assertPrivateRuntimeFile(stateFile);
    /** @type {unknown} */
    const candidate = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    validatePersistedState(candidate, stateFile);
    for (const job of candidate.jobs) {
      hardenJobLogArtifact(job);
    }
    parsed = candidate;
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) {
      throw error;
    }
    parsed = defaultState();
  }

  return {
    ...defaultState(),
    ...parsed,
    config: {
      ...defaultState().config,
      ...(parsed.config ?? {})
    },
    endedSessions: mergeEndedSessions(
      Array.isArray(parsed.endedSessions) ? parsed.endedSessions : [],
      readSessionEndingMarkers(cwd)
    ),
    retiredLegacyJobIds: Array.isArray(parsed.retiredLegacyJobIds)
      ? parsed.retiredLegacyJobIds
      : [],
    jobs: mergeLegacyJobManifests(
      cwd,
      parsed.jobs,
      parsed.retiredLegacyJobIds ?? []
    )
  };
}

/** @param {JobRecord[]} jobs */
function pruneJobs(jobs) {
  return [...jobs].sort((left, right) =>
    String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? ""))
  );
}

/** @param {SessionEnding[]} entries */
function pruneEndedSessions(entries) {
  return [...entries].sort((left, right) =>
    right.endedAt.localeCompare(left.endedAt)
  );
}

/** @param {string | null | undefined} filePath */
function removeFileIfExists(filePath) {
  if (!filePath) {
    return false;
  }
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch (error) {
    if (!isErrorWithCode(error, "ENOENT")) {
      throw error;
    }
    return false;
  }
}

/** @param {string} filePath */
function syncFile(filePath) {
  const fileDescriptor = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(fileDescriptor);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

/** @param {string} directoryPath @param {NodeJS.Platform} platform */
function syncDirectory(directoryPath, platform = process.platform) {
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(directoryPath, "r");
  } catch (error) {
    if (
      platform === "win32" &&
      error instanceof Error &&
      "code" in error &&
      typeof error.code === "string" &&
      ["EACCES", "EPERM", "EISDIR", "EINVAL", "ENOTSUP"].includes(error.code)
    ) {
      return false;
    }
    throw error;
  }
  try {
    fs.fsyncSync(fileDescriptor);
  } catch (error) {
    if (
      platform !== "win32" ||
      !(error instanceof Error) ||
      !("code" in error) ||
      typeof error.code !== "string" ||
      !["EACCES", "EPERM", "EISDIR", "EINVAL", "ENOTSUP"].includes(error.code)
    ) {
      throw error;
    }
    return false;
  } finally {
    fs.closeSync(fileDescriptor);
  }
  return true;
}

/** @param {string} filePath @param {string} content @param {WriteOptions} options */
function writeFileAtomic(filePath, content, options = {}) {
  const candidatePath = path.join(
    path.dirname(filePath),
    `.candidate-${process.pid}-${randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(candidatePath, content, {
      encoding: "utf8",
      mode: 0o600
    });
    if (options.durable) {
      syncFile(candidatePath);
    }
    fs.renameSync(candidatePath, filePath);
    if (options.durable) {
      return {
        directorySynced: syncDirectory(
          path.dirname(filePath),
          options.platform
        )
      };
    }
    return { directorySynced: false };
  } finally {
    removeFileIfExists(candidatePath);
  }
}

/** @param {Partial<PersistedState>} state @param {number} revision @returns {PersistedState} */
function normalizeState(state, revision) {
  return {
    version: STATE_VERSION,
    revision,
    config: {
      ...defaultState().config,
      ...(state.config ?? {})
    },
    endedSessions: pruneEndedSessions(state.endedSessions ?? []),
    retiredLegacyJobIds: [...new Set(state.retiredLegacyJobIds ?? [])].sort(),
    jobs: pruneJobs(state.jobs ?? [])
  };
}

/** @param {number} durationMs */
function sleepSync(durationMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, durationMs);
}

/** @param {unknown} value @returns {value is PromiseLike<unknown>} */
function isThenable(value) {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

/** @param {string} content @returns {LockMetadata | null} */
function parseLockMetadata(content) {
  try {
    const parsed = JSON.parse(content);
    if (
      parsed?.version !== 2 ||
      typeof parsed.token !== "string" ||
      parsed.token.length === 0 ||
      !Number.isSafeInteger(parsed.pid) ||
      parsed.pid <= 0 ||
      typeof parsed.startKey !== "string" ||
      !parsed.startKey ||
      typeof parsed.acquiredAt !== "string" ||
      !Number.isSafeInteger(parsed.ticket) ||
      parsed.ticket < 0
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** @param {string} filePath */
function readLockMetadata(filePath) {
  try {
    assertPrivateRuntimeFile(filePath);
    return parseLockMetadata(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (isErrorWithCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
}

/** @param {string} filePath @param {LockMetadata} metadata */
function writeLockMetadata(filePath, metadata) {
  writeFileAtomic(filePath, `${JSON.stringify(metadata)}\n`);
}

/** @param {string} lockDir @param {string} prefix */
function listLockFiles(lockDir, prefix) {
  return fs
    .readdirSync(lockDir)
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(lockDir, name));
}

/**
 * @param {string} lockDir
 * @param {string} prefix
 * @param {TransactionOptions & { deadlineAt: number }} options
 * @returns {LockEntry[]}
 */
function cleanAndReadLockFiles(lockDir, prefix, options) {
  /** @type {LockEntry[]} */
  const entries = [];
  const inspectProcessIdentityImpl =
    options.inspectProcessIdentityImpl ?? inspectProcessIdentity;
  for (const filePath of listLockFiles(lockDir, prefix)) {
    const metadata = readLockMetadata(filePath);
    if (metadata === null) {
      if (!fs.existsSync(filePath)) {
        continue;
      }
      throw new Error(`State lock metadata is invalid at ${filePath}.`);
    }
    const owner = inspectProcessIdentityImpl(metadata.pid, {
      deadlineAt: options.deadlineAt
    });
    const ownerIsGone = owner === null && !isProcessAlive(metadata.pid);
    const pidWasReused =
      owner !== null && owner.startKey !== metadata.startKey;
    if (ownerIsGone || pidWasReused) {
      removeFileIfExists(filePath);
      continue;
    }
    entries.push({ filePath, metadata });
  }
  return entries;
}

/** @param {LockEntry} left @param {LockEntry} right */
function compareTickets(left, right) {
  if (left.metadata.ticket !== right.metadata.ticket) {
    return left.metadata.ticket - right.metadata.ticket;
  }
  return left.metadata.token.localeCompare(right.metadata.token);
}

/** @param {string} cwd @param {TransactionOptions} options @returns {StateLock} */
function acquireStateLock(cwd, options = {}) {
  ensureStateDir(cwd);
  const stateDir = resolveStateDir(cwd);
  const lockDir = path.join(stateDir, STATE_LOCK_DIR_NAME);
  if (activeStateLocks.has(lockDir)) {
    throw new Error(`State transaction is already active for ${stateDir}.`);
  }

  ensurePrivateRuntimeDirectory(lockDir);
  activeStateLocks.add(lockDir);
  const token = randomUUID();
  const choosingFile = path.join(lockDir, `choosing-${token}.json`);
  /** @type {string | null} */
  let ticketFile = null;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const deadlineAt = Date.now() + timeoutMs;
  const boundedOptions = { ...options, deadlineAt };
  const inspectProcessIdentityImpl =
    options.inspectProcessIdentityImpl ?? inspectProcessIdentity;

  try {
    const owner = inspectProcessIdentityImpl(process.pid, {
      deadlineAt
    });
    if (!owner?.startKey) {
      throw new Error(`Cannot identify state lock owner ${process.pid}.`);
    }
    writeLockMetadata(choosingFile, {
      version: 2,
      token,
      pid: process.pid,
      startKey: owner.startKey,
      acquiredAt: nowIso(),
      ticket: 0
    });
    const existingTickets = cleanAndReadLockFiles(
      lockDir,
      "ticket-",
      boundedOptions
    );
    const ticket =
      existingTickets.reduce(
        (highest, entry) => Math.max(highest, entry.metadata.ticket),
        0
      ) + 1;
    ticketFile = path.join(lockDir, `ticket-${String(ticket).padStart(12, "0")}-${token}.json`);
    writeLockMetadata(ticketFile, {
      version: 2,
      token,
      pid: process.pid,
      startKey: owner.startKey,
      acquiredAt: nowIso(),
      ticket
    });
    removeFileIfExists(choosingFile);

    while (true) {
      const choosing = cleanAndReadLockFiles(
        lockDir,
        "choosing-",
        boundedOptions
      );
      const tickets = cleanAndReadLockFiles(
        lockDir,
        "ticket-",
        boundedOptions
      ).sort(compareTickets);
      if (
        choosing.length === 0 &&
        tickets[0]?.metadata.token === token
      ) {
        return { lockDir, ticketFile, token };
      }
      if (Date.now() >= deadlineAt) {
        throw new Error(`Timed out waiting for state lock at ${lockDir}.`);
      }
      sleepSync(Math.min(pollMs, Math.max(0, deadlineAt - Date.now())));
    }
  } catch (error) {
    removeFileIfExists(choosingFile);
    removeFileIfExists(ticketFile);
    activeStateLocks.delete(lockDir);
    throw error;
  }
}

/** @param {StateLock} lock */
function releaseStateLock(lock) {
  try {
    const metadata = readLockMetadata(lock.ticketFile);
    if (metadata?.token === lock.token) {
      removeFileIfExists(lock.ticketFile);
    }
  } finally {
    activeStateLocks.delete(lock.lockDir);
  }
}

/** @param {string} cwd @param {JobRecord[]} previousJobs @param {JobRecord[]} jobs @param {TransactionOptions} options */
function cleanupRetiredArtifacts(cwd, previousJobs, jobs, options = {}) {
  const removeFileIfExistsImpl =
    options.removeFileIfExistsImpl ?? removeFileIfExists;
  /** @param {string} jobId */
  const resolveLegacyJobFile = (jobId) =>
    path.join(resolveJobsDir(cwd), `${jobId}.json`);
  const retainedIds = new Set(jobs.map((job) => job.id));
  const artifactPaths = new Set(
    jobs
      .filter((job) => !isActiveJobStatus(job.status))
      .map((job) => resolveLegacyJobFile(job.id))
  );
  for (const job of previousJobs) {
    if (retainedIds.has(job.id)) {
      continue;
    }
    artifactPaths.add(resolveLegacyJobFile(job.id));
    if (typeof job.logFile === "string" && job.logFile) {
      artifactPaths.add(job.logFile);
    }
  }

  const changedDirectories = new Set();
  for (const filePath of artifactPaths) {
    try {
      if (removeFileIfExistsImpl(filePath) !== false) {
        changedDirectories.add(path.dirname(filePath));
      }
    } catch (error) {
      process.stderr.write(`State artifact cleanup deferred for ${filePath}: ${errorMessage(error)}\n`);
    }
  }
  for (const directoryPath of changedDirectories) {
    try {
      syncDirectory(directoryPath, options.platform);
    } catch (error) {
      process.stderr.write(
        `State artifact directory sync deferred for ${directoryPath}: ${errorMessage(error)}\n`
      );
    }
  }
}

/** @param {string} cwd @param {PersistedState} previousState @param {PersistedState} state @param {TransactionOptions} options */
function commitState(cwd, previousState, state, options = {}) {
  ensureStateDir(cwd);
  const nextRevision = Number.isSafeInteger(previousState.revision)
    ? previousState.revision + 1
    : 1;
  const legacyManifestIds = new Set(
    listLegacyJobEntries(cwd).map((entry) =>
      entry.name.slice(0, -".json".length)
    )
  );
  const retainedJobIds = new Set(state.jobs.map((job) => job.id));
  const retiredLegacyJobIds = new Set(state.retiredLegacyJobIds ?? []);
  for (const job of state.jobs) {
    if (
      legacyManifestIds.has(job.id) &&
      !isActiveJobStatus(job.status)
    ) {
      retiredLegacyJobIds.add(job.id);
    }
  }
  for (const job of previousState.jobs) {
    if (
      legacyManifestIds.has(job.id) &&
      !retainedJobIds.has(job.id)
    ) {
      retiredLegacyJobIds.add(job.id);
    }
  }
  const nextState = normalizeState(
    {
      ...state,
      retiredLegacyJobIds: [...retiredLegacyJobIds]
    },
    nextRevision
  );
  validatePersistedState(nextState, resolveStateFile(cwd));

  const durability = writeFileAtomic(
    resolveStateFile(cwd),
    `${JSON.stringify(nextState, null, 2)}\n`,
    {
      durable: true,
      platform: options.platform
    }
  );
  if (durability.directorySynced) {
    cleanupRetiredArtifacts(cwd, previousState.jobs, nextState.jobs, options);
  }

  return nextState;
}

/**
 * @template T
 * @param {string} cwd
 * @param {(state: PersistedState) => T} mutate
 * @param {TransactionOptions} options
 * @returns {{ result: T, state: PersistedState }}
 */
function runStateTransaction(cwd, mutate, options = {}) {
  const lock = acquireStateLock(cwd, options);
  try {
    const previousState = loadState(cwd);
    const state = structuredClone(previousState);
    const result = mutate(state);
    if (isThenable(result)) {
      throw new TypeError("State transactions must use a synchronous callback.");
    }
    const currentMetadata = readLockMetadata(lock.ticketFile);
    if (currentMetadata?.token !== lock.token) {
      throw new Error(`State lock ownership was lost for ${resolveStateDir(cwd)}.`);
    }
    return {
      result,
      state: commitState(cwd, previousState, state, options)
    };
  } finally {
    releaseStateLock(lock);
  }
}

/**
 * @template T
 * @param {string} cwd
 * @param {(state: PersistedState) => T} mutate
 * @param {TransactionOptions} options
 * @returns {T}
 */
export function withStateTransaction(cwd, mutate, options = {}) {
  return runStateTransaction(cwd, mutate, options).result;
}

/** @param {string} prefix */
export function generateJobId(prefix = "job") {
  const random = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

/** @param {PersistedState} state @param {JobRecord} jobPatch @returns {JobRecord} */
function upsertJobInTransaction(state, jobPatch) {
  const timestamp = nowIso();
  const existingIndex = state.jobs.findIndex((job) => job.id === jobPatch.id);
  const indexedJob = existingIndex === -1 ? null : state.jobs[existingIndex];
  const nextJob = {
    createdAt: timestamp,
    ...(indexedJob ?? {}),
    ...jobPatch,
    updatedAt: timestamp
  };
  if (existingIndex === -1) {
    state.jobs.unshift(nextJob);
  } else {
    state.jobs[existingIndex] = nextJob;
  }
  return nextJob;
}

/** @param {string} cwd @param {JobRecord} jobPatch */
export function upsertJob(cwd, jobPatch) {
  return runStateTransaction(cwd, (state) => {
    upsertJobInTransaction(state, jobPatch);
  }).state;
}

/** @param {string} cwd @param {JobRecord} jobPatch */
export function preserveLaunchCleanupJob(cwd, jobPatch) {
  return runStateTransaction(cwd, (state) => {
    const indexedJob = state.jobs.find((job) => job.id === jobPatch.id) ?? null;
    const existing = indexedJob;
    if (existing && existing.launchToken !== jobPatch.launchToken) {
      return { preserved: false, job: existing };
    }
    if (
      existing &&
      existing.status !== "queued" &&
      existing.status !== "cancelling"
    ) {
      return { preserved: false, job: existing };
    }
    return {
      preserved: true,
      job: upsertJobInTransaction(state, jobPatch)
    };
  }).result;
}

/** @param {string} cwd @param {JobRecord} job */
export function createJobIfSessionActive(cwd, job) {
  return runStateTransaction(cwd, (state) => {
    if (
      job.sessionId &&
      state.endedSessions.some((entry) => entry.sessionId === job.sessionId)
    ) {
      return { created: false, job: null };
    }
    const existingSingleton = job.singletonKey
      ? state.jobs.find(
          (candidate) =>
            candidate.singletonKey === job.singletonKey &&
            candidate.sessionId === job.sessionId &&
            isActiveJobStatus(candidate.status)
        ) ?? null
      : null;
    if (existingSingleton) {
      return { created: false, job: existingSingleton };
    }
    return {
      created: true,
      job: upsertJobInTransaction(state, job)
    };
  }).result;
}

/** @param {string} cwd @param {string} sessionId */
export function markSessionEnding(cwd, sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TypeError("Session ending requires a non-empty session id.");
  }
  ensureStateDir(cwd);
  const entry = {
    sessionId,
    endedAt: nowIso(),
    token: randomUUID()
  };
  writeFileAtomic(
    path.join(resolveSessionEndingsDir(cwd), `${entry.token}.json`),
    `${JSON.stringify({ version: 1, ...entry })}\n`,
    { durable: true }
  );
  return entry;
}

/** @param {string} cwd @param {SessionEnding[]} expectedEntries @param {TransactionOptions} options */
export function clearSessionEndingsIf(cwd, expectedEntries, options = {}) {
  const clearing = runStateTransaction(cwd, (state) => {
    const expectedBySession = new Map(
      expectedEntries.map((entry) => [entry.sessionId, entry])
    );
    const markers = readSessionEndingMarkers(cwd);
    /** @type {string[]} */
    const clearedSessionIds = [];
    /** @type {string[]} */
    const conflictedSessionIds = [];
    /** @type {string[]} */
    const markerFiles = [];
    for (const expected of expectedBySession.values()) {
      const indexedEntry = state.endedSessions.find(
        (entry) => entry.sessionId === expected.sessionId
      );
      const sessionMarkers = markers.filter(
        (entry) => entry.sessionId === expected.sessionId
      );
      /** @param {SessionEnding} entry */
      const matchesExpected = (entry) =>
        expected.token === undefined
          ? entry.token === undefined && entry.endedAt === expected.endedAt
          : entry.token === expected.token;
      const exactMarkers = sessionMarkers.filter(matchesExpected);
      const expectedExists =
        (indexedEntry != null && matchesExpected(indexedEntry)) ||
        exactMarkers.length > 0;
      if (!expectedExists) {
        conflictedSessionIds.push(expected.sessionId);
        continue;
      }

      markerFiles.push(...exactMarkers.map((entry) => entry.markerFile));
      const conflictingEntries = [
        ...(indexedEntry != null && !matchesExpected(indexedEntry)
          ? [indexedEntry]
          : []),
        ...sessionMarkers.filter((entry) => !matchesExpected(entry))
      ];
      state.endedSessions = state.endedSessions.filter(
        (entry) => entry.sessionId !== expected.sessionId
      );
      const remaining = mergeEndedSessions([], conflictingEntries)[0];
      if (remaining == null) {
        clearedSessionIds.push(expected.sessionId);
      } else {
        conflictedSessionIds.push(expected.sessionId);
        state.endedSessions.push(remaining);
      }
    }
    return { clearedSessionIds, conflictedSessionIds, markerFiles };
  }, options).result;
  let markersChanged = false;
  for (const markerFile of clearing.markerFiles) {
    markersChanged = removeFileIfExists(markerFile) || markersChanged;
  }
  if (markersChanged) {
    syncDirectory(resolveSessionEndingsDir(cwd));
  }
  return {
    clearedSessionIds: clearing.clearedSessionIds,
    conflictedSessionIds: clearing.conflictedSessionIds
  };
}

/** @param {string} cwd */
export function listJobs(cwd) {
  return loadState(cwd).jobs;
}

/** @param {string} cwd @param {string} key @param {unknown} value */
export function setConfig(cwd, key, value) {
  return runStateTransaction(cwd, (state) => {
    state.config = {
      ...state.config,
      [key]: value
    };
  }).state;
}

/** @param {string} cwd @returns {PluginConfig} */
export function getConfig(cwd) {
  return loadState(cwd).config;
}

/**
 * @param {string} cwd
 * @param {string} jobId
 * @param {(job: JobRecord) => boolean} predicate
 * @param {(job: JobRecord) => Partial<JobRecord> | null} mutate
 * @param {TransactionOptions} options
 */
export function mutateJobIf(cwd, jobId, predicate, mutate, options = {}) {
  return runStateTransaction(cwd, (state) => {
    const existingIndex = state.jobs.findIndex((job) => job.id === jobId);
    if (existingIndex === -1) {
      return { matched: false, removed: false, job: null };
    }

    const currentJob = state.jobs[existingIndex];
    const matches = predicate(currentJob);
    if (isThenable(matches)) {
      throw new TypeError("Job predicates must use a synchronous callback.");
    }
    if (!matches) {
      return { matched: false, removed: false, job: currentJob };
    }

    const mutation = mutate(currentJob);
    if (isThenable(mutation)) {
      throw new TypeError("Job mutations must use a synchronous callback.");
    }
    if (mutation === null) {
      state.jobs.splice(existingIndex, 1);
      state.retiredLegacyJobIds = [
        ...(state.retiredLegacyJobIds ?? []),
        jobId
      ];
      return { matched: true, removed: true, job: currentJob };
    }

    const nextJob = {
      ...currentJob,
      ...mutation,
      id: jobId,
      updatedAt: nowIso()
    };
    state.jobs[existingIndex] = nextJob;
    return { matched: true, removed: false, job: nextJob };
  }, options).result;
}

/** @param {string} cwd @param {string} jobId @param {(job: JobRecord) => boolean} predicate @param {TransactionOptions} options */
export function removeJobIf(cwd, jobId, predicate, options = {}) {
  return mutateJobIf(cwd, jobId, predicate, () => null, options);
}

/** @param {string} cwd @param {string} jobId */
export function resolveJobLogFile(cwd, jobId) {
  assertValidJobId(jobId, "job log path");
  ensureStateDir(cwd);
  return path.join(resolveJobsDir(cwd), `${jobId}.log`);
}
