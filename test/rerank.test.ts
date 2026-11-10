import { describe, expect, it } from "vitest";
import { applyRerank, rerank, rerankEnabled } from "../src/retrieval/rerank.js";
import type { Retrieved } from "../src/retrieval/types.js";

const doc = (id: number, content: string): Retrieved => ({
  chunkId: id,
  content,
  score: 0,
  metadata: { ext_id: `E${id}` },
});

describe("applyRerank — pure reorder (no LLM)", () => {
  const docs = [doc(1, "alpha"), doc(2, "bravo"), doc(3, "charlie")];
  // Cohere returned: original index 2 most relevant, then 0, then 1.
  const results = [
    { index: 2, relevanceScore: 0.91 },
    { index: 0, relevanceScore: 0.4 },
    { index: 1, relevanceScore: 0.1 },
  ];

  it("reorders docs by Cohere's ranking and stamps the relevance scores", () => {
    const out = applyRerank(docs, results, 5);
    expect(out.map((d) => d.chunkId)).toEqual([3, 1, 2]);
    expect(out.map((d) => d.score)).toEqual([0.91, 0.4, 0.1]);
  });

  it("respects topN", () => {
    expect(applyRerank(docs, results, 2).map((d) => d.chunkId)).toEqual([3, 1]);
  });

  it("defensively skips out-of-range indices", () => {
    const out = applyRerank(docs, [
      { index: 5, relevanceScore: 0.9 }, // out of range → skipped
      { index: 1, relevanceScore: 0.3 },
    ], 5);
    expect(out.map((d) => d.chunkId)).toEqual([2]);
  });
});

describe("rerank — passthrough when disabled", () => {
  // Skips if a COHERE_API_KEY is configured, so the test never calls the live API.
  it.skipIf(rerankEnabled())("returns docs.slice(0, topN) unchanged when no key", async () => {
    const docs = [doc(1, "a"), doc(2, "b"), doc(3, "c")];
    const out = await rerank("q", docs, { topN: 2 });
    expect(out.map((d) => d.chunkId)).toEqual([1, 2]);
  });
});
