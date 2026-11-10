import { Pool, types } from "pg";
import { fromSql, toSql } from "pgvector";
import { config } from "./config.js";

/**
 * Shared pg pool. pgvector returns `vector` columns as a text literal; we parse
 * them back into number[] by registering a parser for the vector type's OID.
 *
 * Registering globally (once, by OID) avoids the per-connection race that the
 * `pool.on('connect', ...)` pattern causes — there the registration query and
 * the first real query run on the same fresh client concurrently.
 */
export const pool = new Pool({ connectionString: config.DATABASE_URL });

/**
 * Resolves once the vector type parser is installed. Writers don't need it
 * (they serialize via vectorToSql); readers of vector columns should await it.
 */
export const dbReady: Promise<void> = (async () => {
  const res = await pool.query<{ oid: string }>(
    "SELECT oid FROM pg_type WHERE typname = 'vector'",
  );
  const oid = res.rows[0]?.oid ? Number(res.rows[0].oid) : null;
  if (oid) {
    types.setTypeParser(oid, (value: string) => fromSql(value));
  }
})();

/** Serialize a JS number[] into the pgvector literal (e.g. '[1,2,3]'). */
export const vectorToSql = toSql;

export async function closePool(): Promise<void> {
  await pool.end();
}
