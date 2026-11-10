import { describe, expect, it } from "vitest";
import {
  dedupRanked,
  hitRateAtK,
  mean,
  mrr,
  ndcgAtK,
  reciprocalRank,
} from "../eval/metrics.js";

/**
 * Tiny hand-checkable fixture so the numbers are verifiable by eye.
 *
 * Retrieved ext_id ranking (raw, with a duplicate T1 to exercise dedup):
 *   ["T1", "T2", "T1", "T3", "T4"]   -->  dedup  -->  ["T1", "T2", "T3", "T4"]
 * Gold relevant set: {T3, T4}  (relevant items land at ranks 3 and 4)
 *
 * By hand, on the de-duplicated ranking:
 *   hit@2 = 0  (top-2 = T1,T2 — neither relevant)
 *   hit@3 = 1  (T3 at rank 3)
 *   hit@5 = 1
 *   RR    = 1/3                      (first relevant is T3 at rank 3)
 *   DCG@5 = 1/log2(3+1) + 1/log2(4+1) = 1/2 + 1/log2(5)
 *   IDCG  = 1/log2(1+1) + 1/log2(2+1) = 1   + 1/log2(3)      (2 ideal hits)
 *   nDCG@5 = DCG@5 / IDCG
 *   nDCG@3 = (1/log2(4)) / IDCG      (only T3 is within k=3)
 */
const RAW = ["T1", "T2", "T1", "T3", "T4"];
const RANKED = ["T1", "T2", "T3", "T4"];
const REL = new Set(["T3", "T4"]);

// log2-based expected values, written as formulas so they stay hand-traceable.
const DCG5 = 1 / Math.log2(4) + 1 / Math.log2(5);
const IDCG2 = 1 / Math.log2(2) + 1 / Math.log2(3);
const NDCG5 = DCG5 / IDCG2; // ≈ 0.5706
const NDCG3 = 1 / Math.log2(4) / IDCG2; // ≈ 0.3066

describe("dedupRanked", () => {
  it("keeps first occurrence, preserves order, drops blanks", () => {
    expect(dedupRanked(RAW)).toEqual(RANKED);
    expect(dedupRanked(["", "A", "", "A", "B"])).toEqual(["A", "B"]);
  });
});

describe("hit-rate@k", () => {
  it("is 0 until a relevant id enters the top-k, then 1", () => {
    expect(hitRateAtK(RANKED, REL, 2)).toBe(0);
    expect(hitRateAtK(RANKED, REL, 3)).toBe(1);
    expect(hitRateAtK(RANKED, REL, 5)).toBe(1);
  });
  it("is 0 when nothing relevant was retrieved", () => {
    expect(hitRateAtK(["T1", "T2"], new Set(["T9"]), 5)).toBe(0);
  });
});

describe("reciprocal rank + MRR", () => {
  it("RR = 1/(rank of first relevant)", () => {
    expect(reciprocalRank(RANKED, REL)).toBeCloseTo(1 / 3, 10);
    expect(reciprocalRank(["T3", "T4", "T1"], REL)).toBe(1); // perfect: first is relevant
    expect(reciprocalRank(["T1", "T2"], new Set(["T9"]))).toBe(0);
  });
  it("MRR averages RR over queries: mean(1/3, 1, 0) = 4/9", () => {
    const q = [
      { ranked: RANKED, relevant: REL }, // RR 1/3
      { ranked: ["T3", "T4", "T1"], relevant: REL }, // RR 1
      { ranked: ["T1", "T2"], relevant: new Set(["T9"]) }, // RR 0
    ];
    expect(mrr(q)).toBeCloseTo((1 / 3 + 1 + 0) / 3, 10); // = 4/9 ≈ 0.4444
  });
});

describe("nDCG@k", () => {
  it("matches the hand-computed DCG/IDCG", () => {
    expect(ndcgAtK(RANKED, REL, 5)).toBeCloseTo(NDCG5, 10);
    expect(ndcgAtK(RANKED, REL, 3)).toBeCloseTo(NDCG3, 10);
    expect(NDCG5).toBeCloseTo(0.5706, 3); // sanity: ≈ 0.5706
    expect(NDCG3).toBeCloseTo(0.3066, 3); // sanity: ≈ 0.3066
  });
  it("is 1.0 for an ideal ranking (all relevant on top)", () => {
    expect(ndcgAtK(["T3", "T4", "T1"], REL, 5)).toBeCloseTo(1, 10);
  });
  it("is 0 when nothing relevant is retrieved", () => {
    expect(ndcgAtK(["T1", "T2"], new Set(["T9"]), 5)).toBe(0);
  });
});

describe("mean", () => {
  it("averages, and is 0 for an empty list", () => {
    expect(mean([1, 2, 3])).toBeCloseTo(2);
    expect(mean([])).toBe(0);
  });
});
