export const MINIMUM_CLAUDE_CODE_VERSION = "2.1.218";
export const MINIMUM_CODEX_VERSION = "0.145.0";

/** @typedef {[number, number, number]} SemanticVersion */

/**
 * @param {unknown} value
 * @returns {SemanticVersion | null}
 */
function parseVersion(value) {
  const match = String(value ?? "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** @param {SemanticVersion} left @param {SemanticVersion} right */
function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index];
    }
  }
  return 0;
}

/**
 * @param {string} label
 * @param {unknown} versionOutput
 * @param {string} minimumVersion
 */
export function requireMinimumVersion(label, versionOutput, minimumVersion) {
  const actual = parseVersion(versionOutput);
  const minimum = parseVersion(minimumVersion);
  if (!actual || !minimum) {
    return {
      available: false,
      detail: `${label} version could not be parsed from: ${String(versionOutput).trim() || "empty output"}`
    };
  }
  if (compareVersions(actual, minimum) < 0) {
    return {
      available: false,
      detail: `${label} ${actual.join(".")} is unsupported; ${minimumVersion} or later is required`
    };
  }
  return {
    available: true,
    detail: `${label} ${actual.join(".")} (minimum ${minimumVersion})`
  };
}
