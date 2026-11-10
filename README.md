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
706 ATT&CK techniques). Golden set: 41 hand-curated items, each derived from a
real document and verified against the corpus; **33 carry gold `ext_id`s** and 8
(general-concept + deliberately-unanswerable) do not.

One combined table — retrieval metrics apply only to the config rows, answer
metrics only to the strategy rows, `—` where a metric doesn't apply. Items with
empty `relevant_ext_ids` are **excluded** from retrieval metrics (undefined, not
zero) and scored only on faithfulness/relevance + routing.

| row | hit-rate@5 | MRR | nDCG@5 | faithfulness | relevance | avg latency (ms) | avg cost (USD) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **vector** *(retrieval)* | 0.758 | 0.712 | 0.709 | — | — | 500 | — |
| **keyword** *(retrieval)* | 0.636 | 0.430 | 0.462 | — | — | 12 | — |
| **hybrid** *(retrieval)* | 0.758 | 0.639 | 0.661 | — | — | 467 | — |
| **hybrid+rerank** *(retrieval)* | **0.848** | **0.813** | **0.816** | — | — | 5,670† | — |
| **deterministic** *(n=8)* | — | — | — | 1.000¹ | 1.000 | 1,428 | $0.000000 |
| **direct** *(n=6)* | — | — | — | 0.900 | 1.000 | 8,018 | $0.008283 |
| **rag** *(n=22)* | — | — | — | 0.996 | 0.984 | 6,407 | $0.010753 |
| **agentic** *(n=5)* | — | — | — | 0.634² | 0.950 | 13,109 | $0.019812 |

**Router accuracy: 41/41 = 100%** (retrieval metrics over 33/41 items; judge overhead ≈ $0.017).

What the numbers say:
- **The cost/latency ladder justifies routing**: deterministic $0 / 1.4s → rag
  $0.011 / 6.4s → agentic $0.020 / 13.1s. Answering a CVE-ID lookup on the
  deterministic path instead of agentic is ~**9× faster and free**.
- **A reranker resolves the vector-vs-hybrid gap and wins outright.** On the
  41-item set plain RRF hybrid trailed vector on ranking (MRR 0.639 vs 0.712).
  Adding a **Cohere cross-encoder rerank** over the top-20 fused pool lifts
  `hybrid+rerank` to **0.848 / 0.813 / 0.816** — beating vector on all three
  (MRR +0.10, nDCG +0.11). Isolated from the deeper-pool effect (passthrough
  baseline 0.818 / 0.663 / 0.693), the cross-encoder *alone* adds **+0.15 MRR /
  +0.12 nDCG**. († the ≈5.7s latency is inflated by trial-key rate-limit backoff;
  the rerank call itself is a few hundred ms. Measured, not yet in the serving path.)
- **Keyword is a fair baseline** (not the ~0.05 it scored under `plainto_tsquery`
  AND-semantics; rewriting to OR-of-lexemes made it competitive at 0.636) — but on
  this corpus the dense embeddings clearly dominate it.
- **The groundedness guard shows up in the numbers.** The deliberately-unanswerable
  items route to `rag` and return "insufficient evidence", nudging `rag` relevance
  to 0.984 rather than 1.0 — the guard refusing to answer, by design.
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

- **Adopt `hybrid+rerank` in the serving path** — the eval shows it beats hybrid
  and vector; wiring it into `rag.ts` (it's currently eval-only) is a small change.
- **Deploy** — apply the CloudFormation stack to RDS; confirm the engine version
  supports `CREATE EXTENSION vector`.
