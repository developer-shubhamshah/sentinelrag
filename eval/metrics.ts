/**
 * Retrieval metrics computed against a golden item's `relevant_ext_ids`.
 * All operate on a RANK-ORDERED, de-duplicated list of ext_ids (several chunks
 * can share one ext_id, so we keep each id at its best rank) and a Set of the
 * relevant ext_ids. Binary relevance.
 */

/** Keep the first occurrence of each ext_id, preserving rank order; drop blanks. */
export function dedupRanked(extIds: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of extIds) {
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** 1 if any of the top-k retrieved ids is relevant, else 0. */
export function hitRateAtK(ranked: string[], relevant: Set<string>, k: number): number {
  return ranked.slice(0, k).some((id) => relevant.has(id)) ? 1 : 0;
}

/** Reciprocal rank of the first relevant id (0 if none retrieved). */
export function reciprocalRank(ranked: string[], relevant: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (relevant.has(ranked[i]!)) return 1 / (i + 1);
  }
  return 0;
}

/** Normalized DCG at k with binary gains. */
export function ndcgAtK(ranked: string[], relevant: Set<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (relevant.has(ranked[i]!)) dcg += 1 / Math.log2(i + 2);
  }
  let idcg = 0;
  const ideal = Math.min(relevant.size, k);
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2);
  return idcg === 0 ? 0 : dcg / idcg;
}

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Fraction of expected keywords present (case-insensitive substring) in text. */
export function keywordRecall(text: string, keywords: string[]): number {
  if (keywords.length === 0) return 1;
  const hay = text.toLowerCase();
  const hit = keywords.filter((k) => hay.includes(k.toLowerCase())).length;
  return hit / keywords.length;
}
