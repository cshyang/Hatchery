# Workspace Sandbox Thin Slice

**Date**: 2026-06-10
**Status**: verified in prod (2026-06-10). Deployed (migration 0018, container image, worker 6b33e4c7), Slack app reinstalled with file scopes, and end-to-end PDF test passed: load_slack_file → exec failed (exit 1) → agent pip-installed pymupdf → parsed the PDF, all within one coordinator turn with full audit rows in coordinator_workspace_ops.
**Primary goal**: Let the coordinator process real files from Slack (xlsx/csv/etc.) in a real container — shell, filesystem, python — and post results back to the thread, with the coordinator holding the loop the whole time.

## Context

The original "Coordinator Workspace Tasks" plan dispatched one-shot Pi-agent jobs to Trigger.dev with R2 artifacts, saved scripts, and scheduling. Review killed most of that for v1:

- **Dispatch-and-callback is a double-LLM telephone game.** The coordinator (which holds the Slack conversation and the user's intent) would compress everything into an instructions string for a second agent to re-interpret cold, and learn about misreads only at callback time. Sandbox-as-a-tool keeps one brain: write a script, run it, read stderr, fix, retry — inside the same turn, visible through the existing activity receipts.
- **The real execution axis is who holds the loop, not what resources the task needs.** Interactive seconds-to-minutes work belongs in the coordinator's own turn. Detached, hours-long autonomous work (coding runs → PRs) stays on Trigger.dev, unchanged.
- **Feasibility is proven.** A spike on 2026-06-10 ran exec/git/file-roundtrip from this Worker against a Cloudflare Sandbox container under `flue dev` in 6.3s including cold start. Flue 0.9.1 auto-wires any DO binding whose `class_name` ends with "Sandbox" to `@cloudflare/sandbox` — config only, no entry ejection.

```
                 who holds the loop?
                        │
    coordinator-in-the-loop          detached job
            │                               │
    Sandbox SDK as tools             Trigger + Pi agent   (unchanged)
    exec/write/read in-turn          agent_runs + callback
    xlsx, csv, ad-hoc scripts        coding runs → PRs
            │
    (execute_code keeps the ms-scale pure-function lane)
```

## Version pins (do not upgrade past these in this slice)

- **Flue 0.9.1.** Sandbox auto-wiring is the only integration path on the published 0.9.1; Flue 0.10 removes it in favor of explicit source-root `cloudflare.ts` exports AND removes named sessions (which MoreHands's thread→session mapping depends on). The 0.10 upgrade is a separate migration project; see `flue-cloudflare-agents` skill, "0.10 upgrade watermark".
- **`@cloudflare/sandbox` 0.12.1**, image `docker.io/cloudflare/sandbox:0.12.1-python` (default variant has no Python; `-python` ships pandas/numpy/matplotlib).
- wrangler 4.99 + `@cloudflare/vite-plugin` 1.40.1 at root (already bumped; fixes `flue dev` workerd/compatibility-date skew).

## Key Changes

### 1. Sandbox container binding (already in working tree from the spike)

- `wrangler.jsonc`: `containers` block (`class_name: "Sandbox"`, `instance_type: "lite"`), DO binding `{ name: "SANDBOX", class_name: "Sandbox" }`, migration `new_sqlite_classes: ["Sandbox"]`.
- `Dockerfile.sandbox`: switch base to `0.12.1-python`.
- One sandbox per project: `getSandbox(env.SANDBOX, projectId)`. Container cold-starts lazily (~6s), sleeps after ~10 idle minutes. **Filesystem is ephemeral across sleeps** — the prompt must say so; nothing durable lives in the container.

### 2. Coordinator workspace tools (the whole feature)

New tool group `workspace`, gated on `DB` + `SANDBOX` binding, mirroring code-mode's audit discipline:

- `workspace_exec(command, timeoutMs?)` — bounded shell exec; returns stdout/stderr/exitCode previews.
- `workspace_write_file(path, content)` / `workspace_read_file(path, maxBytes?)` — bounded file IO between model context and container.
- `workspace_load_slack_file(fileId)` — Worker downloads the Slack file with the bot token and `writeFile`s it into `/workspace/inputs/`. The token never enters the container; the container only boots when the model actually needs the file.
- `workspace_send_file(path, title?)` — uploads a container file to the current Slack thread via the external-upload flow (`files.getUploadURLExternal` + `files.completeUploadExternal`). This is result delivery — no R2, no signed URLs, no artifact-serving endpoint.

### 3. Slack file intake (metadata only)

- Manifest scopes: add `files:read` and `files:write`.
- Extend Slack event parsing to retain `files[]` metadata (id, name, mimetype, size) on **engaged** messages only; ambient messages ignore files.
- Dispatch input lists attached files as metadata. Nothing is downloaded at intake — no size/type rejection ceremony needed; `workspace_load_slack_file` enforces caps at download time and the model explains failures conversationally.

### 4. Audit trail

- Migration `0018_coordinator_workspace_ops.sql`: project-scoped rows for every workspace tool call (op kind, command/path preview, exit code, bytes, duration, status, error), same shape conventions as `coordinator_code_executions`. Indexed `(project_id, created_at DESC)`.

### 5. Prompt + self-knowledge

- `self_status` reports `workspace` capability separately from `codeMode`.
- Prompt boundary: `execute_code` for small pure JS/Python functions (ms-scale, no fs); workspace tools for files, spreadsheets, shell, multi-step data work; workspace fs is ephemeral — treat every turn as possibly starting clean; check inputs exist before assuming prior state.

## Limits

- Exec: default 60s timeout, hard cap 300s; stdout/stderr previews bounded (~20KB, matching code-mode).
- `workspace_read_file` into context: cap ~1MB with truncation notice.
- Slack download / upload: cap ~20MB per file.
- All caps env-overridable like `CODE_EXEC_*`.

## Safety

- **No secrets enter the container.** Bot token, D1, KV, Nango, Trigger keys all stay in the Worker. The container env is empty.
- Container egress is open (curl works). Named risk: a prompt-injected instruction inside an uploaded file could ask the model to exfiltrate file contents. Accepted for v1 because tools run only on engaged turns, every op leaves an audit row, and activity receipts make tool use visible in-thread. Revisit egress controls if intake widens beyond trusted channels.
- Workspace tool failures never break the Slack turn — they return bounded error text to the model, like every other tool.

## Explicitly out of scope (and what would pull each back in)

- **Saved scripts** → revisit as skills + `set_reminder` (existing substrate) when someone actually asks for a recurring file job. No new tables.
- **Scheduling** → same trigger; a reminder-fired skill can call workspace tools already once this lands.
- **R2 artifacts** → only when an output must outlive the turn/thread (Slack uploads cover v1).
- **Repo cloning in the sandbox** → needs the token-into-container story solved; coding work already has the Trigger lane.
- **Trigger/agent_runs changes** → none. If a workspace job ever exceeds turn budget (~minutes), that's the signal to escalate that job type to a Trigger task — duration is the boundary, not filesystem need.
- **Flue 0.10 upgrade** → separate migration project (DO renames, named-session removal, Durable Streams).

## Test Plan

Repo style: tsx + `createTestRunner`, wired into `npm test`.

- Slack intake: `files[]` metadata parsed on engaged messages; ignored on ambient; metadata flows into dispatch input.
- Workspace tools: gated off without `SANDBOX`/`DB`; exec/read/write enforce caps and write audit rows (mock sandbox + D1); `workspace_load_slack_file` rejects oversized files and never leaks the token into command strings; `workspace_send_file` drives the two-step external upload (mocked).
- Audit: every op records status/preview/duration; failures record bounded error.
- E2E (manual): `flue dev` + forged Slack webhook with a file attachment → model loads file, runs pandas, sends CSV back. Then verify on prod (local model calls are not the test surface — flue skill).
- Gates: `npm run typecheck`, `npm test`, `npm run build`, `git diff --check` (predeploy already chains the first three).

## Deploy notes

- Containers require Workers Paid; first `wrangler deploy` builds and pushes the image (slow once).
- Ticker, Trigger runner, and all existing migrations untouched.
- Ship order: (1) binding + tools + audit, (2) Slack intake + scopes, (3) send-file + prompt/self_status. Each independently shippable; (1) is testable via a token-guarded internal route before Slack wiring exists.
