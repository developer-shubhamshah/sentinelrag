import { readFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { classify } from "../src/router/route.js";
import { closePool } from "../src/db.js";
import {
  dedupRanked,
  hitRateAtK,
  keywordRecall,
  mean,
  ndcgAtK,
  reciprocalRank,
} from "../eval/metrics.js";

/**
 * Regression gate (CI): fails the build if quality drops below a floor. Kept to
 * checks that need NO generation/embeddings/LLM — only the DB pool import (the
 * router chain opens it) and pure functions:
 *   - router accuracy over the golden set (route() vs expected_strategy)
 *   - retrieval-metric math correctness
 * The LLM-judged answer scores (faithfulness/relevance) stay in `npm run eval`.
 */

interface Golden {
  q: string;
  expected_strategy: string;
}

const golden: Golden[] = readFileSync("data/golden.jsonl", "utf8")
  .split("\n")
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Golden);

// The router chain imports src/db.ts, which opens a pool on import; close it.
afterAll(async () => {
  await closePool();
});

describe("router regression (no LLM, no embeddings)", () => {
  it("has a non-empty golden set", () => {
    expect(golden.length).toBeGreaterThanOrEqual(20);
  });

  it("router accuracy over the golden set stays >= 0.9", () => {
    const misroutes = golden
      .map((g) => ({ q: g.q, got: classify(g.q).chosen, want: g.expected_strategy }))
      .filter((r) => r.got !== r.want);
    const acc = (golden.length - misroutes.length) / golden.length;
    // Surface any misroutes in the failure message.
    expect({ accuracy: acc, misroutes }).toEqual({ accuracy: expect.any(Number), misroutes: [] });
    expect(acc).toBeGreaterThanOrEqual(0.9);
  });
});

describe("retrieval-metric math regression", () => {
  it("dedups ranked ext_ids preserving best rank", () => {
    expect(dedupRanked(["T1", "T1", "T2", "", "T3"])).toEqual(["T1", "T2", "T3"]);
  });

  it("computes hit-rate@k, MRR, nDCG@k on a known ranking", () => {
    const ranked = ["T1", "T2", "T3"]; // relevant T2 at rank 2
    const rel = new Set(["T2"]);
    expect(hitRateAtK(ranked, rel, 5)).toBe(1);
    expect(hitRateAtK(ranked, rel, 1)).toBe(0);
    expect(reciprocalRank(ranked, rel)).toBeCloseTo(1 / 2);
    expect(ndcgAtK(ranked, rel, 5)).toBeCloseTo(1 / Math.log2(3));
    expect(ndcgAtK(["T2"], rel, 5)).toBeCloseTo(1); // perfect ranking
  });

  it("keyword recall and mean are correct", () => {
    expect(keywordRecall("foo T1059 bar Visual Basic", ["t1059", "visual basic"])).toBeCloseTo(1);
    expect(keywordRecall("foo bar", ["t1059", "missing"])).toBeCloseTo(0);
    expect(keywordRecall("has one", ["one", "two"])).toBeCloseTo(0.5);
    expect(mean([1, 0, 1])).toBeCloseTo(2 / 3);
    expect(mean([])).toBe(0);
  });
});
