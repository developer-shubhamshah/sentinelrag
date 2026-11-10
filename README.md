# SentinelRAG

A security-domain **query router** with a built-in **evaluation harness**. For
each question it picks the *cheapest sufficient* strategy —
**deterministic lookup → direct LLM → RAG → agentic multi-step** — returns a
Zod-validated, cited, groundedness-checked answer, and ships an eval suite that
measures and compares every strategy.

> **Stack:** TypeScript (strict, ESM, Node 20+) · Fastify · Postgres + pgvector ·
> Claude (generation + LLM-as-a-judge) · Voyage/OpenAI (embeddings) ·
> corpus = **NVD CVE** + **MITRE ATT&CK**.
>
> Claude is used **only** for generation and judging — never embeddings (there is
> no Anthropic embeddings API). Model IDs live in `.env`, never hardcoded.

---

## Why it's built this way

Most "RAG demos" send every question through the same retrieve-then-generate
pipeline. That's wasteful and often *less* faithful than a direct DB lookup. The
headline feature here is a **router** that classifies each query and sends it to
the cheapest path that can answer it correctly, logging *why*. The eval harness
then proves the trade-off with real numbers.

```
query ──► route() ──┬─ deterministic   exact CVE/ATT&CK id → DB record, no LLM
                    ├─ direct          conceptual question → 1 Claude call, no retrieval
                    ├─ rag             corpus question → hybrid retrieve → grounded generate
                    └─ agentic         multi-hop → bounded Claude tool-use loop
```

---

## JD bullet → where it lives

| JD area | In this repo |
|---|---|
| **LLM fundamentals** — embeddings, token/context budgeting, hallucinations | embeddings drive retrieval (`src/llm/embed.ts`, `src/retrieval/vector.ts`); per-request **token/cost budgeting** (`src/obs/trace.ts`); hallucination control via the groundedness guard (`src/guards/groundedness.ts`) |
| **Pattern breadth** — structured output, tool/function calling, RAG, agentic | Zod structured output (`src/schema.ts`); tool-use loop (`src/strategies/agentic.ts`); RAG (`src/strategies/rag.ts`); all four strategies behind one `Answer` shape |
| **When to use what** — informed routing | `src/router/route.ts` (rules-first classifier) + a per-request decision log (`{query, chosen, reason, latency, tokens, costUSD}`) |
| **Evaluation** — metrics, golden set, regression | `eval/metrics.ts` (hit-rate@k, MRR, nDCG), `eval/judge.ts` (LLM-as-judge), `eval/run.ts` (comparison table), `data/golden.jsonl` (30 hand-curated items); CI regression gate (`test/regression.test.ts` — router accuracy + metric math, no LLM) |
| **Production trade-offs** — latency/cost/accuracy, tracing, injection defense | the comparison table below; `src/obs/trace.ts`; prompt-injection screen that excludes instruction-like chunks (`src/guards/injection.ts`) + data-only context (`src/strategies/rag.ts`) |
| **Security** — threat model → OWASP | [`SECURITY.md`](./SECURITY.md) maps every control to **OWASP Top 10:2025**; SSRF guard (`src/guards/ssrf.ts`), request validation, parameterized SQL, rate-limit/helmet/CORS, dependency-scan CI |
| **DevOps (bonus)** — IaC | `infra/cloudformation.yaml` (RDS pgvector + Secrets Manager + least-privilege IAM/DB roles), `sql/003_roles.sql`, `.github/workflows/ci.yml` |
| **AI-assisted dev** | ["Built with Claude Code"](#built-with-claude-code) below |

---

## Evaluation results

Run with `npm run eval` against a live corpus (1,973 chunks: 1,200 CVEs +
706 ATT&CK techniques). Golden set: 30 hand-curated items with ext_ids verified
against the corpus.

**Retrieval configs** (k=5, over the 22 items with gold ext_ids):

| config | hit-rate@k | MRR | nDCG@k | avg latency (ms) |
| --- | ---: | ---: | ---: | ---: |
| vector | 0.727 | 0.623 | 0.610 | 583 |
| keyword (OR-of-lexemes) | 0.636 | 0.485 | 0.489 | 9 |
| hybrid (RRF) | 0.727 | 0.623 | 0.596 | 488 |

**Strategies** (executed through the real router):

| strategy | n | faithfulness | relevance | keyword-recall | avg latency (ms) | avg cost (USD) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| deterministic | 6 | 1.000¹ | 1.000 | 1.000 | 1,525 | $0.000000 |
| direct | 8 | 0.881 | 1.000 | 1.000 | 7,507 | $0.007726 |
| rag | 11 | 0.980 | 1.000 | 1.000 | 5,482 | $0.009907 |
| agentic | 5 | 0.270² | 0.840 | 1.000 | 15,143 | $0.026556 |

**Router accuracy: 30/30 = 100%.**

What the numbers say:
- **Keyword is a fair baseline now, and embeddings dominate.** The keyword
  retriever first scored 0.045 — `plainto_tsquery` AND-joins every lexeme, so
  paraphrased questions matched nothing. Rewriting the query to **OR-of-lexemes**
  (rank by term coverage) lifted it to 0.636. With a real keyword signal, hybrid
  (RRF) and vector land neck-and-neck on this 22-item set: vector embeddings carry
  these semantic paraphrase queries, while keyword adds recall *and* some fusion
  noise. Robustly separating hybrid from vector wants a larger golden set and a
  reranker (roadmap). This is the eval doing its job — a fix it prompted then
  exposed a precision/recall trade-off, measured rather than assumed.
- **The cost/latency ladder justifies routing**: deterministic $0 / 1.5s →
  rag $0.010 / 5.5s → agentic $0.027 / 15s. Answering a CVE-ID lookup with the
  deterministic path instead of agentic is ~**15× faster and free**.
- ¹ Deterministic faithfulness is **1.0 by construction** (verbatim DB record, no
  generation) — not LLM-judged. ² Agentic faithfulness is a **lower bound**: the
  judge sees only hybrid-top-8, not everything the agent gathered across tool
  calls. Both caveats are documented in `eval/run.ts`.

---

## Security

SentinelRAG is a JSON API over *public* data with no browser UI and no accounts,
so only the security concepts that touch this design are built; the browser/auth
ones are **deliberately out of scope** and justified as such. See
[`SECURITY.md`](./SECURITY.md) for the full threat model mapped to OWASP
Top 10:2025. In scope and implemented: SSRF guard (scheme/host allowlist +
resolved-IP screen + redirect refusal, unit-tested), request validation (Zod on
every route), parameterized SQL (audited), security headers + CORS lockdown +
two-tier rate limiting, and `npm audit` + OSV-Scanner in CI. Deploy stack adds a
read-only `sentinel_api` DB role and an IAM role scoped to one secret + RDS
connect.

---

## Running it

```bash
docker compose up -d          # local Postgres + pgvector
cp .env.example .env          # fill in ANTHROPIC_API_KEY + OPENAI_API_KEY (or Voyage)
npm install
npm run db:migrate            # sql/001_schema.sql, 002_indexes.sql (003_roles.sql on deploy)
npm run ingest                # download + chunk + embed CVE + ATT&CK (bounded slice)
npm run dev                   # Fastify API — POST /ask
npm run eval                  # golden set across strategies → the table above
npm test                      # vitest: SSRF + injection guards + regression gate (router accuracy floor)
```

`POST /ask` returns a Zod-valid `Answer` (`{ text, citations, strategy,
groundedness }`) plus the routing decision and a per-request trace.

---

## Built with Claude Code

This project was built with Claude Code. Honest notes on where AI output was
**accepted, rejected, or corrected** — the point is that the generated code was
*verified*, not trusted:

- **Corrected (don't trust an API from memory):** the SSRF guard originally
  planned to "reject redirects to *disallowed* hosts." Verifying Node's `fetch`
  (undici) against the Fetch spec showed `redirect:'manual'` returns an **opaque**
  response whose `Location` is unreadable — so selective redirect filtering is
  impossible with global `fetch`. Corrected to **reject all redirects**, the only
  sound behavior, and documented why.
- **Corrected (verify, don't hallucinate):** the OWASP mapping was written only
  after confirming **OWASP Top 10:2025** against the live source — SSRF is no
  longer standalone (folded into A01), with new A03 (Supply Chain) and A10
  (Exceptional Conditions). A from-memory 2021 mapping would have been wrong.
- **Caught by the eval (not by me):** the first eval run reported deterministic
  faithfulness **0.245** and agentic **0.256**. That was a flaw in the *judge
  harness*, not the strategies — the judge was fed hybrid-retrieved context,
  which is wrong ground truth for the verbatim-record deterministic path. Fixed
  the judge context and re-ran; deterministic → 1.0.
- **Deviated from the literal spec for correctness:** the task said "a
  least-privilege role with SELECT/INSERT." Auditing the ingestion code showed it
  also issues `UPDATE` (upsert) and `DELETE` (clean re-ingest), so the real design
  is **two** roles — read-only `sentinel_api` for the service, write-scoped
  `sentinel_ingest` for the batch — not one.
- **Verified before wiring:** Fastify plugin names/versions/options
  (`@fastify/{helmet,rate-limit,cors}`) and the OSV-Scanner action name/tag were
  confirmed against their own READMEs/docs, not assumed.
- **Accepted as-is:** the overall layered architecture (swappable retrievers
  behind one `Retrieved` shape, strategies behind one `Answer` shape), RRF hybrid
  fusion, and the Zod-everywhere boundary.

---

## Roadmap (deliberate scoping, not unfinished work)

- **Retrieval** — optional Cohere/Voyage reranker (`src/retrieval/rerank.ts`)
  measured for lift; a larger golden set to separate hybrid from vector robustly.
- **Deploy** — apply the CloudFormation stack to RDS; confirm the engine version
  supports `CREATE EXTENSION vector`.
