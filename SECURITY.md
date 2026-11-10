# SECURITY.md — SentinelRAG

Threat model and security controls for SentinelRAG, mapped to the
**OWASP Top 10:2025**. SentinelRAG is a JSON API over *public* security data; the
scope section explains which classes of risk apply and which are deliberately
out of scope.

> Status legend: **Implemented** (in `main`) · **Partial** (inline mitigation
> live, dedicated control pending) · **Planned** (designed, not yet applied) ·
> **Deploy** (in the CloudFormation stretch stack).

---

## 1. System & threat model (scope)

- **What it is:** a Fastify JSON API (`POST /ask`, `GET /health`) over a
  Postgres+pgvector corpus built from **public** sources (NVD CVE, MITRE ATT&CK).
- **What it is not:** no browser UI, no user accounts, no sessions, no PII, and
  no secrets stored in the corpus.
- **Trust boundaries:**
  1. Inbound HTTP request — untrusted.
  2. **Retrieved corpus text — untrusted** (treated as data, screened for
     prompt injection, never as instructions).
  3. Outbound fetches during ingestion — must not be steerable (SSRF).
  4. Calls to the LLM / embedding providers — data leaves our boundary.
- **Primary risks we design against:** SSRF, prompt injection via corpus text,
  SQL injection, LLM cost/abuse, vulnerable dependencies, and misconfiguration.

---

## 2. In-scope controls → OWASP Top 10:2025

| Control | Where | OWASP 2025 | Status |
|---|---|---|---|
| **SSRF guard** — scheme + host allowlist, resolve + block private/loopback/link-local/metadata (`169.254.169.254`), refuse redirects | `src/guards/ssrf.ts`, wired into `src/ingest/types.ts`; `test/ssrf.test.ts` | **A01** Broken Access Control (SSRF/CWE-918 folded in for 2025) | Implemented |
| **Least-privilege DB roles** — read-only `sentinel_api`, write-scoped `sentinel_ingest`, no DDL | `sql/003_roles.sql`, `infra/cloudformation.yaml` | **A01** Broken Access Control | Deploy |
| **Scoped service IAM role** — only `secretsmanager:GetSecretValue` on one secret + `rds-db:connect` as `sentinel_api` | `infra/cloudformation.yaml` | **A01** Broken Access Control | Deploy |
| **Security headers (helmet) + CORS lockdown** (origins from `.env`, else disabled) | `src/server.ts` (plugin registration) | **A02** Security Misconfiguration | Planned |
| **Secrets hygiene** — `.env` gitignored, `.env.example` keys blank, Secrets Manager on deploy | `.gitignore`, `.env.example`, `infra/cloudformation.yaml` | **A02** Security Misconfiguration | Implemented |
| **Dependency scanning** — `npm audit --audit-level=high` + OSV-Scanner on PRs, fail on high/critical | `.github/workflows/ci.yml` | **A03** Software Supply Chain Failures (new in 2025) | Implemented |
| **Parameterized SQL** — every query uses `$1` placeholders; zero string-interpolated values (audited) | all `src/**` `pg` queries | **A05** Injection | Implemented |
| **Prompt-injection screen** — screens each retrieved chunk for instruction-like lures (ignore/override, role headers, template markers) and **excludes** flagged chunks; survivors sit in a delimited, data-only `<context>` block | `src/guards/injection.ts`, `src/strategies/rag.ts`; `test/injection.test.ts` | **A05** Injection (LLM) | Implemented |
| **Request validation** — Zod on every route body + query params, 4xx on invalid, `.strict()` rejects unknown keys | `src/server.ts` | **A06** Insecure Design | Implemented |
| **Rate limiting** — per-IP + global, limits from `.env` (LLM cost/abuse control) | `src/server.ts` (plugin registration) | **A06** Insecure Design | Planned |
| **Per-request tracing** — latency / tokens / cost logged per request | `src/obs/trace.ts` | **A09** Security Logging & Alerting Failures | Implemented |
| **Graceful exceptional-condition handling** — ID-miss → RAG fallback, "insufficient evidence" instead of a confident wrong answer, refusal handling, agentic iteration cap → forced synthesis, SSRF/HTTP failures surfaced not swallowed | `src/router/route.ts`, `src/strategies/*`, `src/guards/ssrf.ts` | **A10** Mishandling of Exceptional Conditions (new in 2025) | Implemented |
| **Groundedness guard** — judge scores answer support; below `GROUNDEDNESS_THRESHOLD` (.env) the RAG path returns "insufficient evidence" and reports the score | `src/guards/groundedness.ts`, `src/strategies/rag.ts` | **A05/A10** (hallucination control) | Implemented |

---

## 3. Out of scope — by design, with rationale

Revisit only if a browser frontend or API authentication is added. These are
**decisions**, not gaps.

| Excluded | Why it does not apply |
|---|---|
| **Authentication / accounts** (the access-control surface *within* A01 we don't build) | No user accounts; single-tenant service over public data. The A01 controls we *do* build are SSRF + DB/IAM least-privilege. |
| XSS / output encoding | No browser UI; responses are JSON consumed by API clients. |
| CSRF | No cookies, no browser session, no authenticated state-changing actions. |
| CORS (permissive-origin concern) | No frontend origin to allow; CORS is locked/disabled by default. |
| Sessions / JWT / OAuth | No login surface. |
| Password hashing | No credentials are stored by the app. |
| At-rest encryption of *sensitive* data | Corpus is public; no PII/secrets persisted. (RDS storage encryption is still enabled in the template as baseline hygiene.) |

---

## 4. Residual risks & assumptions

- **LLM provider trust:** query text and retrieved context are sent to Anthropic
  (generation/judge) and the embedding provider. Those providers are trusted.
- **DNS-rebinding on egress:** `safeFetch` validates resolved IPs, but Node's
  `fetch` re-resolves DNS on connect, so a determined rebind could differ from
  what was checked. The **host allowlist** is the primary control; the address
  screen is defence in depth.
- **Corpus poisoning upstream:** NVD/MITRE content is trusted at ingest time;
  the injection screen reduces but does not eliminate the risk of hostile text
  in an advisory.
- **Rate limits are per-instance** unless backed by a shared store.
- **Migrations run as the admin/master role**, not the least-privilege roles —
  DDL is intentionally outside `sentinel_api`/`sentinel_ingest`.

---

## 5. Reporting a vulnerability

Report suspected vulnerabilities privately via a GitHub Security Advisory on this
repository (no public issue). Supported: the `main` branch. This is a portfolio
project with no bug-bounty program.
