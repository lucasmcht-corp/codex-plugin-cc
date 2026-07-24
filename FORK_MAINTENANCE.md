# Fork maintenance

## Why this fork exists

The upstream v1.0.6 runtime uses a workspace-shared broker. Concurrent Claude
sessions can therefore stop or steer infrastructure owned by another session.
This fork removes that shared lifecycle. Every foreground or background run uses
the same detached, generation-owned worker, and each worker owns its app-server
process.

The fork also adds exact native steering for active tasks:

- one private endpoint per worker generation;
- one explicit `/codex:send <job-id> <instruction>` command;
- one exact Codex `threadId` and active `turnId`;
- native `turn/steer`, with no resume, retry, latest-job fallback, or new process;
- authoritative terminal confirmation through native `thread/read` when the
  completion notification is absent;
- fail-closed ownership checks for start, steering, cancellation, and cleanup.

The canonical local checkout is `/home/lucas/projects/codex-plugin-cc`. The
installed official checkout is not a development target and must remain clean.
Machine-readable marketplace, plugin, and package metadata identify this as the
`lucasmcht` reliability fork while preserving OpenAI attribution in this
document and the repository history.

## Invariants to preserve

1. A process may stop only the worker generation whose PID, process start key,
   token, and process group all match.
2. Background launch has one atomic `queued -> running` claim.
3. `state.json` is the only current-runtime job manifest. `jobs/` contains logs
   and may temporarily retain active manifests from an older installed runtime.
4. Job history is never deleted by an implicit cap. Retention must be an
   explicit, separately reviewed operation.
5. SessionEnd affects only jobs carrying that exact Claude session ID.
6. SIGTERM keeps the worker as a process-group anchor for a bounded interval,
   then guarantees escalation.
7. A steering request is sent at most once. A transport failure after write is
   reported as unknown delivery and is never retried.
8. Worker stop, state finalization, and steering endpoint cleanup remain
   independently observable.
9. Status and session boundaries reconcile a dead owned worker to a terminal
   failure before exposing the job.
10. Linux app-server shutdown owns a dedicated process group and stops it even
    after the root exits. Windows assigns the app-server to a native Job Object
    before resuming it, with kill-on-close ownership.
11. A queued launch carries the exact launcher PID and process start key until
    the worker claims it. A dead or reused launcher cannot leave a queued job.
12. SessionStart clears a tombstone only after that session has no remaining
    jobs. Partial recovery keeps the tombstone, tombstones never expire
    implicitly, and a concurrent SessionEnd keeps the newer generation.
13. Canonical state is synchronized before replacement, and its directory is
    synchronized before any legacy manifest is removed.
14. Steering validates non-blank input but otherwise preserves the instruction
    text exactly, including whitespace, quotes, and backslashes.
15. Foreground is only a waiting mode. The launcher may exit without stopping or
    orphaning the detached owned worker.
16. `/codex:send` receives raw command arguments through UserPromptExpansion and
    an exec-form hook. User text never enters a shell command.
17. Removed legacy jobs remain listed in `retiredLegacyJobIds` without a cap, so
    a physically retained or crash-restored manifest cannot resurrect them.
18. SessionStart inspects at most four ended session generations and four jobs
    per invocation within a 3.5-second start budget. It clears completed
    generations in one transaction. The durable backlog itself is never capped.
19. The stop gate launches one owned background job, reuses it after hook
    interruption, and cancels it before the shorter internal deadline expires.
20. Review command arguments originate only from
    `UserPromptExpansion.command_args`. Explicit foreground or background modes
    use an exec-form hook. The interactive choice path receives hook-generated
    canonical base64, never Claude-generated base64, raw shell arguments, or a
    workspace file.
21. Persistent state is exported only through
    `CODEX_COMPANION_PLUGIN_DATA`. The plugin-scoped `CLAUDE_PLUGIN_DATA`
    variable is never copied into the global Claude session environment.

On Windows, opening a directory for synchronization may be unsupported. In that
case canonical state is kept, but legacy terminal manifests are deliberately
retained for a later cleanup attempt. Absence of directory durability proof
never permits destructive cleanup. Canonical retirement markers prevent those
retained files from becoming live jobs again.

Linux and Windows are the supported fork runtimes. Other POSIX platforms are
rejected before launch because their available process start timestamp is too
coarse to distinguish a same-second PID reuse safely.

## Upgrade gate from v1.0.6

Before activating this fork, finish or cancel every active background job with
the still-installed v1.0.6 runtime. Confirm that its status output contains no
queued or running background job, then end the Claude session so v1.0.6 removes
its shared broker.

The fork deliberately refuses SessionStart when it finds a live v1.0.6 job.
Those records contain a PID but no process start key or worker token, so killing
them after the upgrade could target a reused PID. A dead legacy worker is
reclassified as failed automatically. A live one must be drained by v1.0.6
before activation.

Terminal v1.0.6 manifests are migrated into canonical state before deletion.
The index wins conflicting metadata because it may be newer, while manifest-only
fields such as `request`, `result`, and `rendered` are retained. Active manifests
remain until the old job becomes terminal.

## Installation-free activation

Activation uses existing owners instead of repository-local launch glue:

```text
agent-layer wrapper + CODEX_COMPANION_ROOT -> checkout runtime
Claude Code --plugin-dir                  -> checkout plugin
```

After the v1.0.6 drain, select the fork checkout and prove the canonical
wrapper accepts its pinned revision:

```bash
export CODEX_COMPANION_ROOT="$(git rev-parse --show-toplevel)"
codex-companion status --all --json
CODEX_COMPANION_TEST_ROOT="$CODEX_COMPANION_ROOT" \
  "$HOME/.agents/bin/tests/test-codex-companion-ownership.sh"
```

The wrapper and its ownership regression belong to the agent-layer canon under
`$HOME/.agents/bin`, not to this repository. A new committed fork revision
therefore requires an intentional wrapper pin update through the
`agent-layer-ops` procedure before activation. Exit code 3 means the checkout
and the canonical pin disagree; it must not be bypassed.

Load the plugin for a single Claude Code session without marketplace
installation:

```bash
claude --plugin-dir "$CODEX_COMPANION_ROOT/plugins/codex"
```

Claude Code must resolve plugin-scoped `CLAUDE_PLUGIN_ROOT` to the absolute
`"$CODEX_COMPANION_ROOT/plugins/codex"` directory. Hooks and commands already
use that variable for their script paths. Do not export it globally and do not
translate it into `CODEX_COMPANION_ROOT`: the former is owned by Claude Code,
while the latter selects the checkout used by the canonical wrapper. Run
`/codex:setup` in the activated session as the path-resolution smoke test.

This procedure installs nothing, leaves the official checkout untouched, and
adds no persistent marketplace entry. Ending the session removes the
`--plugin-dir` activation.

## Synchronizing upstream

Do this only from a clean, intentionally committed fork state. Never rebase or
discard an uncommitted working tree.

```bash
git remote get-url upstream >/dev/null 2>&1 || \
  git remote add upstream https://github.com/openai/codex-plugin-cc.git
test "$(git remote get-url upstream)" = \
  "https://github.com/openai/codex-plugin-cc.git" || {
    echo "Stop: upstream does not point to the canonical OpenAI repository." >&2
    exit 1
  }
git fetch upstream
git switch main
git merge --ff-only upstream/main
git switch fix/broker-transport-fail-closed
git rebase main
```

If the URL check fails, inspect the unexpected remote and correct it explicitly
with `git remote set-url upstream https://github.com/openai/codex-plugin-cc.git`
before fetching. Resolve conflicts by preserving the invariants above, not by
mechanically choosing the fork side.
Do not push, install, or open a PR until the complete gate below passes and Lucas
has explicitly authorized that action.

After every upstream sync:

```bash
npm run build
npm test
npm run check-version
git diff --check
```

`npm run build` includes strict checks for both the generated protocol contracts
and the complete JavaScript runtime.

Also run a fresh independent Codex review of the complete diff, with explicit
attention to unnecessary complexity and non-idiomatic TypeScript or JavaScript.
The GitHub workflow runs the suite on Ubuntu and Windows. Local Linux success
does not prove PowerShell, Job Object, or named-pipe behavior; require the real
Windows job before publishing a release.

## Upstream watchlist

Recheck live state before every maintenance decision. These references were
open on 2026-07-23:

- [PR #541](https://github.com/openai/codex-plugin-cc/pull/541): broker leaks,
  state races, and signal handling.
- [PR #518](https://github.com/openai/codex-plugin-cc/pull/518): broker and worker
  ownership cleanup.
- [PR #497](https://github.com/openai/codex-plugin-cc/pull/497): worker liveness
  and cancellation.
- [PR #460](https://github.com/openai/codex-plugin-cc/pull/460): serialized state
  updates and atomic writes.
- [Issue #428](https://github.com/openai/codex-plugin-cc/issues/428): concurrent
  state loss and pruning of active work.
- [Issue #432](https://github.com/openai/codex-plugin-cc/issues/432): background
  worker death with a stale running job.
- [Issue #540](https://github.com/openai/codex-plugin-cc/issues/540): SessionEnd
  stopping another session through the shared broker.
- [Issue #543](https://github.com/openai/codex-plugin-cc/issues/543): orphaned
  broker processes and memory leaks.

Search upstream separately for native `turn/steer`, authoritative `thread/read`
fallback, explicit send support,
per-worker endpoints, and exact worker-generation ownership. A broker-only fix
does not replace this fork's steering contract.

## When to retire the fork

Retire the fork when one released upstream version proves all of the following:

- no workspace-shared broker owns concurrent task lifecycles;
- exact active-turn steering is exposed through a human and agent-consumable
  command;
- cancellation and SessionEnd validate the full worker generation;
- concurrent state writes cannot drop or prune active jobs;
- failed or ambiguous delivery never retries a steering instruction;
- three representative concurrent loop runs complete without collision,
  orphaned processes, stale running jobs, or exit 86 recovery.

The comparison must use the same deterministic test matrix and the same two-loop
concurrency scenario. When upstream passes, archive this branch and return the
installed plugin to the official release instead of carrying duplicate code.
