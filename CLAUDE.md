# CLAUDE.md — SentinelRAG

Security-domain **query router + eval harness**. For each question it routes to
the cheapest sufficient strategy — **deterministic → direct LLM → RAG →
agentic** — returns a Zod-validated, cited, groundedness-checked answer, and
ships an eval suite comparing strategies.

The full build guide (repo layout, schema, phases, definition-of-done) lives in
the setup file. Read it before implementing anything:

@SentinelRAG-SETUP.md

---

## Golden rules (do not skip)

- **Verify, don't hallucinate.** Package names, Claude model IDs, embedding
  dimensions, and data endpoints move. Confirm against live docs / SDK READMEs
  before writing code; never invent a model string or pin a version from memory.
- **Claude = generation + judge only. No Anthropic embeddings API.** Embeddings
  come from Voyage (`voyage-3`) or OpenAI (`text-embedding-3-*`). Keep the
  `embed()` signature provider-agnostic.
- **Work one phase at a time.** Follow the 3-day cut in the setup file (§12).
  Don't scaffold the whole system in one pass.
- **Plan before code.** Produce a short step plan for the current phase and wait
  for my review before editing files.
- **Every retriever/strategy returns the same shape** so they stay swappable —
  that interchangeability is the point of the demo.
- **Secrets live in `.env`** (gitignored). Never hardcode keys or commit `.env`.
- **Retrieved corpus text is untrusted.** Screen it for prompt injection and
  keep it in a delimited, data-only section of any prompt.

## Conventions

- **Language:** TypeScript (strict), Node 20+, ESM.
- **HTTP:** Fastify. **Validation:** Zod for all structured output and env.
- **DB:** Postgres + pgvector; access via `pg` pool in `src/db.ts` (register the
  pgvector type there). Cosine distance (`<=>`, `vector_cosine_ops`).
- **Embedding dimension** is a single exported constant — matches the provider.
- **Tests:** vitest. Eval + regression under `eval/` and `test/`.
- **Commits:** one per completed phase; message names the phase and the JD
  bullet(s) it covers.

## Run commands

> These are the intended scripts — add them to `package.json` as you build each
> phase; they won't all exist on Day 1.

```bash
docker compose up -d          # local Postgres + pgvector
npm run db:migrate            # apply sql/001_schema.sql, sql/002_indexes.sql
npm run ingest                # download + chunk + embed corpus (CVE + ATT&CK)
npm run dev                   # start the Fastify API (POST /ask)
npm run eval                  # run golden set across strategies → comparison table
npm test                      # vitest incl. regression gate
```

## Definition of done (per phase)

Use the checklist in the setup file (§13) as the acceptance gate before moving
to the next phase or committing.

## Build log

Keep a short running note of what's done / decided / rejected here (or in the
README's "Built with Claude Code" section) so a fresh session has continuity:

- **Day 1 ✓** — Postgres + pgvector, CVE + ATT&CK ingest (1,973 chunks, all embedded), provider-agnostic `embed()` (OpenAI `text-embedding-3-small`, 1536-dim).
- **Day 2 ✓** — 4 retrievers (vector/keyword/hybrid-RRF/rerank stub), 4 strategies, rules-first router with a per-request decision + cost/latency trace.
- **Day 3 ✓** — eval harness + comparison table (`eval/`, 30-item `data/golden.jsonl`; router 100%); §8 guards (injection screen + groundedness, wired into RAG); §9 hardening (SSRF guard + tests, Zod request validation, helmet/rate-limit/CORS, parameterized-SQL audit, CI with `npm audit` + OSV-Scanner, `SECURITY.md` → OWASP 2025, least-priv DB roles + scoped IAM in `infra/cloudformation.yaml`); README (JD-bullet map + real table); regression gate in CI.
- **Decisions / corrections** — reject *all* redirects in `safeFetch` (undici `redirect:'manual'` gives an unreadable opaque response); OWASP **2025** mapping (SSRF → A01); **two** DB roles (`sentinel_api` read-only + `sentinel_ingest` write) since ingest needs UPDATE/DELETE; eval caught a judge-context bug (deterministic faithfulness is 1.0 by construction); keyword rewritten to OR-of-lexemes (0.045 → 0.636), after which hybrid ≈ vector on this small set.
- **Pushed** to `origin/master`. All §13 boxes closed.
- **Roadmap (stretch)** — Cohere/Voyage reranker measured for lift, larger golden set, apply CloudFormation to real RDS.
