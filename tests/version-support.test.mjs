import assert from "node:assert/strict";
import test from "node:test";

import { requireMinimumVersion } from "../plugins/codex/scripts/lib/version-support.mjs";

test("minimum version accepts equal and newer semantic versions", () => {
  assert.equal(requireMinimumVersion("Codex", "codex-cli 0.145.0", "0.145.0").available, true);
  assert.equal(requireMinimumVersion("Codex", "codex-cli 1.0.0", "0.145.0").available, true);
});

test("minimum version rejects old or unparseable versions", () => {
  assert.match(
    requireMinimumVersion("Claude Code", "2.1.217 (Claude Code)", "2.1.218").detail,
    /unsupported/
  );
  assert.equal(requireMinimumVersion("Codex", "codex-cli test", "0.145.0").available, false);
});
