# Blocker Categories

Four categories. The enum is closed so the lint script can check membership, but the taxonomy is provisional — it was drafted before most real blocker shapes had been observed. If your blocker doesn't cleanly fit, pick the closest and use the template's `## Category fit note` section to explain the mismatch. Honest misfits are how this reference improves.

Status note: as of 2026-04-27, this taxonomy is still provisional. Treat examples as illustrative rather than authoritative; honest category misfits are useful signal for improving the reference.

---

## implementation-failure

**When:** The code under the executor's write-authority cannot be made to satisfy the oracle, and the accepted artifacts and oracle bundle both appear correct.

**Typical triggers:**

- An iteration loop has run N times without narrowing the failure class.
- The implementation depends on something outside the executor's control (an external service is returning unexpected shapes; a binary the executor can't install is required; a port the executor can't rebind is already bound).
- The build target fails to boot entirely.

**Decision the conductor is being asked to make (bounded):**

- Extend the iteration budget, OR
- Accept the failure as a known limitation and move on, OR
- Abort the slice and split it smaller, OR
- Authorize a specific protected-surface change that would unblock (in which case the report should name the exact change, not "change the oracle somehow").

**Example — boot failure shape:**

> Category: implementation-failure
>
> Failing surface: Phase 0 boot, `docker compose up` in prototype/
>
> Observed behavior: `Error response from daemon: driver failed programming external connectivity on endpoint prototype-web-1: Bind for 0.0.0.0:3000 failed: port is already allocated` (and four retries produced the same error)
>
> What was tried: (1) retry with default port → same error; (2) inspect `docker ps` to find conflicting container → conflict is with `prototype-web-old`, orphaned from a previous run; (3) attempted to stop `prototype-web-old` → `permission denied` (probe doesn't have container stop authority)
>
> Smallest decision required: Grant container-stop authority for orphaned `prototype-web-*` containers, or manually stop the orphan and retry.

**Example — oracle-iteration shape (expected but not yet observed):**

> Category: implementation-failure
>
> Failing surface: oracle/contract/payments.test.ts::"POST /api/charges returns 201 with charge id"
>
> Observed behavior: <failing test output across five iterations, each shrinking a different branch of the handler without making the test pass>
>
> Smallest decision required: Extend budget by 3 iterations, or accept the failing test as a known limitation until external service integration is resolved.

---

## artifact-ambiguity

**When:** An accepted artifact is unclear enough that two reasonable implementations would diverge, and the executor cannot pick without effectively deciding intent.

**Typical triggers:**

- A user journey references an action that maps to more than one declared endpoint.
- An entity in `data-model.json` has a field the journey relies on but the ORM/DB source definitions disagree on its type or nullability.
- A design-direction section says "primary CTA uses the brand gradient" but the gradient has three variants and no rule for which to pick when.

**Decision the conductor is being asked to make:**

- Pick between the ambiguous options (with the executor's reasoning attached), OR
- Return the artifact to the authoring worker for disambiguation, OR
- Accept the ambiguity as a known underspec and document the executor's chosen interpretation as the fixed choice going forward.

**Example — shape expected but not yet observed:**

> Category: artifact-ambiguity
>
> Failing surface: `artifacts/user-journeys.json::journeys[2].steps[4]` ("user removes their account") maps to both `DELETE /api/users/{id}` (hard-delete) and `POST /api/users/{id}/deactivate` (soft-delete) in `api-spec.json`.
>
> Observed behavior: journey text does not distinguish; both endpoints are marked `observed` and `declared` in the merged spec with different side-effects.
>
> Smallest decision required: Does journey step "user removes their account" mean hard-delete or soft-delete?

---

## oracle-contradiction

**When:** The oracle bundle contradicts an accepted artifact, or two oracle layers contradict each other, and fixing one side without authorization would amount to an executor rewriting the judge.

**Typical triggers:**

- A contract test asserts a status code that the corresponding journey check expects to be different.
- A policy check enforces a rule the journey assumes is absent.
- An oracle layer was authored against an earlier version of an artifact and wasn't regenerated when the artifact was revised.

**Decision the conductor is being asked to make:**

- Authorize a specific oracle revision (naming which side is authoritative), OR
- Authorize an artifact revision, OR
- Accept the contradiction as a known gap (with a specific test marked `xfail` or `skipped-with-reason`).

**Example — shape expected but not yet observed:**

> Category: oracle-contradiction
>
> Failing surface: `oracle/contract/signup.test.ts` asserts `POST /api/users` returns 201; `oracle/journey/onboarding.test.ts` asserts the onboarding flow proceeds on a 200 response from the same endpoint.
>
> Observed behavior: `api-spec.json` lists the endpoint as returning 201. Journey test passes against a stubbed 200. Contract test fails when the implementation returns 201 because the journey test's fixture layer rewrites the status.
>
> Smallest decision required: Which is authoritative — the contract test at 201 or the journey test at 200? Revise the other side to match.

---

## policy-conflict

**When:** A policy default (auth required, tenant isolation, destructive-action gating, etc.) cannot be satisfied while also satisfying an accepted artifact.

**Typical triggers:**

- `api-spec.json` declares an endpoint that the policy layer would block or modify (e.g., an admin endpoint that bypasses tenant scoping).
- `user-journeys.json` includes a flow that the destructive-action policy would intercept.
- A policy default was added after artifacts were accepted, and the existing artifacts do not accommodate it.

**Decision the conductor is being asked to make:**

- Grant a named exception to the policy default for the conflicting artifact (with the exception recorded), OR
- Revise the artifact to comply with the policy, OR
- Revise the policy default.

**Example — shape expected but not yet observed:**

> Category: policy-conflict
>
> Failing surface: `api-spec.json::endpoints[17]` — `DELETE /api/admin/tenants/{id}` — conflicts with policy default "all writes must be tenant-scoped."
>
> Observed behavior: endpoint is declared and observed; policy-check oracle layer flags it as violating tenant-scope enforcement.
>
> Smallest decision required: Grant a named policy exception for `/api/admin/*` routes, or revise `api-spec.json` to remove the admin endpoint from the build scope.

---

## Open question about the taxonomy

The first real blocker observed (`boot-failed`) fits `implementation-failure` only by stretching the word "implementation" to include "running the prototype." A future revision might split out an `environment-failure` or `prerequisite-failure` category for boot/runtime/dependency issues. Don't add that category preemptively — add it when a second environment-style blocker with a different shape makes the pattern concrete. The current guidance is: use `implementation-failure` for environment blockers and note the fit in `## Category fit note`.
