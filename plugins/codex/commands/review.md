---
description: Run a Codex code review against local git state
argument-hint: '[--wait|--background] [--base <ref>] [--scope auto|working-tree|branch]'
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run a Codex review through an invocation-owned Codex runtime.

Raw slash-command arguments:
`$ARGUMENTS`

Core constraint:
- This command is review-only.
- Do not fix issues, apply patches, or suggest that you are about to make changes.
- Your only job is to run the review and return Codex's output verbatim to the user.

Execution mode rules:
- If the raw arguments include `--wait`, do not ask. Run the review in the foreground.
- If the raw arguments include `--background`, do not ask. Run the review in a Claude background task.
- Otherwise, estimate the review size before asking:
  - For working-tree review, start with `git status --short --untracked-files=all`.
  - For working-tree review, also inspect both `git diff --shortstat --cached` and `git diff --shortstat`.
  - For base-branch review, use `git diff --shortstat <base>...HEAD`.
  - Treat untracked files or directories as reviewable work even when `git diff --shortstat` is empty.
  - Only conclude there is nothing to review when the relevant working-tree status is empty or the explicit branch diff is empty.
  - Recommend waiting only when the review is clearly tiny, roughly 1-2 files total and no sign of a broader directory-sized change.
  - In every other case, including unclear size, recommend background.
  - When in doubt, run the review instead of declaring that there is nothing to review.
- Then use `AskUserQuestion` exactly once with two options, putting the recommended option first and suffixing its label with `(Recommended)`:
  - `Wait for results`
  - `Run in background`

Argument handling:
- Preserve the user's arguments exactly.
- The UserPromptExpansion review hook receives the original raw UTF-8 arguments.
- When `--wait` or `--background` is explicit, the hook invokes the companion
  directly in exec form and blocks this prompt expansion with the result.
- Without an explicit mode, the hook injects one line shaped exactly like
  `Deterministic review transport: {"argumentsBase64":"..."}`.
- After the user chooses a mode, copy only the injected `argumentsBase64` value
  through `--arguments-base64`. Omit the option when that value is empty.
- Never compute, rewrite, or guess the base64 value yourself.
- Never put the raw arguments in a Bash command.
- Never write an argument file.
- Do not strip `--wait` or `--background` yourself.
- Do not add extra review instructions or rewrite the user's intent.
- The companion script uses `--background` to create the owned detached worker. Claude Code may run the short launch command in a background Bash task.
- `/codex:review` is native-review only. It does not support staged-only review, unstaged-only review, or extra focus text.
- If the user needs custom review instructions or more adversarial framing, they should use `/codex:adversarial-review`.

Foreground flow:
- This flow is reached only after the interactive choice. For a non-empty
  injected `argumentsBase64` value, replace the unmistakable placeholder with
  that exact value, then run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --arguments-base64 CANONICAL_BASE64_OF_EXACT_RAW_ARGUMENTS
```
- For empty raw arguments, run:
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review
```
- Return the command stdout verbatim, exactly as-is.
- Do not paraphrase, summarize, or add commentary before or after it.
- Do not fix any issues mentioned in the review output.

Background flow:
- This flow is reached only after the interactive choice. For a non-empty
  injected `argumentsBase64` value, replace the unmistakable placeholder with
  that exact value, then launch the review with `Bash` in the background:
```typescript
Bash({
  command: `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" review --background --arguments-base64 CANONICAL_BASE64_OF_EXACT_RAW_ARGUMENTS`,
  description: "Codex review",
  run_in_background: true
})
```
- For empty raw arguments, omit `--arguments-base64` from the command.
- Do not call `BashOutput` or wait for completion in this turn.
- After launching the command, tell the user: "Codex review started in the background. Check `/codex:status` for progress."
