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

const f3 = (n: number) => n.toFixed(3);
const f1 = (n: number) => n.toFixed(1);

// ─── Retrieval comparison (vector / keyword / hybrid) ───────────────────────
const RETRIEVERS: Record<string, Retriever> = {
  vector: vectorSearch,
  keyword: keywordSearch,
  hybrid: hybridSearch,
};

async function retrievalTable(golden: Golden[]): Promise<string> {
  const items = golden.filter((g) => g.relevant_ext_ids.length > 0);
  const lines = [
    `### Retrieval configs (k=${K}, over ${items.length} items with gold ext_ids)`,
    "",
    "| config | hit-rate@k | MRR | nDCG@k | avg latency (ms) |",
    "| --- | ---: | ---: | ---: | ---: |",
  ];
  for (const [name, fn] of Object.entries(RETRIEVERS)) {
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
    lines.push(
      `| ${name} | ${f3(mean(hits))} | ${f3(mean(mrrs))} | ${f3(mean(ndcgs))} | ${f1(mean(lat))} |`,
    );
  }
  return lines.join("\n");
}

// ─── Strategy comparison (via the real router) ──────────────────────────────
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
    const routed = classify(g.q); // the routing decision (pre-fallback)
    const { answer, decision } = await runRouted(g.q, trace);

    let faithfulness: number | null = null;
    let relevance: number | null = null;
    if (!noJudge) {
      if (decision.chosen === "deterministic") {
        // The deterministic answer is the verbatim DB record — faithful by
        // construction (no generation). Score faithfulness 1.0 and only judge
        // relevance (does the record address the question?).
        faithfulness = 1.0;
        const j = await judgeAnswer(g.q, answer.text, answer.text);
        if (j) {
          relevance = j.relevance;
          judgeTrace.llm({ model: j.model, usage: j.usage });
        }
      } else {
        // Give the judge corpus evidence: empty for parametric direct answers;
        // hybrid top-k otherwise. NOTE: for agentic this is approximate — the
        // agent may cite evidence gathered across several tool calls that this
        // single retrieval doesn't surface, so agentic faithfulness is a lower bound.
        let context = "";
        if (g.expected_strategy !== "direct") {
          const hits = await hybridSearch(g.q, { k: 8 });
          context = hits.map((h) => `[${extIdOf(h)}] ${h.content}`).join("\n\n");
        }
        const j = await judgeAnswer(g.q, answer.text, context);
        if (j) {
          faithfulness = j.faithfulness;
          relevance = j.relevance;
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
      kwRecall: keywordRecall(answer.text, g.answer_keywords),
      latencyMs: trace.latencyMs(),
      costUSD: trace.costUSD(),
    });
    process.stdout.write(
      `  ran ${results.length}/${golden.length}  [${g.expected_strategy}→${decision.chosen}]\r`,
    );
  }
  process.stdout.write("\n");
  return { results, judgeCost: judgeTrace.costUSD() };
}

function strategyTable(results: ItemResult[]): string {
  const order: Strategy[] = ["deterministic", "direct", "rag", "agentic"];
  const avg = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? mean(v) : NaN;
  };
  const cell = (n: number) => (Number.isNaN(n) ? "—" : f3(n));

  const lines = [
    "### Strategies (executed via router)",
    "",
    "| strategy | n | faithfulness | relevance | keyword-recall | avg latency (ms) | avg cost (USD) |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const s of order) {
    const rows = results.filter((r) => r.chosen === s);
    if (rows.length === 0) continue;
    lines.push(
      `| ${s} | ${rows.length} | ${cell(avg(rows.map((r) => r.faithfulness)))} | ${cell(
        avg(rows.map((r) => r.relevance)),
      )} | ${f3(mean(rows.map((r) => r.kwRecall)))} | ${f1(mean(rows.map((r) => r.latencyMs)))} | ${mean(
        rows.map((r) => r.costUSD),
      ).toFixed(6)} |`,
    );
  }
  return lines.join("\n");
}

function routerReport(results: ItemResult[]): string {
  const correct = results.filter((r) => r.routerCorrect).length;
  const acc = results.length ? correct / results.length : 0;
  const misses = results.filter((r) => !r.routerCorrect);
  const lines = [
    "### Router accuracy (route() vs expected_strategy)",
    "",
    `**${correct}/${results.length} = ${(acc * 100).toFixed(1)}%**`,
  ];
  if (misses.length) {
    lines.push("", "Misroutes:");
    for (const m of misses) lines.push(`- expected \`${m.expected}\` → routed \`${m.chosen}\``);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  await dbReady;
  const golden = await loadGolden(flags.limit);

  console.log(`\n# SentinelRAG eval — ${golden.length} golden items\n`);
  console.log(await retrievalTable(golden));

  if (flags.retrievalOnly) {
    console.log("\n(retrieval-only: skipped strategy + judge eval)\n");
    return;
  }

  console.log("\n_running strategies via router (this makes live LLM calls)…_\n");
  const { results, judgeCost } = await runStrategies(golden, flags.noJudge);
  console.log("\n" + strategyTable(results));
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
