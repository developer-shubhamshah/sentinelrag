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
- **Work one phase at a time.** Follow the 3-day cut in the setup file (§11).
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

Use the checklist in the setup file (§12) as the acceptance gate before moving
to the next phase or committing.

## Build log

Keep a short running note of what's done / decided / rejected here (or in the
README's "Built with Claude Code" section) so a fresh session has continuity:

**Day 1 — DB + ingest + embeddings (in progress)**
- Verified live (not from memory): OpenAI `text-embedding-3-small` = **1536 dims**
  → `vector(1536)`; NVD CVE API 2.0 base `https://services.nvd.nist.gov/rest/json/cves/2.0`
  (120-day window cap — we use 110 days of CVE_YEAR); ATT&CK enterprise STIX raw URL;
  Claude IDs `claude-opus-5-5` (gen) / `claude-haiku-5-5` (judge+router), all in `.env`.
- Chosen: embeddings = **OpenAI** (provider-agnostic `embed()` kept); git initialized.
- Stack installed: `@anthropic-ai/sdk ^1.7`, `openai ^7.55`, `pg ^8.23`, `pgvector ^0.3.1`,
  `zod ^4.6`, `fastify ^5.12`; `pgvector/pg` API is `registerTypes` (not deprecated `registerType`).
- Done: scaffold (`package.json` ESM, strict `tsconfig`, `.env(.example)`, `docker-compose`);
  `sql/001+002` applied (pgvector 0.8.7, HNSW cosine + GIN + ext_id indexes); `src/config.ts`
  (Zod env, `EMBED_DIM` derived from model), `src/db.ts` (pool + per-conn vector registration),
  `src/migrate.ts`, `src/llm/embed.ts`, `src/ingest/{chunk,loadCve,loadAttack,run}.ts`.
- **Infra note:** host Postgres 18 owns `5432`, so the container publishes on **5433**
  (`DATABASE_URL` updated). Docker Desktop must be running.
- **Ingested:** 1,906 docs (1,200 CVE + 706 ATT&CK) → 1,973 chunks, all embedded (0 null,
  dims=1536). DoD smoke passed: vector search returns the T1059 cluster (cos 0.36), FTS
  "cross-site scripting" returns 5 rows, exact T1059 lookup works, vectors read back as number[].
- Fixed en route: NVD 120-day window (→110d); host-Postgres 5432 clash (→5433); pgvector
  type-registration race (per-conn hook → race-free global parser keyed on the vector OID + `dbReady`).
- **Day 1 DONE.** Next: Day 2 — retrievers (vector/keyword/RRF hybrid), 4 strategies, router+logging.
  Needs `ANTHROPIC_API_KEY` in `.env` for the LLM strategies/judge.
