import { getSessionRuntimeStatus } from "./codex.mjs";
import { isActiveJobStatus } from "./job-lifecycle.mjs";
import { getConfig, listJobs } from "./state.mjs";
import { readJobLogTail, SESSION_ID_ENV } from "./tracked-jobs.mjs";
import { resolveWorkspaceRoot } from "./workspace.mjs";

export const DEFAULT_MAX_STATUS_JOBS = 8;
export const DEFAULT_MAX_PROGRESS_LINES = 4;

/**
 * @typedef {import("./reliability-contracts").JobRecord} JobRecord
 *
 * @typedef {{
 *   env?: NodeJS.ProcessEnv,
 *   maxJobs?: number,
 *   maxProgressLines?: number,
 *   sessionId?: string | null,
 *   all?: boolean
 * }} JobSelectionOptions
 */

/** @param {JobRecord} job */
function isCancellableJob(job) {
  return isActiveJobStatus(job.status) && job.worker?.token;
}

/** @param {JobRecord[]} jobs */
export function sortJobsNewestFirst(jobs) {
  return [...jobs].sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
}

/** @param {JobSelectionOptions} [options] */
function getCurrentSessionId(options = {}) {
  if (options.sessionId !== undefined) {
    return options.sessionId;
  }
  return options.env?.[SESSION_ID_ENV] ?? process.env[SESSION_ID_ENV] ?? null;
}

// Session scoping is listing visibility only, never an access condition on a job id.
/** @param {JobRecord[]} jobs @param {JobSelectionOptions} [options] */
function filterJobsForSessionVisibility(jobs, options = {}) {
  const sessionId = getCurrentSessionId(options);
  if (!sessionId) {
    return jobs;
  }
  return jobs.filter((job) => job.sessionId === sessionId);
}

/** @param {JobRecord} job */
function getJobTypeLabel(job) {
  if (typeof job.kindLabel === "string" && job.kindLabel) {
    return job.kindLabel;
  }
  if (job.kind === "adversarial-review") {
    return "adversarial-review";
  }
  if (job.jobClass === "review") {
    return "review";
  }
  if (job.jobClass === "task") {
    return "rescue";
  }
  if (job.kind === "review") {
    return "review";
  }
  if (job.kind === "task") {
    return "rescue";
  }
  return "job";
}

/** @param {string} line */
function stripLogPrefix(line) {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

/** @param {string} line */
function isProgressBlockTitle(line) {
  return (
    ["Final output", "Assistant message", "Reasoning summary", "Review output"].includes(line) ||
    /^Subagent .+ message$/.test(line) ||
    /^Subagent .+ reasoning summary$/.test(line)
  );
}

/** @param {string | null | undefined} logFile @param {number} [maxLines] */
export function readJobProgressPreview(logFile, maxLines = DEFAULT_MAX_PROGRESS_LINES) {
  const tail = readJobLogTail(logFile);
  const lines = tail.content
    .split(/\r?\n/)
    .map((line) => line.trimEnd());
  if (tail.truncated) {
    lines.shift();
  }
  return lines
    .filter(Boolean)
    .filter((line) => line.startsWith("["))
    .map(stripLogPrefix)
    .filter((line) => line && !isProgressBlockTitle(line))
    .slice(-maxLines);
}

/** @param {string | null | undefined} startValue @param {string | null} [endValue] */
function formatElapsedDuration(startValue, endValue = null) {
  const start = Date.parse(startValue ?? "");
  if (!Number.isFinite(start)) {
    return null;
  }

  const end = endValue ? Date.parse(endValue) : Date.now();
  if (!Number.isFinite(end) || end < start) {
    return null;
  }

  const totalSeconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/** @param {string} line */
function looksLikeVerificationCommand(line) {
  return /\b(test|tests|lint|build|typecheck|type-check|check|verify|validate|pytest|jest|vitest|cargo test|npm test|pnpm test|yarn test|go test|mvn test|gradle test|tsc|eslint|ruff)\b/i.test(
    line
  );
}

/** @param {JobRecord} job @param {string[]} [progressPreview] */
function inferLegacyJobPhase(job, progressPreview = []) {
  switch (job.status) {
    case "queued":
      return "queued";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    default:
      break;
  }

  for (let index = progressPreview.length - 1; index >= 0; index -= 1) {
    const line = progressPreview[index].toLowerCase();
    if (line.startsWith("starting codex") || line.startsWith("thread ready") || line.startsWith("turn started")) {
      return "starting";
    }
    if (line.startsWith("reviewer started") || line.includes("review mode")) {
      return "reviewing";
    }
    if (line.startsWith("searching:") || line.startsWith("calling ") || line.startsWith("running tool:")) {
      return "investigating";
    }
    if (line.startsWith("starting collaboration tool:")) {
      return "investigating";
    }
    if (line.startsWith("running command:")) {
      return looksLikeVerificationCommand(line)
        ? "verifying"
        : job.jobClass === "review"
          ? "reviewing"
          : "investigating";
    }
    if (line.startsWith("command completed:")) {
      return looksLikeVerificationCommand(line) ? "verifying" : "running";
    }
    if (line.startsWith("applying ") || line.startsWith("file changes ")) {
      return "editing";
    }
    if (line.startsWith("turn completed")) {
      return "finalizing";
    }
    if (line.startsWith("codex error:") || line.startsWith("failed:")) {
      return "failed";
    }
  }

  return job.jobClass === "review" ? "reviewing" : "running";
}

/** @param {JobRecord} job @param {{ maxProgressLines?: number }} [options] */
export function enrichJob(job, options = {}) {
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;
  const enriched = {
    ...job,
    kindLabel: getJobTypeLabel(job),
    progressPreview:
      isActiveJobStatus(job.status) || job.status === "failed"
        ? readJobProgressPreview(job.logFile, maxProgressLines)
        : [],
    elapsed: formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? null),
    duration:
      job.status === "completed" || job.status === "failed" || job.status === "cancelled"
        ? formatElapsedDuration(job.startedAt ?? job.createdAt, job.completedAt ?? job.updatedAt)
        : null
  };

  return {
    ...enriched,
    phase: enriched.phase ?? inferLegacyJobPhase(enriched, enriched.progressPreview)
  };
}

/** @param {string} workspaceRoot @param {string} jobId */
export function readStoredJob(workspaceRoot, jobId) {
  return (
    listJobs(workspaceRoot).find(
      /** @param {JobRecord} job */ (job) => job.id === jobId
    ) ?? null
  );
}

/** @param {JobRecord[]} visibleJobs */
function describeVisibleJobs(visibleJobs) {
  if (visibleJobs.length === 0) {
    return "No job is visible for this Claude session.";
  }
  const listed = visibleJobs
    .slice(0, DEFAULT_MAX_STATUS_JOBS)
    .map((job) => `${job.id} (${job.status})`)
    .join(", ");
  return `Visible jobs: ${listed}. Run /codex:status to inspect known jobs.`;
}

/**
 * @param {JobRecord[]} jobs
 * @param {string | null | undefined} reference
 * @param {JobRecord[]} visibleJobs
 * @returns {JobRecord}
 */
function matchJobReference(jobs, reference, visibleJobs) {
  if (!reference) {
    throw new Error(
      `An explicit job id is required. ${describeVisibleJobs(visibleJobs)}`
    );
  }

  // Exact equality only: a prefix would let a short reference reach another session's job.
  const exact = jobs.find((job) => job.id === reference);
  if (exact) {
    return exact;
  }

  throw new Error(`No job found for "${reference}". Run /codex:status to list known jobs.`);
}

/** @param {string} cwd @param {JobSelectionOptions} [options] */
export function buildStatusSnapshot(cwd, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const config = getConfig(workspaceRoot);
  const jobs = sortJobsNewestFirst(filterJobsForSessionVisibility(listJobs(workspaceRoot), options));
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_STATUS_JOBS;
  const maxProgressLines = options.maxProgressLines ?? DEFAULT_MAX_PROGRESS_LINES;

  const running = jobs
    .filter((job) => isActiveJobStatus(job.status))
    .map((job) => enrichJob(job, { maxProgressLines }));

  const latestFinishedRaw = jobs.find((job) => !isActiveJobStatus(job.status)) ?? null;
  const latestFinished = latestFinishedRaw ? enrichJob(latestFinishedRaw, { maxProgressLines }) : null;

  const recent = (options.all ? jobs : jobs.slice(0, maxJobs))
    .filter((job) => !isActiveJobStatus(job.status) && job.id !== latestFinished?.id)
    .map((job) => enrichJob(job, { maxProgressLines }));

  return {
    workspaceRoot,
    config,
    sessionRuntime: getSessionRuntimeStatus(),
    running,
    latestFinished,
    recent,
    needsReview: Boolean(config.stopReviewGate)
  };
}

/**
 * @param {string} cwd
 * @param {string | null | undefined} reference
 * @param {{ maxProgressLines?: number }} [options]
 */
export function buildSingleJobSnapshot(cwd, reference, options = {}) {
  const { workspaceRoot, job: selected } = resolveRequestedJob(
    cwd,
    reference,
    options
  );

  return {
    workspaceRoot,
    job: enrichJob(selected, { maxProgressLines: options.maxProgressLines })
  };
}

/** @param {string} cwd @param {string | null | undefined} reference @param {JobSelectionOptions} [options] */
export function resolveRequestedJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobs = sortJobsNewestFirst(listJobs(workspaceRoot));
  return {
    workspaceRoot,
    job: matchJobReference(
      jobs,
      reference,
      filterJobsForSessionVisibility(jobs, options)
    )
  };
}

/** @param {string} workspaceRoot @param {string} jobId */
export function readFinishedJob(workspaceRoot, jobId) {
  const job = readStoredJob(workspaceRoot, jobId);
  if (!job) {
    throw new Error(`No job found for "${jobId}". Run /codex:status to list known jobs.`);
  }
  if (isActiveJobStatus(job.status)) {
    throw new Error(`Job ${job.id} is still ${job.status}. Check /codex:status and try again once it finishes.`);
  }
  return job;
}

/**
 * @param {string} cwd
 * @param {string | null | undefined} reference
 * @param {JobSelectionOptions} [options]
 */
export function resolveCancelableJob(cwd, reference, options = {}) {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const activeJobs = sortJobsNewestFirst(listJobs(workspaceRoot)).filter((job) =>
    isActiveJobStatus(job.status)
  );
  const selected = matchJobReference(
    activeJobs,
    reference,
    filterJobsForSessionVisibility(activeJobs, options)
  );
  if (!isCancellableJob(selected)) {
    throw new Error(
      `Job ${selected.id} is active but is not an owned background worker and cannot be cancelled.`
    );
  }
  return { workspaceRoot, job: selected };
}
