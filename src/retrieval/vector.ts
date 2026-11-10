import { pool, vectorToSql, dbReady } from "../db.js";
import { embedOne } from "../llm/embed.js";
import { DEFAULT_K, type Retrieved, type RetrieveOptions } from "./types.js";

/**
 * Dense / vector side of hybrid search. Embeds the query, then orders by cosine
 * distance (`<=>`, backed by the HNSW index). Score is cosine similarity
 * (1 - distance) so higher = more relevant, matching every other retriever.
 */
export async function vectorSearch(
  query: string,
  opts: RetrieveOptions = {},
): Promise<Retrieved[]> {
  const k = opts.k ?? DEFAULT_K;
  await dbReady;
  const qv = await embedOne(query);
  const res = await pool.query<{ id: string; content: string; metadata: Record<string, unknown>; dist: number }>(
    `SELECT c.id, c.content, c.metadata, (c.embedding <=> $1::vector) AS dist
       FROM chunks c
      WHERE c.embedding IS NOT NULL
      ORDER BY c.embedding <=> $1::vector
      LIMIT $2`,
    [vectorToSql(qv), k],
  );
  return res.rows.map((r) => ({
    chunkId: Number(r.id),
    content: r.content,
    score: 1 - Number(r.dist),
    metadata: r.metadata,
  }));
}
