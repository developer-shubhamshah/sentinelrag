import { pool } from "../db.js";
import { DEFAULT_K, type Retrieved, type RetrieveOptions } from "./types.js";

/**
 * Sparse / keyword side of hybrid search. Native Postgres full-text search
 * (tsvector + ts_rank_cd) — NOT BM25, but a solid keyword ranker. No API key.
 *
 * We OR the query lexemes instead of AND-ing them: `plainto_tsquery` joins every
 * lexeme with `&`, so a paraphrased question whose wording isn't all present in
 * the terse corpus matches nothing. Rewriting `&`→`|` ranks by how many query
 * terms a chunk covers (ts_rank_cd), which is what we want for recall. An empty
 * parse (all stopwords) yields an empty tsquery that simply matches nothing.
 */
export async function keywordSearch(
  query: string,
  opts: RetrieveOptions = {},
): Promise<Retrieved[]> {
  const k = opts.k ?? DEFAULT_K;
  const res = await pool.query<{ id: string; content: string; metadata: Record<string, unknown>; score: number }>(
    `WITH q AS (
       SELECT to_tsquery('english', replace(plainto_tsquery('english', $1)::text, '&', '|')) AS tsq
     )
     SELECT c.id, c.content, c.metadata, ts_rank_cd(c.tsv, q.tsq) AS score
       FROM chunks c, q
      WHERE q.tsq @@ c.tsv
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
