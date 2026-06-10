---
name: audit
description: Use when audit mode assesses a known repo for production readiness, launch go/no-go, or client handoff risk.
---

# Audit

## Overview

The harness's audit track exists to answer one upstream question: **what work should exist before we spend build effort?**

This skill is **audit-only**. It does not remediate code, silently choose tools the repo has not chosen, or continue into implementation. It stops at:

- evidence-backed readiness findings
- a top-level launch verdict
- bounded issue candidates for downstream execution

## When to use

Use this skill when:

- The conductor has placed the run in `audit` mode.
- The repo is known, but production readiness or launch/handoff risk is not.
- You need to turn repo evidence plus repo standards into execution-ready issues or explicit decision requests.

Do not use when:

- The next step is planning or building an already-approved issue. Use `deliver` workers instead.
- The software itself is still unknown and needs product discovery before a readiness audit.
- You are already in implementation mode. Audit does not fix code.

## Inputs and precedence

Audit decisions follow this order:

1. **Policy** — `.harness/standards.yaml`
2. **Repo evidence** — `.env.example`, CI files, deploy config, infra files, tests, docs
3. **External exposure evidence** — safe black-box observations from the configured public URL, when `external_exposure.enabled: true`
4. **Cheap verification** — safe commands such as tests, build, typecheck when useful
5. **Inference**

If policy and repo evidence do not constrain the choice, return `decision-required`. Do not invent a platform standard.

## Core workflow

1. Read `.harness/standards.yaml` if present.
2. Inspect the real repo: build files, workflows, deploy path, env docs, tests, operational docs, infra config, auth/tenant boundaries, job/queue surfaces, and performance-sensitive paths.
3. If `external_exposure.enabled: true`, run the safe checks in `references/external-exposure.md`.
4. Run only cheap, non-destructive verification commands when useful.
5. Score findings using the exact vocabulary:
   - `PASS`
   - `FAIL`
   - `UNVERIFIED`
6. Rank actionable gaps:
   - `P0 before launch`
   - `P1 before client handoff if possible`
   - `P2 after controlled rollout`
7. Classify each actionable gap:
   - **execution-ready** — repo standards or existing repo shape already constrain the fix
   - **decision-required** — the capability gap is real, but the implementation path is not chosen
8. Synthesize bounded issue candidates.
9. **If `prior-issues.json` was injected:** annotate every candidate per §Prior-issue annotation. **Else:** skip — the markdown-first path doesn't write annotation fields.
10. Stop.

## Required coverage

Every assessment must include these checklist rows. Use only `PASS`, `FAIL`, or `UNVERIFIED`, and cite evidence for each row. If a surface appears not to apply, keep the row and cite the repo evidence that supports that conclusion.

- Build/release path
- CI/test gates
- Deploy/runtime config
- Required production config/env
- External production exposure (if configured)
- Auth and access control
- Security basics
- Tenant isolation and cross-tenant data access
- Role/RBAC boundaries and privilege escalation paths
- Data safety, migrations, backups, and rollback
- Background jobs, queues, scheduled tasks, and webhooks
- Observability, logging, and error reporting
- Performance/scalability baseline
- Operational docs and handoff

Security basics includes HTTPS/security headers where the app serves HTTP, dependency/security scan signals, input validation on external inputs, injection/XSS/CSRF-relevant controls where applicable, secret leakage checks, webhook signature validation where webhooks exist, abuse/rate-limit controls for exposed endpoints, and dangerous debug/admin surfaces.

External production exposure covers the configured public URL only. It includes TLS/redirects, security/cache headers, public API auth gates, CORS, docs/debug endpoint exposure, version leakage, indexing files, health endpoints, and explicitly enabled login/session smoke checks. It is optional; if no external URL is configured, mark the checklist row `UNVERIFIED` with "no external URL configured for this audit" and do not treat that alone as launch-blocking.

Tenant isolation includes tenant-scoped reads/writes, organization membership boundaries, cross-tenant query risk, invite/member flows, admin escalation paths, and service-role usage. A multi-tenant app with unverified tenant isolation is not launch-ready.

Background-job coverage includes worker deployment, retries, idempotency, rate limits, scheduled-task ownership, webhook replay behavior, and dead-letter or failure handling where those surfaces exist.

Performance coverage includes latency or capacity expectations when available, obvious hot paths, pagination, database indexes, N+1 risks, cache assumptions, large payload handling, and any cheap smoke/load check the repo already supports.

## Evidence discipline

- `PASS` requires direct evidence.
- `FAIL` requires a concrete gap, broken signal, or dangerous default.
- `UNVERIFIED` is mandatory when the item was not actually checked.
- Failed or un-runnable tests are a release-confidence problem, not a side note.
- A finding without evidence is a hypothesis, not an audit result.
- External findings must name the method, path, status code, auth state, and why the probe was safe. Redact sensitive response values.

## External exposure safety

The external exposure step is a bounded smoke test, not a penetration test.

- Default allowed methods are `GET`, `HEAD`, and `OPTIONS`.
- `POST` is allowed only for a configured login endpoint and explicit auth smoke checks.
- Never run `DELETE`, `PUT`, `PATCH`, file upload, password reset, email/SMS/webhook, fuzzing, injection, credential stuffing, or load-test probes during audit.
- If a safe read proves a vulnerability, stop. Do not mutate the system to prove it harder.
- Do not fetch or paste full sensitive records. Request the smallest response possible and redact.
- Unsafe probes that would be useful become findings or blockers, not actions.

## Issue-candidate contract

Each issue candidate must include nine canonical fields:

- `title`
- `priority`
- `classification` (`execution-ready` or `decision-required`)
- `problem`
- `evidence`
- `risk if not fixed`
- `acceptance criteria`
- `verification`
- `scope notes`

Two additional fields are required **only when `prior-issues.json` is present** (tracker configured):

- `prior-issue-status` (one of `new`, `duplicate-of-open: <identifier>`, `related-to: <identifier>`, `closed-match: <identifier>`)
- `prior-issue-reasoning` (required for every non-`new` status)

When the dispatch did not inject `prior-issues.json` (no tracker configured), omit both fields. The markdown-first audit path is the default and does not need them.

## Prior-issue annotation (tracker-only)

This section only applies when `prior-issues.json` was injected into your dispatch. If absent, skip — go straight to "Stop" in the workflow.

Each candidate's `prior-issue-status` plus `prior-issue-reasoning` lets the conductor drive duplicate-aware tracker writes. The annotation does **not** suppress the finding — every gap still appears in `assessment.md` with full evidence, severity, and verdict impact. It only controls downstream tracker behavior.

### Inputs

When injected, `prior-issues.json` contains:

- `open[]` — every open issue in the configured team/project (lightweight fields: `id`, `identifier`, `url`, `title`, `labels`, `state`, `body_summary`, `created_at`). NOT just audit-sourced issues — humans may have already filed the same gap, and you must catch those too.
- `closed[]` — closed issues labeled `source:audit` from the last 180 days.

### Annotation vocabulary

- `new` — no semantic match against any prior issue.
- `duplicate-of-open: <identifier>` — same gap as an open issue. Cite the human identifier (`LIN-142`), not the opaque id.
- `related-to: <identifier>` — connected but distinct (e.g., adding HSTS is related to a broader "security headers" issue). Single primary identifier in v1; mention any additional relations in reasoning prose.
- `closed-match: <identifier>` — same gap as a closed audit-sourced issue within the 180-day window, AND current repo evidence shows the gap is present. Use this when prior remediation did not land or was reverted.

`duplicate-of-open` is reserved for OPEN issues. Closed matches go to `closed-match` instead — they carry a regression signal that an open dup does not.

### Reasoning requirements

`prior-issue-reasoning` is required for every non-`new` annotation and must:

- Quote concrete evidence from both sides — the candidate's cited evidence and the prior issue's `body_summary`.
- Explain why the match is the same gap, not just a shared word or subsystem.
- For `closed-match`, explicitly state the regression hypothesis (gap reappeared; prior fix did not land or was reverted) and cite current evidence proving the gap is present now.

Vague reasoning ("similar topic", "related area", "same general space") fails Check 6 in review.

### False-`new` discipline

Before finalizing the assessment, sweep `prior-issues.json` once more for every candidate marked `new`. The reviewer's Check 6 explicitly looks for missed duplicates — it is cheaper to catch them during authoring than to replan after a REJECTED review.

## Assessment artifact shape

The auditor writes exactly one markdown file — the filled-out template at `assets/assessment-template.md`. The template is the contract for what sections must exist and in what order. `audit-reviewer` checks well-formedness against the same template.

## Verdict thresholds

The top-level `verdict` field on the assessment follows these rules:

- **`do-not-ship`**
  - any `P0` finding exists, or
  - launch-critical items are `UNVERIFIED` (build/release path, deploy path, required production config, external production exposure when enabled, auth/access control, security basics, tenant isolation for multi-tenant apps, data safety, rollback path, async processing for critical jobs/webhooks)

- **`ship-with-caution`**
  - no `P0`, but at least one `P1`, or
  - non-critical items remain `UNVERIFIED`, or
  - important hardening is missing even though the core path is evidenced

- **`ship`**
  - no `P0`
  - no `P1`
  - no launch-critical `UNVERIFIED`
  - remaining `P2` items are clearly deferrable

If evidence does not clearly support `ship`, do not upgrade the verdict. Reviewers: a verdict looser than the evidence supports is FAIL on verdict correctness.

## Hard rules

- Do not fix code in the same run.
- Do not silently upgrade `decision-required` into `execution-ready`.
- Do not call something production-ready on optimism.
- Do not collapse multiple unrelated fixes into one vague issue.
- Do not treat `.env.example` as policy; it is evidence.
- Do not run unsafe external probes during audit.
- Do not make audit parallel by default at the agent level. One `audit-assessor` writes one assessment and one `audit-reviewer` judges it. The auditor may batch independent read-only repo or external checks, but must keep a single artifact and evidence trail.
