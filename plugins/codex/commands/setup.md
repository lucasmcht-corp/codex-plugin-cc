---
description: Check whether the local Codex CLI is ready and optionally toggle the stop-time review gate
argument-hint: '[--enable-review-gate|--disable-review-gate]'
allowed-tools: Bash(node:*), Bash(npm:*), AskUserQuestion
---

The UserPromptExpansion command hook injects the exact raw arguments as one
canonical base64 value. Never compute, rewrite, or guess it. Never put raw
arguments in a shell command.

For non-empty arguments, replace the placeholder with the injected value and
run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json --arguments-base64 CANONICAL_BASE64_OF_EXACT_RAW_ARGUMENTS
```

For empty arguments, run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-companion.mjs" setup --json
```

If the result says Codex is unavailable and npm is available:
- Use `AskUserQuestion` exactly once to ask whether Claude should install Codex now.
- Put the install option first and suffix it with `(Recommended)`.
- Use these two options:
  - `Install Codex (Recommended)`
  - `Skip for now`
- If the user chooses install, run:

```bash
npm install -g @openai/codex
```

- Then rerun the applicable safe command above, with the same injected base64
  value when arguments were non-empty.

If Codex is already installed or npm is unavailable:
- Do not ask about installation.

Output rules:
- Present the final setup output to the user.
- If installation was skipped, present the original setup output.
- If Codex is installed but not authenticated, preserve the guidance to run `!codex login`.
