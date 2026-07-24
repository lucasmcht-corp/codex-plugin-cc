import { ensureGitRepository } from "./git.mjs";

/** @param {string} cwd */
export function resolveWorkspaceRoot(cwd) {
  try {
    return ensureGitRepository(cwd);
  } catch {
    return cwd;
  }
}
