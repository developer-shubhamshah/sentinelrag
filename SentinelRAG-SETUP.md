# SentinelRAG — Project Setup & Build Guide

A security-domain **query router** with a built-in **evaluation harness**.
For each incoming question it picks the cheapest sufficient strategy —
**deterministic lookup → direct LLM → RAG → agentic multi-step** — returns a
structured, cited, groundedness-checked answer, and ships an eval suite that
measures and compares every strategy.

> **Author:** Shubham Shah · **Target:** portfolio piece for Safe Security SDE III (AI/LLM)
> **Stack:** TypeScript / Node · Postgres + pgvector · Claude (generation + judge) · Voyage/OpenAI (embeddings)

---

## 0. Accuracy notes — read these first (so nothing here misleads you)

These are the few places where a tutorial would normally hallucinate. Verify
them against live sources, don't trust a pinned value:

1. **Claude does not produce embeddings.** There is no Anthropic embeddings
   endpoint. Use a dedicated embeddings provider:
   - **Voyage AI** (`voyage-3` family) — Anthropic's recommended partner.
   - **OpenAI** (`text-embedding-3-small` / `-large`) — common alternative.
   Claude is used here only for **generation** and for **LLM-as-a-judge**.
2. **Current Claude model IDs change.** Do not hardcode a model string from
   memory. Get the current list from the official docs before you code:
   `https://docs.claude.com/en/docs/about-claude/models` (and the docs map at
   `https://docs.claude.com/en/docs_site_map.md`). Put the chosen ID in `.env`,
   never inline.
3. **Postgres full-text search is NOT BM25.** Native Postgres FTS
   (`tsvector` + `ts_rank`/`ts_rank_cd`) is keyword ranking, good enough for the
   "sparse" side of hybrid search. If you want *true* BM25 inside Postgres you
   need the **ParadeDB `pg_search`** extension. This guide uses native FTS and
   fuses it with vector search via **Reciprocal Rank Fusion (RRF)** — call it
   "keyword + vector hybrid," not "BM25," in your README.
4. **Reranking needs an external model.** There's no reranker in Postgres.
   Options: **Cohere Rerank** API, **Voyage rerank** API, or a local
   cross-encoder (`bge-reranker`) behind a small Python service. Treat the
   reranker as optional (stretch goal).
5. **Data source endpoints change.** The two public corpora below are real, but
   confirm current URLs/rate limits before ingesting:
   - **NVD CVE API 2.0** — `https://nvd.nist.gov/developers/vulnerabilities`
   - **MITRE ATT&CK (STIX)** — `https://github.com/mitre-attack/attack-stix-data`
6. **RDS + pgvector:** pgvector is available on recent RDS Postgres versions but
   not all. Confirm your engine version supports `CREATE EXTENSION vector;`
   before relying on RDS. Locally, Docker `pgvector/pgvector` has it built in.

If any step below fails because a name/version moved, trust the live docs over
this file.

---

## 1. Prerequisites

- **Node.js 20 LTS+** (Claude Code requires 18+; use 20+ to be safe)
- **Docker** (for local Postgres+pgvector; avoids a native build)
- API keys in a `.env` (never commit):
  - `ANTHROPIC_API_KEY` — generation + judge
  - `VOYAGE_API_KEY` *or* `OPENAI_API_KEY` — embeddings
  - (optional) `COHERE_API_KEY` — reranking stretch goal
- `psql` client, and `git`

---

## 2. Repository layout

```
sentinelrag/
├─ README.md                 # the portfolio-facing writeup (see §11)
├─ SECURITY.md               # threat model → OWASP Top 10 + out-of-scope (see §9)
├─ SentinelRAG-SETUP.md      # this file
├─ .env.example
├─ docker-compose.yml        # postgres + pgvector
├─ package.json
├─ tsconfig.json
├─ .github/
│  └─ workflows/
│     └─ ci.yml              # vitest + npm audit + osv-scanner (fail high/crit)
├─ sql/
│  ├─ 001_schema.sql         # tables, vector + tsvector columns, indexes
│  └─ 002_indexes.sql
├─ data/
│  ├─ raw/                   # downloaded CVE / ATT&CK dumps (gitignored)
│  └─ golden.jsonl           # golden Q&A eval set (hand-curated)
├─ src/
│  ├─ config.ts              # env loading + model IDs (from .env)
│  ├─ db.ts                  # pg pool + pgvector type registration
│  ├─ llm/
│  │  ├─ claude.ts           # generation + judge wrappers
│  │  └─ embed.ts            # embeddings provider wrapper
│  ├─ ingest/
│  │  ├─ loadCve.ts
│  │  ├─ loadAttack.ts
│  │  └─ chunk.ts            # chunking + metadata
│  ├─ retrieval/
│  │  ├─ vector.ts           # dense search
│  │  ├─ keyword.ts          # FTS search
│  │  ├─ hybrid.ts           # RRF fusion
│  │  └─ rerank.ts           # optional cross-encoder/API
│  ├─ strategies/
│  │  ├─ deterministic.ts    # exact CVE-ID lookup, no LLM
│  │  ├─ directLlm.ts        # parametric answer, no retrieval
│  │  ├─ rag.ts              # retrieve → generate → cite
│  │  └─ agentic.ts          # tool-calling multi-step loop
│  ├─ router/
│  │  └─ route.ts            # classify query → choose strategy (+ log why)
│  ├─ guards/
│  │  ├─ groundedness.ts     # is the answer supported by context?
│  │  ├─ injection.ts        # prompt-injection screen on retrieved text
│  │  └─ ssrf.ts             # outbound-fetch allowlist (ingestion + agentic)
│  ├─ obs/
│  │  └─ trace.ts            # per-request latency / tokens / cost
│  ├─ schema.ts              # Zod schemas for structured output
│  └─ server.ts              # Fastify (or Hono) HTTP API
├─ eval/
│  ├─ metrics.ts             # hit-rate, MRR, nDCG
│  ├─ judge.ts               # LLM-as-a-judge faithfulness/relevance
│  └─ run.ts                 # runs golden set across all strategies → table
└─ test/
   └─ regression.test.ts     # vitest; fails build if quality drops
```

---

## 3. Dependencies (names are real; install latest, don't pin from memory)

```bash
npm init -y
npm i typescript tsx @types/node -D
npm i fastify zod dotenv pg pgvector
npm i @anthropic-ai/sdk
# embeddings — pick ONE:
npm i voyageai        # Voyage
# or
npm i openai          # OpenAI
# testing + eval:
npm i vitest -D
# optional reranker:
# npm i cohere-ai
npx tsc --init
```

> If an exact package name has moved, run `npm view <name>` to confirm before
> adding it. `pgvector` (npm) registers the vector type with `pg`; `voyageai`
> and `openai` are the official SDKs.

---

## 4. Local database (Day 1, morning)

`docker-compose.yml`:

```yaml
services:
  db:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_PASSWORD: dev
      POSTGRES_DB: sentinel
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
volumes: { pgdata: {} }
```

`sql/001_schema.sql` (adjust embedding dimension to your provider — Voyage
`voyage-3` is 1024, OpenAI `text-embedding-3-small` is 1536; **verify the exact
dim from the provider's docs** and keep it in one constant):

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE documents (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,          -- 'nvd' | 'attack'
  ext_id      TEXT NOT NULL,          -- e.g. 'CVE-2024-1234' or 'T1059'
  title       TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE chunks (
  id          BIGSERIAL PRIMARY KEY,
  document_id BIGINT REFERENCES documents(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  embedding   vector(1024),           -- <-- match your provider's dimension
  tsv         tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED
);
```

`sql/002_indexes.sql`:

```sql
-- dense ANN index (HNSW; cosine distance)
CREATE INDEX ON chunks USING hnsw (embedding vector_cosine_ops);
-- keyword index
CREATE INDEX ON chunks USING gin (tsv);
-- exact-ID lookups for the deterministic path
CREATE INDEX ON documents (ext_id);
```

Apply:
```bash
docker compose up -d
psql postgresql://postgres:dev@localhost:5432/sentinel -f sql/001_schema.sql
psql postgresql://postgres:dev@localhost:5432/sentinel -f sql/002_indexes.sql
```

---

## 5. Ingestion (Day 1, afternoon)

1. **Download** a *bounded* slice — you do NOT need all of NVD. Pull, say, CVEs
   from one recent year plus the full ATT&CK technique list. Keep it to a few
   thousand chunks so iteration stays fast.
2. **Chunk** (`src/ingest/chunk.ts`): recursive splitter, ~500–800 tokens with
   ~80-token overlap. Attach metadata: `source`, `ext_id`, `severity`,
   `published`, `product`. Metadata is what makes filtered retrieval possible.
3. **Embed** in batches (`src/llm/embed.ts`) and insert rows. Store the exact
   embedding model name in metadata so you can detect dimension mismatches later.

`src/llm/embed.ts` shape (Voyage example — confirm method name in the SDK's
README, SDKs rename things):

```ts
import { VoyageAIClient } from "voyageai";
const client = new VoyageAIClient({ apiKey: process.env.VOYAGE_API_KEY! });

export async function embed(texts: string[]): Promise<number[][]> {
  const res = await client.embed({ input: texts, model: "voyage-3" });
  return res.data.map(d => d.embedding!);
}
```

> Swap to OpenAI by calling `openai.embeddings.create({ model, input })` and
> reading `.data[i].embedding`. Keep the `embed()` signature identical so the
> rest of the code doesn't care which provider you chose.

---

## 6. Retrieval layer (Day 2, morning)

- **Vector** (`vector.ts`): `ORDER BY embedding <=> $queryVec LIMIT k`
  (`<=>` is cosine distance with `vector_cosine_ops`).
- **Keyword** (`keyword.ts`): `WHERE tsv @@ plainto_tsquery('english',$q)
  ORDER BY ts_rank_cd(tsv, plainto_tsquery(...)) DESC LIMIT k`.
- **Hybrid** (`hybrid.ts`): run both, fuse with **RRF**:
  `score(d) = Σ 1/(k + rank_i(d))` with `k≈60`. Simple, strong, no tuning.
- **Rerank** (`rerank.ts`, optional): take top ~20 fused, send `(query, passages)`
  to Cohere/Voyage rerank, keep top 5. Treat as a flag you can toggle for the
  eval so you can *measure* the lift.

Keep every retriever returning the same `{chunkId, content, score, metadata}[]`
so they're swappable — that interchangeability is the whole point of the demo.

---

## 7. The four strategies + the router (Day 2, afternoon)

Each strategy implements `run(query): Promise<Answer>` where `Answer` is a
Zod-validated object (see `src/schema.ts`):

```ts
import { z } from "zod";
export const Answer = z.object({
  text: z.string(),
  citations: z.array(z.object({ chunkId: z.number(), extId: z.string() })),
  strategy: z.enum(["deterministic","direct","rag","agentic"]),
  groundedness: z.number().min(0).max(1).nullable(),
});
export type Answer = z.infer<typeof Answer>;
```

- **deterministic.ts** — regex the query for a CVE ID / technique ID; if present,
  return the DB record directly. **No LLM, no embeddings.** Fastest + cheapest +
  100% faithful. This path existing is the "when NOT to use an LLM" signal.
- **directLlm.ts** — general conceptual question ("what is a context window?"):
  one Claude call, no retrieval. Cheap, but you mark `groundedness: null` and say
  so — honesty about parametric answers.
- **rag.ts** — retrieve (hybrid) → stuff top-k into a grounded prompt → Claude
  generates with **mandatory citations** → run groundedness guard.
- **agentic.ts** — a bounded tool-calling loop (Claude tool use). Give it 2–3
  tools: `searchCorpus`, `lookupById`, maybe `listRelatedTechniques`. Cap at
  ~4 iterations. Use for multi-hop questions ("how does T1059 chain to a
  mitigation, and which CVEs exploit it?").

**Router** (`router/route.ts`): the headline feature. A cheap classifier (rules
first, small Claude call as fallback) decides the path and **logs the reason**:

```ts
export function route(q: string): Strategy {
  if (/\bCVE-\d{4}-\d+\b/i.test(q) || /\bT\d{4}(\.\d+)?\b/.test(q))
    return "deterministic";           // exact ID → DB
  if (isMultiHop(q)) return "agentic"; // conjunctions / "how/why chain"
  if (isConceptual(q)) return "direct";// definitional, not corpus-specific
  return "rag";                        // default: ground it
}
```

Log `{query, chosen, reason, latency, tokens, costUSD}` for every request. That
log *is* your "informed engineering decisions about when to use what" evidence.

---

## 8. Guards (do these; they're cheap and they're the "security" in SentinelRAG)

- **Groundedness** (`guards/groundedness.ts`): second Claude call (judge) that
  scores whether each claim is supported by the retrieved chunks; below a
  threshold, return "insufficient evidence" instead of a confident wrong answer.
- **Prompt-injection screen** (`guards/injection.ts`): retrieved CVE/advisory
  text is untrusted input. Screen chunks for instruction-like content
  ("ignore previous", "system:", tool-call lures) before they reach the prompt,
  and keep retrieved content in a clearly delimited, data-only section. For a
  security employer this is a differentiator, not a nice-to-have.

---

## 9. Security hardening (Day 3 / parallel) — API-relevant concepts only

**Scope discipline first.** SentinelRAG is a JSON API over *public* data, with no
browser UI and no user accounts. So only the security concepts that actually
touch this design get built; the browser/auth ones are **deliberately out of
scope** and are documented as such (not silently ignored). Record both the
in-scope controls and the out-of-scope rationale in a `SECURITY.md`.

**Out of scope by design** (revisit only if you add a frontend or API auth):
XSS, CSRF, CORS (no frontend yet), secure sessions, JWT, OAuth, password hashing,
at-rest encryption of sensitive data. State *why* in `SECURITY.md` — "no browser
surface / no accounts / public corpus" — so it reads as a decision, not a gap.

**In scope — build these:**

- **SSRF guard** (`src/guards/ssrf.ts`): used by the ingestion fetcher **and every
  agentic tool that fetches**. Scheme + host allowlist; block private, loopback,
  and link-local ranges plus the cloud metadata IP (`169.254.169.254`); reject
  redirects to disallowed hosts. Unit-test the blocked ranges. (list #6)
- **Rate limiting** (`@fastify/rate-limit`): per-IP and global, limits from
  `.env`. This is cost/abuse control for the LLM calls, not just DDoS. (list #16)
- **Request-body validation**: Zod schemas at every route boundary, rejecting
  invalid input with a 4xx. Complements the Zod you already use on output. (#17)
- **Parameterized SQL**: audit all `pg` access in `src/` — every query uses `$1`
  placeholders; zero string-interpolated SQL. (list #2)
- **Security headers** (`@fastify/helmet`); `@fastify/cors` locked to origins from
  `.env` if/when a frontend exists (else documented N/A). (list #15)
- **Secrets hygiene**: `.env` gitignored, `.env.example` committed with empty
  keys; AWS Secrets Manager on deploy. (list #13)
- **Dependency scanning**: `npm audit` + `osv-scanner` in a GitHub Actions
  workflow on PRs, failing on high/critical. Cheap, strong signal. (list #18)
- **IAM least-privilege** (deploy / stretch): a dedicated Postgres role with only
  the needed SELECT/INSERT, and the service's IAM role scoped to just its secret
  + RDS connect. (list #14)
- **`SECURITY.md` threat model**: map each control above to the **OWASP Top 10**
  (list #1) and list the out-of-scope items with rationale.

> **Accuracy note:** the Fastify plugins, `npm audit`, `osv-scanner`, and
> parameterized `pg` queries are all real and stable — but confirm current plugin
> option names and the `osv-scanner` action usage against their own docs/READMEs
> before wiring config; don't trust remembered option keys.

**Definition of done (this phase):**

- [ ] SSRF guard blocks private/loopback/link-local/metadata; unit-tested; wired into ingestion + agentic fetch tools
- [ ] Rate limiting active (per-IP + global), limits from `.env`
- [ ] Every route body/params Zod-validated; invalid input rejected with 4xx
- [ ] All DB queries parameterized; zero string-interpolated SQL
- [ ] `@fastify/helmet` headers on; CORS restricted or documented N/A
- [ ] `.env` gitignored + `.env.example` committed
- [ ] CI runs `npm audit` + `osv-scanner`, fails on high/critical
- [ ] `SECURITY.md` maps controls → OWASP Top 10 and lists out-of-scope items with rationale
- [ ] (deploy) least-privilege DB role + scoped IAM in CloudFormation

---

## 10. Evaluation harness (Day 3, morning) — the single most important deliverable

1. **Golden set** (`data/golden.jsonl`): 30–50 hand-written items:
   ```json
   {"q":"Which CVEs affect OpenSSL 3.0 heap overflow?","answer_keywords":["CVE-2022-3602","CVE-2022-3786"],"relevant_ext_ids":["CVE-2022-3602","CVE-2022-3786"],"expected_strategy":"rag"}
   ```
2. **Retrieval metrics** (`eval/metrics.ts`): **hit-rate@k**, **MRR**, **nDCG**
   computed against `relevant_ext_ids`.
3. **Answer metrics** (`eval/judge.ts`): **LLM-as-a-judge** scoring faithfulness
   and relevance (0–1), plus a keyword/containment check as a cheap sanity net.
4. **Router accuracy**: did `route()` pick `expected_strategy`?
5. **Runner** (`eval/run.ts`): run the golden set under each retrieval config
   (vector only / keyword only / hybrid / hybrid+rerank) and each strategy,
   print a **Markdown comparison table** (strategy × metric × latency × cost).
   This table goes straight into the README — it's what makes a reviewer stop.
6. **Regression test** (`test/regression.test.ts`, vitest): assert aggregate
   scores stay above a floor, so a prompt/chunking change that regresses quality
   fails CI. Wire into a GitHub Action.

---

## 11. README (Day 3, afternoon) — map every JD bullet explicitly

Write the README so a reviewer sees the mapping without hunting:

- **LLM fundamentals** — embeddings (retrieval), token/context budgeting (cost
  tracking), hallucinations (groundedness guard).
- **AI-assisted dev** — a short "Built with Claude Code" section noting where you
  **accepted / rejected / corrected** AI-generated code. Honest and specific.
- **Pattern breadth** — structured outputs (Zod), tool/function calling
  (agentic), RAG, agentic — all in one system; link each to its file.
- **When to use what** — the router, with the decision log as proof.
- **Evaluation** — the comparison table + golden set + CI regression.
- **Production trade-offs** — latency/cost/accuracy table, caching, per-request
  traces, prompt-injection defense; link `SECURITY.md` and the hardening layer
  (SSRF, rate limiting, dependency scanning, least-privilege).
- **Security (§9)** — `SECURITY.md` threat model mapped to the OWASP Top 10, with
  deliberately out-of-scope items justified. Strong signal for a security employer.
- **DevOps (bonus)** — CloudFormation template for RDS (pgvector) + the service.

---

## 12. 3-day cut (priority order — ship the core, mark the rest as roadmap)

| Day | Land this | Covers JD bullets |
|-----|-----------|-------------------|
| 1 | DB + pgvector, ingest CVE+ATT&CK, embeddings | fundamentals |
| 2 | 4 retrievers (RRF hybrid), 4 strategies, router+logging | patterns, "when to use what" |
| 3 | eval harness + table, groundedness+injection guards, README | evaluation, trade-offs |
| 3 / parallel | Hardening (§9): SSRF, rate limit, input validation, dep scan, `SECURITY.md` | trade-offs (security) |
| Stretch | agentic multi-hop polish, reranker, CloudFormation→RDS, least-priv IAM | agentic, DevOps |

Hardening is scoped so the request-level items (SSRF, rate limit, validation,
headers, dep scan, `SECURITY.md`) fit in the core; IAM least-privilege rides with
the CloudFormation stretch row.

**Core = Day 1–3 without the stretch row**, and it already satisfies five of the
six AI/LLM bullets. The README frames the stretch row as "roadmap," which reads
as deliberate scoping, not unfinished work.

---

## 13. Definition of done (overall)

- [ ] `POST /ask` returns a Zod-valid `Answer` with citations + strategy + groundedness
- [ ] Deterministic path answers a CVE-ID query with zero LLM calls
- [ ] `eval/run.ts` prints the comparison table across retrieval configs
- [ ] Regression test green in CI
- [ ] Injection screen + groundedness guard active on the RAG path
- [ ] Hardening phase (§9) definition-of-done met: SSRF guard, rate limiting,
      request validation, parameterized SQL, dependency scanning, `SECURITY.md`
- [ ] README maps each JD bullet to a file/feature
- [ ] `.env.example` present; no secrets committed

---

*If any command, package name, model ID, or data endpoint here fails, treat the
live official docs as the source of truth over this file — it was written to be
verified, not trusted blindly.*
