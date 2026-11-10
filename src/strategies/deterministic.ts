import { pool } from "../db.js";
import type { Answer } from "../schema.js";

/**
 * Matches a CVE ID (CVE-2024-1234) or an ATT&CK technique ID (T1059, T1059.001).
 * The deterministic path exists to answer the "when NOT to use an LLM" case.
 */
export const ID_RE = /\b(CVE-\d{4}-\d{4,7}|T\d{4}(?:\.\d{3})?)\b/i;

export function extractId(query: string): string | null {
  const m = query.match(ID_RE);
  return m ? m[1]!.toUpperCase() : null;
}

/**
 * Exact-ID lookup straight from the DB. No LLM, no embeddings — fastest,
 * cheapest, 100% faithful. Returns null when there is no ID in the query or no
 * matching record, so the router can fall back to another strategy.
 */
export async function runDeterministic(query: string): Promise<Answer | null> {
  const id = extractId(query);
  if (!id) return null;

  const res = await pool.query<{ ext_id: string; title: string | null; chunk_id: string; content: string }>(
    `SELECT d.ext_id, d.title, c.id AS chunk_id, c.content
       FROM documents d
       JOIN chunks c ON c.document_id = d.id
      WHERE upper(d.ext_id) = upper($1)
      ORDER BY c.id`,
    [id],
  );
  if (res.rowCount === 0) return null;

  const text = res.rows.map((r) => r.content).join("\n\n");
  const citations = res.rows.map((r) => ({ chunkId: Number(r.chunk_id), extId: r.ext_id }));

  return {
    text,
    citations,
    strategy: "deterministic",
    groundedness: 1, // the answer IS the source record
  };
}
