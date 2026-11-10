import { vectorSearch } from "./vector.js";
import { keywordSearch } from "./keyword.js";
import { DEFAULT_K, type Retrieved, type RetrieveOptions } from "./types.js";

/**
 * Hybrid retrieval via Reciprocal Rank Fusion (RRF). Run dense + sparse, then
 * fuse by rank: score(d) = Σ 1/(RRF_K + rank_i(d)). Simple, strong, no tuning.
 * Call it "keyword + vector hybrid," not BM25.
 */
const RRF_K = 60;

export async function hybridSearch(
  query: string,
  opts: RetrieveOptions = {},
): Promise<Retrieved[]> {
  const k = opts.k ?? DEFAULT_K;
  // Pull a deeper pool from each retriever before fusing down to k.
  const poolN = Math.max(k * 4, 20);
  const [dense, sparse] = await Promise.all([
    vectorSearch(query, { k: poolN }),
    keywordSearch(query, { k: poolN }),
  ]);

  const fused = new Map<number, { score: number; item: Retrieved }>();
  for (const list of [dense, sparse]) {
    list.forEach((item, idx) => {
      const rank = idx + 1;
      const contribution = 1 / (RRF_K + rank);
      const existing = fused.get(item.chunkId);
      if (existing) existing.score += contribution;
      else fused.set(item.chunkId, { score: contribution, item });
    });
  }

  return [...fused.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((entry) => ({ ...entry.item, score: entry.score }));
}
