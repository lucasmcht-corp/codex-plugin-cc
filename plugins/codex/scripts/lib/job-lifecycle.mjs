// @ts-check

import { createHash } from "node:crypto";

/** @typedef {import("./reliability-contracts").JobStatus} JobStatus */
/** @typedef {import("./reliability-contracts").OwnedWorker} OwnedWorker */
/** @typedef {import("./reliability-contracts").ProcessIdentity} ProcessIdentity */

/** @type {ReadonlySet<JobStatus>} */
const ACTIVE_JOB_STATUSES = new Set(["queued", "running", "cancelling"]);
const WINDOWS_JOB_PREFIX = "Local\\CodexPlugin-";

/** @param {string} token */
export function ownedWindowsJobName(token) {
  return `${WINDOWS_JOB_PREFIX}${createHash("sha256").update(token).digest("hex")}`;
}
/** @param {unknown} status @returns {status is JobStatus} */
export function isJobStatus(status) {
  return (
    status === "queued" ||
    status === "running" ||
    status === "cancelling" ||
    status === "completed" ||
    status === "failed" ||
    status === "cancelled"
  );
}

/**
 * @param {unknown} status
 * @returns {status is "queued" | "running" | "cancelling"}
 */
export function isActiveJobStatus(status) {
  return isJobStatus(status) && ACTIVE_JOB_STATUSES.has(status);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is ProcessIdentity} */
export function isProcessIdentity(value) {
  return (
    isRecord(value) &&
    typeof value.pid === "number" &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    typeof value.startKey === "string" &&
    Boolean(value.startKey)
  );
}

/** @param {unknown} left @param {unknown} right */
export function sameProcessGeneration(left, right) {
  return (
    isProcessIdentity(left) &&
    isProcessIdentity(right) &&
    left.pid === right.pid &&
    left.startKey === right.startKey
  );
}

/** @param {unknown} value @returns {value is OwnedWorker} */
export function isOwnedWorker(value) {
  if (
    !isRecord(value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.token !== "string" ||
    !value.token ||
    typeof value.startKey !== "string" ||
    !value.startKey
  ) {
    return false;
  }

  if (value.version === 2 && value.platform === "win32") {
    return (
      value.processGroupId === null &&
      typeof value.jobName === "string" &&
      value.jobName === ownedWindowsJobName(value.token)
    );
  }

  return (
    value.version === 1 &&
    value.platform === "linux" &&
    typeof value.processGroupId === "number" &&
    Number.isSafeInteger(value.processGroupId) &&
    value.processGroupId === value.pid
  );
}

/**
 * @param {unknown} left
 * @param {unknown} right
 */
export function sameOwnedWorkerGeneration(left, right) {
  if (
    !isOwnedWorker(left) ||
    !isOwnedWorker(right) ||
    left.version !== right.version ||
    left.platform !== right.platform ||
    left.pid !== right.pid ||
    left.token !== right.token ||
    left.startKey !== right.startKey
  ) {
    return false;
  }

  if (left.platform === "win32") {
    return right.platform === "win32" && left.jobName === right.jobName;
  }

  return right.platform !== "win32" && left.processGroupId === right.processGroupId;
}
