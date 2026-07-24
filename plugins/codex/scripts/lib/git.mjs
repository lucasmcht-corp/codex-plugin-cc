import fs from "node:fs";
import path from "node:path";

import { isProbablyText } from "./fs.mjs";
import { formatCommandFailure, runCommand, runCommandChecked } from "./process.mjs";

const MAX_UNTRACKED_BYTES = 24 * 1024;
const MAX_UNTRACKED_CONTEXT_BYTES = 96 * 1024;
const MAX_UNTRACKED_CONTEXT_FILES = 20;
const DEFAULT_INLINE_DIFF_MAX_FILES = 2;
const DEFAULT_INLINE_DIFF_MAX_BYTES = 256 * 1024;

/**
 * @typedef {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   input?: string,
 *   maxBuffer?: number,
 *   stdio?: import("node:child_process").StdioOptions,
 *   shell?: boolean | string
 * }} GitCommandOptions
 *
 * @typedef {{
 *   command: string,
 *   args: string[],
 *   status: number | null,
 *   signal: NodeJS.Signals | null,
 *   stdout: string,
 *   stderr: string,
 *   error: Error | null
 * }} GitCommandResult
 *
 * @typedef {{
 *   staged: string[],
 *   unstaged: string[],
 *   untracked: string[],
 *   isDirty: boolean
 * }} WorkingTreeState
 *
 * @typedef {{
 *   mode: "working-tree",
 *   label: string,
 *   explicit: boolean
 * } | {
 *   mode: "branch",
 *   label: string,
 *   baseRef: string,
 *   explicit: boolean
 * }} ResolvedReviewTarget
 *
 * @typedef {{
 *   mergeBase: string,
 *   commitRange: string,
 *   reviewRange: string
 * }} BranchComparison
 *
 * @typedef {{
 *   includeDiff?: boolean,
 *   comparison?: BranchComparison,
 *   maxInlineFiles?: number,
 *   maxInlineDiffBytes?: number
 * }} ReviewCollectionOptions
 */

// Git is directly executable on Windows. Repository-derived arguments must never pass through a shell.
/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {GitCommandOptions} [options]
 * @returns {GitCommandResult}
 */
function git(cwd, args, options = {}) {
  return runCommand("git", args, { cwd, ...options, shell: false });
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @param {GitCommandOptions} [options]
 * @returns {GitCommandResult}
 */
function gitChecked(cwd, args, options = {}) {
  return runCommandChecked("git", args, { cwd, ...options, shell: false });
}

/** @param {...string[]} groups */
function listUniqueFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))].sort();
}

/** @param {unknown} value */
function normalizeMaxInlineFiles(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_FILES;
  }
  return Math.floor(parsed);
}

/** @param {unknown} value */
function normalizeMaxInlineDiffBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_INLINE_DIFF_MAX_BYTES;
  }
  return Math.floor(parsed);
}

/**
 * @param {unknown} error
 * @returns {error is Error & { code: string }}
 */
function isErrnoException(error) {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
  );
}

/** @param {string} cwd @param {string[]} args @param {number} maxBytes */
function measureGitOutputBytes(cwd, args, maxBytes) {
  const result = git(cwd, args, { maxBuffer: maxBytes + 1 });
  if (isErrnoException(result.error) && result.error.code === "ENOBUFS") {
    return maxBytes + 1;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return Buffer.byteLength(result.stdout, "utf8");
}

/** @param {string} cwd @param {string[][]} argSets @param {number} maxBytes */
function measureCombinedGitOutputBytes(cwd, argSets, maxBytes) {
  let totalBytes = 0;
  for (const args of argSets) {
    const remainingBytes = maxBytes - totalBytes;
    if (remainingBytes < 0) {
      return maxBytes + 1;
    }
    totalBytes += measureGitOutputBytes(cwd, args, remainingBytes);
    if (totalBytes > maxBytes) {
      return totalBytes;
    }
  }
  return totalBytes;
}

/** @param {string} cwd @param {string} baseRef @returns {BranchComparison} */
function buildBranchComparison(cwd, baseRef) {
  const mergeBase = gitChecked(cwd, ["merge-base", "HEAD", baseRef]).stdout.trim();
  return {
    mergeBase,
    commitRange: `${mergeBase}..HEAD`,
    reviewRange: `${baseRef}...HEAD`
  };
}

/** @param {string} cwd */
export function ensureGitRepository(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  const errorCode = result.error && "code" in result.error ? result.error.code : null;
  if (errorCode === "ENOENT") {
    throw new Error("git is not installed. Install Git and retry.");
  }
  if (result.status !== 0) {
    throw new Error("This command must run inside a Git repository.");
  }
  return result.stdout.trim();
}

/** @param {string} cwd */
export function getRepoRoot(cwd) {
  return gitChecked(cwd, ["rev-parse", "--show-toplevel"]).stdout.trim();
}

/** @param {string} cwd */
export function detectDefaultBranch(cwd) {
  const symbolic = git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"]);
  if (symbolic.status === 0) {
    const remoteHead = symbolic.stdout.trim();
    if (remoteHead.startsWith("refs/remotes/origin/")) {
      return remoteHead.replace("refs/remotes/origin/", "");
    }
  }

  const candidates = ["main", "master", "trunk"];
  for (const candidate of candidates) {
    const local = git(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`]);
    if (local.status === 0) {
      return candidate;
    }
    const remote = git(cwd, ["show-ref", "--verify", "--quiet", `refs/remotes/origin/${candidate}`]);
    if (remote.status === 0) {
      return `origin/${candidate}`;
    }
  }

  throw new Error("Unable to detect the repository default branch. Pass --base <ref> or use --scope working-tree.");
}

/** @param {string} cwd */
export function getCurrentBranch(cwd) {
  return gitChecked(cwd, ["branch", "--show-current"]).stdout.trim() || "HEAD";
}

/** @param {string} cwd @returns {WorkingTreeState} */
export function getWorkingTreeState(cwd) {
  const staged = gitChecked(cwd, ["diff", "--cached", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const unstaged = gitChecked(cwd, ["diff", "--name-only"]).stdout.trim().split("\n").filter(Boolean);
  const untracked = gitChecked(cwd, ["ls-files", "--others", "--exclude-standard"]).stdout.trim().split("\n").filter(Boolean);

  return {
    staged,
    unstaged,
    untracked,
    isDirty: staged.length > 0 || unstaged.length > 0 || untracked.length > 0
  };
}

/**
 * @param {string} cwd
 * @param {{ scope?: "auto" | "working-tree" | "branch", base?: string }} [options]
 * @returns {ResolvedReviewTarget}
 */
export function resolveReviewTarget(cwd, options = {}) {
  ensureGitRepository(cwd);

  const requestedScope = options.scope ?? "auto";
  const baseRef = options.base ?? null;
  const state = getWorkingTreeState(cwd);
  const supportedScopes = new Set(["auto", "working-tree", "branch"]);

  if (baseRef) {
    return {
      mode: "branch",
      label: `branch diff against ${baseRef}`,
      baseRef,
      explicit: true
    };
  }

  if (requestedScope === "working-tree") {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: true
    };
  }

  if (!supportedScopes.has(requestedScope)) {
    throw new Error(
      `Unsupported review scope "${requestedScope}". Use one of: auto, working-tree, branch, or pass --base <ref>.`
    );
  }

  if (requestedScope === "branch") {
    const detectedBase = detectDefaultBranch(cwd);
    return {
      mode: "branch",
      label: `branch diff against ${detectedBase}`,
      baseRef: detectedBase,
      explicit: true
    };
  }

  if (state.isDirty) {
    return {
      mode: "working-tree",
      label: "working tree diff",
      explicit: false
    };
  }

  const detectedBase = detectDefaultBranch(cwd);
  return {
    mode: "branch",
    label: `branch diff against ${detectedBase}`,
    baseRef: detectedBase,
    explicit: false
  };
}

/** @param {string} title @param {string} body */
function formatSection(title, body) {
  return [`## ${title}`, "", body.trim() ? body.trim() : "(none)", ""].join("\n");
}

/** @param {string} content */
function buildUntrackedFileContext(content) {
  return {
    content,
    bytes: Buffer.byteLength(content, "utf8")
  };
}

/** @param {string} cwd @param {string} relativePath @returns {{ content: string, bytes: number }} */
function formatUntrackedFile(cwd, relativePath) {
  const absolutePath = path.join(cwd, relativePath);
  let entry;
  try {
    entry = fs.lstatSync(absolutePath);
  } catch {
    return buildUntrackedFileContext(
      `### ${relativePath}\n(skipped: unreadable file)`
    );
  }
  if (entry.isSymbolicLink()) {
    return buildUntrackedFileContext(
      `### ${relativePath}\n(skipped: symbolic link)`
    );
  }
  if (entry.isDirectory()) {
    return buildUntrackedFileContext(
      `### ${relativePath}\n(skipped: directory)`
    );
  }
  if (!entry.isFile()) {
    return buildUntrackedFileContext(
      `### ${relativePath}\n(skipped: not a regular file)`
    );
  }

  let descriptor;
  try {
    descriptor = fs.openSync(
      absolutePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    const opened = fs.fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== entry.dev ||
      opened.ino !== entry.ino
    ) {
      return buildUntrackedFileContext(
        `### ${relativePath}\n(skipped: file changed during inspection)`
      );
    }
    if (opened.size > MAX_UNTRACKED_BYTES) {
      return buildUntrackedFileContext(
        `### ${relativePath}\n(skipped: ${opened.size} bytes exceeds ${MAX_UNTRACKED_BYTES} byte limit)`
      );
    }
    const buffer = fs.readFileSync(descriptor);
    if (!isProbablyText(buffer)) {
      return buildUntrackedFileContext(
        `### ${relativePath}\n(skipped: binary file)`
      );
    }
    return buildUntrackedFileContext(
      [
        `### ${relativePath}`,
        "```",
        buffer.toString("utf8").trimEnd(),
        "```"
      ].join("\n")
    );
  } catch {
    return buildUntrackedFileContext(
      `### ${relativePath}\n(skipped: unreadable file)`
    );
  } finally {
    if (descriptor !== undefined) {
      fs.closeSync(descriptor);
    }
  }
}

/** @param {string} cwd @param {string[]} files */
function collectUntrackedFiles(cwd, files) {
  const selected = [];
  let selectedBytes = 0;
  let omitted = 0;
  for (const file of [...new Set(files)].sort()) {
    if (selected.length >= MAX_UNTRACKED_CONTEXT_FILES) {
      omitted += 1;
      continue;
    }
    const formatted = formatUntrackedFile(cwd, file);
    const separatorBytes = selected.length > 0 ? 2 : 0;
    if (
      selectedBytes + separatorBytes + formatted.bytes >
      MAX_UNTRACKED_CONTEXT_BYTES
    ) {
      omitted += 1;
      continue;
    }
    selected.push(formatted);
    selectedBytes += separatorBytes + formatted.bytes;
  }
  if (omitted > 0) {
    let omissionContext = buildUntrackedFileContext(
      `(omitted: ${omitted} additional untracked file(s) due to cumulative limits of ${MAX_UNTRACKED_CONTEXT_FILES} files and ${MAX_UNTRACKED_CONTEXT_BYTES} bytes)`
    );
    while (
      selectedBytes +
        (selected.length > 0 ? 2 : 0) +
        omissionContext.bytes >
      MAX_UNTRACKED_CONTEXT_BYTES
    ) {
      const removed = selected.pop();
      if (removed === undefined) {
        break;
      }
      selectedBytes -= removed.bytes + (selected.length > 0 ? 2 : 0);
      omitted += 1;
      omissionContext = buildUntrackedFileContext(
        `(omitted: ${omitted} additional untracked file(s) due to cumulative limits of ${MAX_UNTRACKED_CONTEXT_FILES} files and ${MAX_UNTRACKED_CONTEXT_BYTES} bytes)`
      );
    }
    selected.push(omissionContext);
  }
  return selected.map((entry) => entry.content).join("\n\n");
}

/**
 * @param {string} cwd
 * @param {WorkingTreeState} state
 * @param {{ includeDiff?: boolean }} [options]
 */
function collectWorkingTreeContext(cwd, state, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const status = gitChecked(cwd, ["status", "--short", "--untracked-files=all"]).stdout.trim();
  const changedFiles = listUniqueFiles(state.staged, state.unstaged, state.untracked);

  let parts;
  if (includeDiff) {
    const stagedDiff = gitChecked(cwd, ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const unstagedDiff = gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]).stdout;
    const untrackedBody = collectUntrackedFiles(cwd, state.untracked);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff", stagedDiff),
      formatSection("Unstaged Diff", unstagedDiff),
      formatSection("Untracked Files", untrackedBody)
    ];
  } else {
    const stagedStat = gitChecked(cwd, ["diff", "--shortstat", "--cached"]).stdout.trim();
    const unstagedStat = gitChecked(cwd, ["diff", "--shortstat"]).stdout.trim();
    const untrackedBody = collectUntrackedFiles(cwd, state.untracked);
    parts = [
      formatSection("Git Status", status),
      formatSection("Staged Diff Stat", stagedStat),
      formatSection("Unstaged Diff Stat", unstagedStat),
      formatSection("Changed Files", changedFiles.join("\n")),
      formatSection("Untracked Files", untrackedBody)
    ];
  }

  return {
    mode: "working-tree",
    summary: `Reviewing ${state.staged.length} staged, ${state.unstaged.length} unstaged, and ${state.untracked.length} untracked file(s).`,
    content: parts.join("\n"),
    changedFiles
  };
}

/**
 * @param {string} cwd
 * @param {string} baseRef
 * @param {{ includeDiff?: boolean, comparison?: BranchComparison }} [options]
 */
function collectBranchContext(cwd, baseRef, options = {}) {
  const includeDiff = options.includeDiff !== false;
  const comparison = options.comparison ?? buildBranchComparison(cwd, baseRef);
  const currentBranch = getCurrentBranch(cwd);
  const changedFiles = gitChecked(cwd, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean);
  const logOutput = gitChecked(cwd, ["log", "--oneline", "--decorate", comparison.commitRange]).stdout.trim();
  const diffStat = gitChecked(cwd, ["diff", "--stat", comparison.commitRange]).stdout.trim();

  return {
    mode: "branch",
    summary: `Reviewing branch ${currentBranch} against ${baseRef} from merge-base ${comparison.mergeBase}.`,
    content: includeDiff
      ? [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection(
            "Branch Diff",
            gitChecked(cwd, ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange]).stdout
          )
        ].join("\n")
      : [
          formatSection("Commit Log", logOutput),
          formatSection("Diff Stat", diffStat),
          formatSection("Changed Files", changedFiles.join("\n"))
        ].join("\n"),
    changedFiles,
    comparison
  };
}

/** @param {{ includeDiff?: boolean }} [options] */
function buildAdversarialCollectionGuidance(options = {}) {
  if (options.includeDiff !== false) {
    return "Use the repository context below as primary evidence.";
  }

  return "The repository context below is a lightweight summary. Inspect the target diff yourself with read-only git commands before finalizing findings.";
}

/**
 * @param {string} cwd
 * @param {ResolvedReviewTarget} target
 * @param {ReviewCollectionOptions} [options]
 */
export function collectReviewContext(cwd, target, options = {}) {
  const repoRoot = getRepoRoot(cwd);
  const currentBranch = getCurrentBranch(repoRoot);
  const maxInlineFiles = normalizeMaxInlineFiles(options.maxInlineFiles);
  const maxInlineDiffBytes = normalizeMaxInlineDiffBytes(options.maxInlineDiffBytes);
  let details;
  let includeDiff;
  let diffBytes;

  if (target.mode === "working-tree") {
    const state = getWorkingTreeState(repoRoot);
    diffBytes = measureCombinedGitOutputBytes(
      repoRoot,
      [
        ["diff", "--cached", "--binary", "--no-ext-diff", "--submodule=diff"],
        ["diff", "--binary", "--no-ext-diff", "--submodule=diff"]
      ],
      maxInlineDiffBytes
    );
    includeDiff =
      options.includeDiff ??
      (listUniqueFiles(state.staged, state.unstaged, state.untracked).length <= maxInlineFiles &&
        diffBytes <= maxInlineDiffBytes);
    details = collectWorkingTreeContext(repoRoot, state, { includeDiff });
  } else {
    const comparison = buildBranchComparison(repoRoot, target.baseRef);
    const fileCount = gitChecked(repoRoot, ["diff", "--name-only", comparison.commitRange]).stdout.trim().split("\n").filter(Boolean).length;
    diffBytes = measureGitOutputBytes(
      repoRoot,
      ["diff", "--binary", "--no-ext-diff", "--submodule=diff", comparison.commitRange],
      maxInlineDiffBytes
    );
    includeDiff = options.includeDiff ?? (fileCount <= maxInlineFiles && diffBytes <= maxInlineDiffBytes);
    details = collectBranchContext(repoRoot, target.baseRef, { includeDiff, comparison });
  }

  return {
    cwd: repoRoot,
    repoRoot,
    branch: currentBranch,
    target,
    fileCount: details.changedFiles.length,
    diffBytes,
    inputMode: includeDiff ? "inline-diff" : "self-collect",
    collectionGuidance: buildAdversarialCollectionGuidance({ includeDiff }),
    ...details
  };
}
