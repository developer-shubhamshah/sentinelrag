import { pool } from "../db.js";
import { DEFAULT_K, type Retrieved, type RetrieveOptions } from "./types.js";

/**
 * Sparse / keyword side of hybrid search. Native Postgres full-text search
 * (tsvector + ts_rank_cd) — NOT BM25, but a solid keyword ranker. No API key.
 */
export async function keywordSearch(
  query: string,
  opts: RetrieveOptions = {},
): Promise<Retrieved[]> {
  const k = opts.k ?? DEFAULT_K;
  const res = await pool.query<{ id: string; content: string; metadata: Record<string, unknown>; score: number }>(
    `SELECT c.id, c.content, c.metadata,
            ts_rank_cd(c.tsv, plainto_tsquery('english', $1)) AS score
       FROM chunks c
      WHERE c.tsv @@ plainto_tsquery('english', $1)
      ORDER BY score DESC
      LIMIT $2`,
    [query, k],
  );
  return res.rows.map((r) => ({
    chunkId: Number(r.id),
    content: r.content,
    score: Number(r.score),
    metadata: r.metadata,
  }));
}
