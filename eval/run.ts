import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { vectorSearch } from "../src/retrieval/vector.js";
import { keywordSearch } from "../src/retrieval/keyword.js";
import { hybridSearch } from "../src/retrieval/hybrid.js";
import { extIdOf, type Retriever } from "../src/retrieval/types.js";
import { classify, runRouted } from "../src/router/route.js";
import { Trace } from "../src/obs/trace.js";
import { dbReady, closePool } from "../src/db.js";
import type { Strategy } from "../src/schema.js";
import { judgeAnswer } from "./judge.js";
import {
  dedupRanked,
  hitRateAtK,
  keywordRecall,
  mean,
  ndcgAtK,
  reciprocalRank,
} from "./metrics.js";

const K = 5;

interface Golden {
  q: string;
  answer_keywords: string[];
  relevant_ext_ids: string[];
  expected_strategy: Strategy;
}

interface Flags {
  limit: number;
  retrievalOnly: boolean;
  noJudge: boolean;
}

function parseFlags(argv: string[]): Flags {
  const f: Flags = { limit: Infinity, retrievalOnly: false, noJudge: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--limit") f.limit = Number(argv[++i]);
    else if (argv[i] === "--retrieval-only") f.retrievalOnly = true;
    else if (argv[i] === "--no-judge") f.noJudge = true;
  }
  return f;
}

async function loadGolden(limit: number): Promise<Golden[]> {
  const raw = await readFile("data/golden.jsonl", "utf8");
  const items = raw
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Golden);
  return Number.isFinite(limit) ? items.slice(0, limit) : items;
}

const DASH = "—";
const f3 = (n: number) => (Number.isNaN(n) ? DASH : n.toFixed(3));
const f1 = (n: number) => (Number.isNaN(n) ? DASH : n.toFixed(1));
const f6 = (n: number) => (Number.isNaN(n) ? DASH : n.toFixed(6));

// ─── Retrieval metrics (per config) ─────────────────────────────────────────
const RETRIEVERS: Record<string, Retriever> = {
  vector: vectorSearch,
  keyword: keywordSearch,
  hybrid: hybridSearch,
};

interface RetrievalRow {
  config: string;
  hit: number;
  mrr: number;
  ndcg: number;
  latency: number;
}

async function computeRetrieval(golden: Golden[]): Promise<{ rows: RetrievalRow[]; n: number }> {
  // Items with empty relevant_ext_ids have NO ground truth, so hit-rate/MRR/nDCG
  // are UNDEFINED for them (not zero). They are EXCLUDED here and scored only on
  // faithfulness/relevance + router accuracy below.
  const items = golden.filter((g) => g.relevant_ext_ids.length > 0);
  const rows: RetrievalRow[] = [];
  for (const [config, fn] of Object.entries(RETRIEVERS)) {
    const hits: number[] = [];
    const mrrs: number[] = [];
    const ndcgs: number[] = [];
    const lat: number[] = [];
    for (const g of items) {
      const t0 = performance.now();
      const res = await fn(g.q, { k: K });
      lat.push(performance.now() - t0);
      const ranked = dedupRanked(res.map(extIdOf));
      const rel = new Set(g.relevant_ext_ids);
      hits.push(hitRateAtK(ranked, rel, K));
      mrrs.push(reciprocalRank(ranked, rel));
      ndcgs.push(ndcgAtK(ranked, rel, K));
    }
    rows.push({ config, hit: mean(hits), mrr: mean(mrrs), ndcg: mean(ndcgs), latency: mean(lat) });
  }
  return { rows, n: items.length };
}

// ─── Answer metrics + router (per item, via the real router) ────────────────
interface ItemResult {
  expected: Strategy;
  chosen: Strategy;
  routerCorrect: boolean;
  faithfulness: number | null;
  relevance: number | null;
  kwRecall: number;
  latencyMs: number;
  costUSD: number;
}

async function runStrategies(
  golden: Golden[],
  noJudge: boolean,
): Promise<{ results: ItemResult[]; judgeCost: number }> {
  const results: ItemResult[] = [];
  const judgeTrace = new Trace("judge-overhead");

  for (const g of golden) {
    const trace = new Trace(g.q);
    const routed = classify(g.q); // routing decision (pre-fallback)
    const { answer, decision } = await runRouted(g.q, trace);

    let faithfulness: number | null = null;
    let relevance: number | null = null;
    let kwRecall = keywordRecall(answer.text, g.answer_keywords); // cheap, always available
    if (!noJudge) {
      if (decision.chosen === "deterministic") {
        // Verbatim DB record — faithful by construction; judge relevance only.
        faithfulness = 1.0;
        const j = await judgeAnswer(g.q, answer.text, answer.text, g.answer_keywords);
        if (j) {
          relevance = j.relevance;
          kwRecall = j.keywordContainment;
          judgeTrace.llm({ model: j.model, usage: j.usage });
        }
      } else {
        // Corpus evidence for the judge: empty for parametric direct answers;
        // hybrid top-k otherwise (approximate for agentic → faithfulness is a
        // lower bound, since the agent may gather evidence across tool calls).
        let context = "";
        if (g.expected_strategy !== "direct") {
          const hits = await hybridSearch(g.q, { k: 8 });
          context = hits.map((h) => `[${extIdOf(h)}] ${h.content}`).join("\n\n");
        }
        const j = await judgeAnswer(g.q, answer.text, context, g.answer_keywords);
        if (j) {
          faithfulness = j.faithfulness;
          relevance = j.relevance;
          kwRecall = j.keywordContainment;
          judgeTrace.llm({ model: j.model, usage: j.usage });
        }
      }
    }

    results.push({
      expected: g.expected_strategy,
      chosen: decision.chosen,
      routerCorrect: routed.chosen === g.expected_strategy,
      faithfulness,
      relevance,
      kwRecall,
      latencyMs: trace.latencyMs(),
      costUSD: trace.costUSD(),
    });
    process.stdout.write(`  ran ${results.length}/${golden.length}  [${g.expected_strategy}→${decision.chosen}]\r`);
  }
  process.stdout.write("\n");
  return { results, judgeCost: judgeTrace.costUSD() };
}

interface StrategyRow {
  strategy: Strategy;
  n: number;
  faith: number;
  rel: number;
  latency: number;
  cost: number;
}

function computeStrategyRows(results: ItemResult[]): StrategyRow[] {
  const order: Strategy[] = ["deterministic", "direct", "rag", "agentic"];
  const avg = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? mean(v) : NaN;
  };
  const rows: StrategyRow[] = [];
  for (const s of order) {
    const rs = results.filter((r) => r.chosen === s);
    if (rs.length === 0) continue;
    rows.push({
      strategy: s,
      n: rs.length,
      faith: avg(rs.map((r) => r.faithfulness)),
      rel: avg(rs.map((r) => r.relevance)),
      latency: mean(rs.map((r) => r.latencyMs)),
      cost: mean(rs.map((r) => r.costUSD)),
    });
  }
  return rows;
}

// ─── One combined table: retrieval-config rows + strategy rows ──────────────
// Retrieval metrics apply only to config rows; answer metrics only to strategy
// rows; cells that don't apply are "—" (not zero). Router accuracy is separate.
function combinedTable(retrieval: RetrievalRow[], strategy: StrategyRow[]): string {
  const lines = [
    "| row | hit-rate@5 | MRR | nDCG@5 | faithfulness | relevance | avg latency (ms) | avg cost (USD) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const r of retrieval) {
    lines.push(
      `| **${r.config}** _(retrieval)_ | ${f3(r.hit)} | ${f3(r.mrr)} | ${f3(r.ndcg)} | ${DASH} | ${DASH} | ${f1(r.latency)} | ${DASH} |`,
    );
  }
  for (const s of strategy) {
    lines.push(
      `| **${s.strategy}** _(strategy, n=${s.n})_ | ${DASH} | ${DASH} | ${DASH} | ${f3(s.faith)} | ${f3(s.rel)} | ${f1(s.latency)} | ${f6(s.cost)} |`,
    );
  }
  return lines.join("\n");
}

function routerReport(results: ItemResult[]): string {
  const correct = results.filter((r) => r.routerCorrect).length;
  const acc = results.length ? correct / results.length : 0;
  const misses = results.filter((r) => !r.routerCorrect);
  const lines = [
    `**Router accuracy: ${correct}/${results.length} = ${(acc * 100).toFixed(1)}%** (route() vs expected_strategy)`,
  ];
  for (const m of misses) lines.push(`- misroute: expected \`${m.expected}\` → routed \`${m.chosen}\``);
  return lines.join("\n");
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  await dbReady;
  const golden = await loadGolden(flags.limit);

  console.log(`\n# SentinelRAG eval — ${golden.length} golden items\n`);
  const { rows: rRows, n: rN } = await computeRetrieval(golden);

  if (flags.retrievalOnly) {
    console.log(combinedTable(rRows, []));
    console.log(`\n_Retrieval metrics over ${rN}/${golden.length} items — empty relevant_ext_ids excluded (undefined, not zero)._`);
    console.log("\n(retrieval-only: skipped strategy + judge eval)\n");
    return;
  }

  console.log("_running strategies via router (live LLM calls)…_\n");
  const { results, judgeCost } = await runStrategies(golden, flags.noJudge);

  console.log(combinedTable(rRows, computeStrategyRows(results)));
  console.log(
    `\n_Retrieval metrics: ${rN}/${golden.length} items (empty relevant_ext_ids excluded). Answer metrics + router: all ${golden.length}._`,
  );
  console.log("\n" + routerReport(results));
  if (!flags.noJudge) console.log(`\n_judge (LLM-as-judge) overhead cost: $${judgeCost.toFixed(6)}_`);
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error("\neval failed:", err);
    await closePool();
    process.exit(1);
  });
