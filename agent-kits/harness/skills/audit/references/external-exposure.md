# External Production Exposure Checks

Use this reference only when the audit run contract declares `external_exposure.enabled: true` and provides an `external_exposure.url`.

This is a safe black-box exposure smoke test, not a pentest. Its job is to find production-readiness blockers visible from the public edge without mutating the system.

## Scope

Check only the configured URL and same-origin paths discovered from repo routes, response headers, or public HTML. Do not scan unrelated hosts, cloud metadata IPs, private networks, or third-party services.

Allowed by default:

- `GET`
- `HEAD`
- `OPTIONS`
- `POST` only to the configured login endpoint when the run contract explicitly enables `auth_probe`

Forbidden in audit:

- `DELETE`
- `PUT`
- `PATCH`
- non-login `POST`
- file uploads
- password reset flows
- actions that send email, SMS, webhooks, or background jobs
- fuzzing, SQL injection payloads, XSS payloads, path traversal payloads, credential stuffing, or stress/load tests

If a safe read proves a finding, stop. Do not mutate the system to prove it harder.

## Data handling

- Prefer `HEAD` or `OPTIONS` before `GET` on sensitive routes.
- If a `GET` is needed to verify an auth gate, request the smallest response possible (`limit=1`, first page, or equivalent).
- Do not dump full records into the assessment.
- Redact PII, secrets, tokens, salaries, addresses, emails, and phone numbers. Cite field names and status codes, not full sensitive values.
- Do not store bearer tokens in the assessment. If token behavior matters, cite token transport and claim names only.

## Checks

### Transport

- HTTP redirects to HTTPS.
- HTTPS succeeds on the canonical host.
- HSTS is present once HTTPS is working.
- Raw IP access is not the intended production URL unless explicitly accepted by standards.

### Headers

- Security headers: CSP, HSTS, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, and frame protection.
- Version leakage: `Server`, `X-Powered-By`, framework-specific cache/debug headers.
- Cache headers on auth-aware pages and API responses. User-specific routes should not be publicly cacheable.

### Public API exposure

- Sensitive API routes require authentication before validation or data access.
- Public list/detail endpoints do not expose PII or tenant data unauthenticated.
- `OPTIONS` does not expose surprising dangerous methods without auth controls.
- Public docs/debug endpoints (`/docs`, `/redoc`, `/openapi.json`, `/swagger`, `/debug`, framework dev routes) are absent or intentionally protected.

### CORS

- Credentialed CORS is not paired with broad or reflected origins.
- Off-allowlist origins are rejected.
- Preflight behavior matches the repo's declared frontend domains.

### Auth/session smoke checks

Only run when the contract explicitly enables the check.

- Login response transport: httpOnly secure cookie vs bearer token in JSON body.
- Provided demo/default credentials: one login attempt with operator-provided credentials.
- Bad-login rate-limit smoke: at most three failed attempts. Absence of a `429` after three attempts is weak evidence; combine with repo/edge config before marking a strong failure.

Never guess credentials. Never try common passwords unless the exact credential pair is supplied by the operator for this audit.

State-changing probes do not belong in audit even with operator curiosity. If the next useful action is destructive or mutating, write a finding that names the skipped probe and the evidence already available.

### Indexing and operational endpoints

- `robots.txt` and `sitemap.xml` exist or are intentionally absent.
- Health/readiness endpoints exist where standards require them.
- Health endpoints do not leak secrets, full config, dependency URLs, or tenant data.

## Evidence format

For every external finding, cite:

- method and URL path
- status code
- relevant response headers
- redacted response shape when needed
- whether auth headers/cookies were present
- why the probe was safe

Example:

```text
GET /api/candidates?limit=1 without Authorization -> 200; response shape includes candidate profile fields. Redacted body; no state-changing method used.
```

## Escalation

If the next useful check would require mutation, stop and file a finding or blocker:

- "Unsafe confirmation skipped: DELETE would be required to prove destructive access. OPTIONS already exposes DELETE and unauthenticated GET proves the route is public."
- "Rate-limit depth unverified: contract allows max 3 bad login attempts; no 429 observed, but this is not enough to prove absence."
