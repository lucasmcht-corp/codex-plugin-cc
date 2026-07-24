import { isActiveJobStatus } from "./job-lifecycle.mjs";

/**
 * @typedef {Record<string, unknown>} UnknownRecord
 *
 * @typedef {{
 *   verdict: string,
 *   summary: string,
 *   findings: unknown[],
 *   next_steps: unknown[]
 * }} ValidReviewResultData
 *
 * @typedef {{
 *   severity: string,
 *   title: string,
 *   body: string,
 *   file: string,
 *   line_start: number | null,
 *   line_end: number | null,
 *   recommendation: string
 * }} ReviewFinding
 *
 * @typedef {{
 *   id: string,
 *   status: string,
 *   kindLabel?: string,
 *   title?: string,
 *   jobClass?: string,
 *   phase?: string | null,
 *   elapsed?: string | null,
 *   duration?: string | null,
 *   threadId?: string | null,
 *   turnId?: string | null,
 *   steering?: object | null,
 *   worker?: { token?: string } | null,
 *   summary?: string | null,
 *   logFile?: string | null,
 *   write?: boolean,
 *   progressPreview?: string[],
 *   errorMessage?: string | null,
 *   rendered?: string | null,
 *   result?: unknown
 * }} RenderableJob
 *
 * @typedef {{
 *   parsed?: unknown,
 *   parseError?: string | null,
 *   rawOutput?: string | null,
 *   failureMessage?: string | null,
 *   reasoningSummary?: string[]
 * }} ParsedResult
 *
 * @typedef {{
 *   reviewLabel: string,
 *   targetLabel: string,
 *   reasoningSummary?: string[]
 * }} ReviewMeta
 */

/** @param {unknown} value @returns {value is UnknownRecord} */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** @param {string} severity */
function severityRank(severity) {
  switch (severity) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    default:
      return 3;
  }
}

/** @param {ReviewFinding} finding */
function formatLineRange(finding) {
  if (!finding.line_start) {
    return "";
  }
  if (!finding.line_end || finding.line_end === finding.line_start) {
    return `:${finding.line_start}`;
  }
  return `:${finding.line_start}-${finding.line_end}`;
}

/** @param {unknown} data */
function validateReviewResultShape(data) {
  if (!isRecord(data)) {
    return "Expected a top-level JSON object.";
  }
  if (typeof data.verdict !== "string" || !data.verdict.trim()) {
    return "Missing string `verdict`.";
  }
  if (typeof data.summary !== "string" || !data.summary.trim()) {
    return "Missing string `summary`.";
  }
  if (!Array.isArray(data.findings)) {
    return "Missing array `findings`.";
  }
  if (!Array.isArray(data.next_steps)) {
    return "Missing array `next_steps`.";
  }
  return null;
}

/** @param {unknown} data @returns {data is ValidReviewResultData} */
function isValidReviewResultData(data) {
  return validateReviewResultShape(data) === null;
}

/** @param {unknown} finding @param {number} index @returns {ReviewFinding} */
function normalizeReviewFinding(finding, index) {
  const source = isRecord(finding) ? finding : {};
  const lineStart =
    typeof source.line_start === "number" &&
    Number.isInteger(source.line_start) &&
    source.line_start > 0
      ? source.line_start
      : null;
  const lineEnd =
    typeof source.line_end === "number" &&
    Number.isInteger(source.line_end) &&
    source.line_end > 0 &&
    (!lineStart || source.line_end >= lineStart)
      ? source.line_end
      : lineStart;

  return {
    severity: typeof source.severity === "string" && source.severity.trim() ? source.severity.trim() : "low",
    title: typeof source.title === "string" && source.title.trim() ? source.title.trim() : `Finding ${index + 1}`,
    body: typeof source.body === "string" && source.body.trim() ? source.body.trim() : "No details provided.",
    file: typeof source.file === "string" && source.file.trim() ? source.file.trim() : "unknown",
    line_start: lineStart,
    line_end: lineEnd,
    recommendation: typeof source.recommendation === "string" ? source.recommendation.trim() : ""
  };
}

/** @param {ValidReviewResultData} data */
function normalizeReviewResultData(data) {
  return {
    verdict: data.verdict.trim(),
    summary: data.summary.trim(),
    findings: data.findings.map((finding, index) => normalizeReviewFinding(finding, index)),
    next_steps: data.next_steps.flatMap((step) =>
      typeof step === "string" && step.trim() ? [step.trim()] : []
    )
  };
}

/** @param {RenderableJob | null | undefined} storedJob */
function isStructuredReviewStoredResult(storedJob) {
  const result = storedJob?.result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    Object.prototype.hasOwnProperty.call(result, "result") ||
    Object.prototype.hasOwnProperty.call(result, "parseError")
  );
}

/** @param {RenderableJob | null | undefined} storedJob */
function readStoredRawOutput(storedJob) {
  const result = storedJob?.result;
  if (!isRecord(result)) {
    return "";
  }
  if (typeof result.rawOutput === "string" && result.rawOutput) {
    return result.rawOutput;
  }
  if (
    isRecord(result.codex) &&
    typeof result.codex.stdout === "string" &&
    result.codex.stdout
  ) {
    return result.codex.stdout;
  }
  return "";
}

/** @param {RenderableJob} job */
function formatJobLine(job) {
  const parts = [job.id, `${job.status || "unknown"}`];
  if (job.kindLabel) {
    parts.push(job.kindLabel);
  }
  if (job.title) {
    parts.push(job.title);
  }
  return parts.join(" | ");
}

/** @param {unknown} value */
function escapeMarkdownCell(value) {
  return String(value ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n/g, " ")
    .trim();
}

/** @param {RenderableJob | null | undefined} job */
function formatCodexResumeCommand(job) {
  if (!job?.threadId) {
    return null;
  }
  return `codex resume ${job.threadId}`;
}

/** @param {RenderableJob} job */
function isActiveJob(job) {
  return isActiveJobStatus(job.status);
}

/** @param {string[]} lines @param {RenderableJob[]} jobs */
function appendActiveJobsTable(lines, jobs) {
  lines.push("Active jobs:");
  lines.push("| Job | Kind | Status | Phase | Elapsed | Codex Session ID | Summary | Actions |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const job of jobs) {
    const actions = [`/codex:status ${job.id}`];
    if (
      job.status === "running" &&
      job.jobClass === "task" &&
      job.threadId &&
      job.turnId &&
      job.steering
    ) {
      actions.push(`/codex:send ${job.id} "instruction"`);
    }
    if (isActiveJob(job) && job.worker?.token) {
      actions.push(`/codex:cancel ${job.id}`);
    }
    lines.push(
      `| ${escapeMarkdownCell(job.id)} | ${escapeMarkdownCell(job.kindLabel)} | ${escapeMarkdownCell(job.status)} | ${escapeMarkdownCell(job.phase ?? "")} | ${escapeMarkdownCell(job.elapsed ?? "")} | ${escapeMarkdownCell(job.threadId ?? "")} | ${escapeMarkdownCell(job.summary ?? "")} | ${actions.map((action) => `\`${action}\``).join("<br>")} |`
    );
  }
}

/**
 * @param {string[]} lines
 * @param {RenderableJob} job
 * @param {{
 *   showElapsed?: boolean,
 *   showDuration?: boolean,
 *   showLog?: boolean,
 *   showCancelHint?: boolean,
 *   showResultHint?: boolean,
 *   showReviewHint?: boolean
 * }} [options]
 */
function pushJobDetails(lines, job, options = {}) {
  lines.push(`- ${formatJobLine(job)}`);
  if (job.summary) {
    lines.push(`  Summary: ${job.summary}`);
  }
  if (job.phase) {
    lines.push(`  Phase: ${job.phase}`);
  }
  if (options.showElapsed && job.elapsed) {
    lines.push(`  Elapsed: ${job.elapsed}`);
  }
  if (options.showDuration && job.duration) {
    lines.push(`  Duration: ${job.duration}`);
  }
  if (job.threadId) {
    lines.push(`  Codex session ID: ${job.threadId}`);
  }
  const resumeCommand = formatCodexResumeCommand(job);
  if (resumeCommand) {
    lines.push(`  Resume in Codex: ${resumeCommand}`);
  }
  if (job.logFile && options.showLog) {
    lines.push(`  Log: ${job.logFile}`);
  }
  if (isActiveJob(job) && job.worker?.token && options.showCancelHint) {
    lines.push(`  Cancel: /codex:cancel ${job.id}`);
  }
  if (!isActiveJob(job) && options.showResultHint) {
    lines.push(`  Result: /codex:result ${job.id}`);
  }
  if (!isActiveJob(job) && job.jobClass === "task" && job.write && options.showReviewHint) {
    lines.push("  Review changes: /codex:review --wait");
    lines.push("  Stricter review: /codex:adversarial-review --wait");
  }
  if (job.progressPreview?.length) {
    lines.push("  Progress:");
    for (const line of job.progressPreview) {
      lines.push(`    ${line}`);
    }
  }
}

/** @param {string[]} lines @param {string[] | null | undefined} reasoningSummary */
function appendReasoningSection(lines, reasoningSummary) {
  if (!Array.isArray(reasoningSummary) || reasoningSummary.length === 0) {
    return;
  }

  lines.push("", "Reasoning:");
  for (const section of reasoningSummary) {
    lines.push(`- ${section}`);
  }
}

/**
 * @param {{
 *   ready: boolean,
 *   node: { detail: string },
 *   npm: { detail: string },
 *   claude: { detail: string },
 *   codex: { detail: string },
 *   auth: { detail: string },
 *   sessionRuntime: { label: string },
 *   reviewGateEnabled: boolean,
 *   actionsTaken: string[],
 *   nextSteps: string[]
 * }} report
 */
export function renderSetupReport(report) {
  const lines = [
    "# Codex Setup",
    "",
    `Status: ${report.ready ? "ready" : "needs attention"}`,
    "",
    "Checks:",
    `- node: ${report.node.detail}`,
    `- npm: ${report.npm.detail}`,
    `- claude: ${report.claude.detail}`,
    `- codex: ${report.codex.detail}`,
    `- auth: ${report.auth.detail}`,
    `- session runtime: ${report.sessionRuntime.label}`,
    `- review gate: ${report.reviewGateEnabled ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.actionsTaken.length > 0) {
    lines.push("Actions taken:");
    for (const action of report.actionsTaken) {
      lines.push(`- ${action}`);
    }
    lines.push("");
  }

  if (report.nextSteps.length > 0) {
    lines.push("Next steps:");
    for (const step of report.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** @param {ParsedResult} parsedResult @param {ReviewMeta} meta */
export function renderReviewResult(parsedResult, meta) {
  if (!parsedResult.parsed) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      "",
      "Codex did not return valid structured JSON.",
      "",
      `- Parse error: ${parsedResult.parseError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }

  const validationError = validateReviewResultShape(parsedResult.parsed);
  if (validationError) {
    const lines = [
      `# Codex ${meta.reviewLabel}`,
      "",
      `Target: ${meta.targetLabel}`,
      "Codex returned JSON with an unexpected review shape.",
      "",
      `- Validation error: ${validationError}`
    ];

    if (parsedResult.rawOutput) {
      lines.push("", "Raw final message:", "", "```text", parsedResult.rawOutput, "```");
    }

    appendReasoningSection(lines, meta.reasoningSummary ?? parsedResult.reasoningSummary);

    return `${lines.join("\n").trimEnd()}\n`;
  }
  if (!isValidReviewResultData(parsedResult.parsed)) {
    throw new Error("Review result validation changed during rendering.");
  }

  const data = normalizeReviewResultData(parsedResult.parsed);
  const findings = [...data.findings].sort((left, right) => severityRank(left.severity) - severityRank(right.severity));
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    `Verdict: ${data.verdict}`,
    "",
    data.summary,
    ""
  ];

  if (findings.length === 0) {
    lines.push("No material findings.");
  } else {
    lines.push("Findings:");
    for (const finding of findings) {
      const lineSuffix = formatLineRange(finding);
      lines.push(`- [${finding.severity}] ${finding.title} (${finding.file}${lineSuffix})`);
      lines.push(`  ${finding.body}`);
      if (finding.recommendation) {
        lines.push(`  Recommendation: ${finding.recommendation}`);
      }
    }
  }

  if (data.next_steps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of data.next_steps) {
      lines.push(`- ${step}`);
    }
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * @param {{ stdout: string, stderr: string, status: number | null }} result
 * @param {ReviewMeta} meta
 */
export function renderNativeReviewResult(result, meta) {
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  const lines = [
    `# Codex ${meta.reviewLabel}`,
    "",
    `Target: ${meta.targetLabel}`,
    ""
  ];

  if (stdout) {
    lines.push(stdout);
  } else if (result.status === 0) {
    lines.push("Codex review completed without any stdout output.");
  } else {
    lines.push("Codex review failed.");
  }

  if (stderr) {
    lines.push("", "stderr:", "", "```text", stderr, "```");
  }

  appendReasoningSection(lines, meta.reasoningSummary);

  return `${lines.join("\n").trimEnd()}\n`;
}

/** @param {ParsedResult} parsedResult @param {object} _meta */
export function renderTaskResult(parsedResult, _meta) {
  const rawOutput = typeof parsedResult?.rawOutput === "string" ? parsedResult.rawOutput : "";
  if (rawOutput) {
    return rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
  }

  const message = String(parsedResult?.failureMessage ?? "").trim() || "Codex did not return a final message.";
  return `${message}\n`;
}

/**
 * @param {{
 *   sessionRuntime: { label: string },
 *   config: { stopReviewGate?: boolean },
 *   running: RenderableJob[],
 *   latestFinished: RenderableJob | null,
 *   recent: RenderableJob[],
 *   needsReview: boolean
 * }} report
 */
export function renderStatusReport(report) {
  const lines = [
    "# Codex Status",
    "",
    `Session runtime: ${report.sessionRuntime.label}`,
    `Review gate: ${report.config.stopReviewGate ? "enabled" : "disabled"}`,
    ""
  ];

  if (report.running.length > 0) {
    appendActiveJobsTable(lines, report.running);
    lines.push("");
    lines.push("Live details:");
    for (const job of report.running) {
      pushJobDetails(lines, job, {
        showElapsed: true,
        showLog: true
      });
    }
    lines.push("");
  }

  if (report.latestFinished) {
    lines.push("Latest finished:");
    pushJobDetails(lines, report.latestFinished, {
      showDuration: true,
      showLog: report.latestFinished.status === "failed"
    });
    lines.push("");
  }

  if (report.recent.length > 0) {
    lines.push("Recent jobs:");
    for (const job of report.recent) {
      pushJobDetails(lines, job, {
        showDuration: true,
        showLog: job.status === "failed"
      });
    }
    lines.push("");
  } else if (report.running.length === 0 && !report.latestFinished) {
    lines.push("No jobs recorded yet.", "");
  }

  if (report.needsReview) {
    lines.push("The stop-time review gate is enabled.");
    lines.push("Ending the session will trigger a fresh Codex adversarial review and block if it finds issues.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** @param {RenderableJob} job */
export function renderJobStatusReport(job) {
  const lines = ["# Codex Job Status", ""];
  pushJobDetails(lines, job, {
    showElapsed: isActiveJob(job),
    showDuration: !isActiveJob(job),
    showLog: true,
    showCancelHint: true,
    showResultHint: true,
    showReviewHint: true
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

/** @param {RenderableJob} job @param {RenderableJob | null | undefined} storedJob */
export function renderStoredJobResult(job, storedJob) {
  const threadId = storedJob?.threadId ?? job.threadId ?? null;
  const resumeCommand = threadId ? `codex resume ${threadId}` : null;
  if (isStructuredReviewStoredResult(storedJob) && storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  const rawOutput = readStoredRawOutput(storedJob);
  if (rawOutput) {
    const output = rawOutput.endsWith("\n") ? rawOutput : `${rawOutput}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  if (storedJob?.rendered) {
    const output = storedJob.rendered.endsWith("\n") ? storedJob.rendered : `${storedJob.rendered}\n`;
    if (!threadId) {
      return output;
    }
    return `${output}\nCodex session ID: ${threadId}\nResume in Codex: ${resumeCommand}\n`;
  }

  const lines = [
    `# ${job.title ?? "Codex Result"}`,
    "",
    `Job: ${job.id}`,
    `Status: ${job.status}`
  ];

  if (threadId) {
    lines.push(`Codex session ID: ${threadId}`);
    lines.push(`Resume in Codex: ${resumeCommand}`);
  }

  if (job.summary) {
    lines.push(`Summary: ${job.summary}`);
  }

  if (job.errorMessage) {
    lines.push("", job.errorMessage);
  } else if (storedJob?.errorMessage) {
    lines.push("", storedJob.errorMessage);
  } else {
    lines.push("", "No captured result payload was stored for this job.");
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

/** @param {RenderableJob} job */
export function renderCancelReport(job) {
  const lines = [
    "# Codex Cancel",
    "",
    `Cancelled ${job.id}.`,
    ""
  ];

  if (job.title) {
    lines.push(`- Title: ${job.title}`);
  }
  if (job.summary) {
    lines.push(`- Summary: ${job.summary}`);
  }
  lines.push("- Check `/codex:status` for the updated queue.");

  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * @param {{ jobId: string, requestId: string, threadId: string, turnId: string }} payload
 */
export function renderSteeringReport(payload) {
  return [
    "# Codex Steering",
    "",
    `Accepted instruction for ${payload.jobId}.`,
    `Request: ${payload.requestId}`,
    `Thread: ${payload.threadId}`,
    `Turn: ${payload.turnId}`,
    ""
  ].join("\n");
}
