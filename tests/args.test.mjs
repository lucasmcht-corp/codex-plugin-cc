import test from "node:test";
import assert from "node:assert/strict";

import {
  splitRawArgumentString,
  tokenizeRawArgumentString
} from "../plugins/codex/scripts/lib/args.mjs";

test("raw arguments retain Windows paths, escaped delimiters, and empty values", () => {
  const raw =
    String.raw`--cwd "C:\tmp\review files" plain\ value "" 'quoted value' C:\other\file`;

  assert.deepEqual(splitRawArgumentString(raw), [
    "--cwd",
    String.raw`C:\tmp\review files`,
    "plain value",
    "",
    "quoted value",
    String.raw`C:\other\file`
  ]);
});

test("raw argument token spans preserve exact source text", () => {
  const raw = String.raw`--base main focus  C:\tmp\file "quoted" '' tail  `;
  const tokens = tokenizeRawArgumentString(raw);
  const focusStart = tokens[2].start;

  assert.equal(
    raw.slice(focusStart),
    String.raw`focus  C:\tmp\file "quoted" '' tail  `
  );
});

test("raw arguments retain quoted and unquoted UNC paths exactly", () => {
  const raw = String.raw`--cwd \\server\share "\\server\review files" C:\\tmp`;

  assert.deepEqual(splitRawArgumentString(raw), [
    "--cwd",
    String.raw`\\server\share`,
    String.raw`\\server\review files`,
    String.raw`C:\\tmp`
  ]);
});

test("raw arguments reject unterminated quotes", () => {
  assert.throws(
    () => splitRawArgumentString(String.raw`--cwd "C:\tmp`),
    /unterminated quote/i
  );
});
