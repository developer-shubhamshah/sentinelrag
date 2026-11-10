import { pool, vectorToSql, closePool } from "../db.js";
import { config } from "../config.js";
import { embed } from "../llm/embed.js";
import { chunkText } from "./chunk.js";
import { loadCve } from "./loadCve.js";
import { loadAttack } from "./loadAttack.js";
import type { RawDoc } from "./types.js";
import type { PoolClient } from "pg";

interface Args {
  source: "cve" | "attack" | "all";
  limit: number; // max CVEs
  maxTechniques: number;
  dryRun: boolean;
  noEmbed: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    source: "all",
    limit: 1200,
    maxTechniques: Infinity,
    dryRun: false,
    noEmbed: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") args.source = argv[++i] as Args["source"];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--max-techniques") args.maxTechniques = Number(argv[++i]);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--no-embed") args.noEmbed = true;
  }
  return args;
}

interface PendingChunk {
  docIndex: number;
  content: string;
  metadata: Record<string, unknown>;
}

function buildChunks(docs: RawDoc[]): PendingChunk[] {
  const chunks: PendingChunk[] = [];
  docs.forEach((doc, docIndex) => {
    const pieces = chunkText(doc.text);
    pieces.forEach((content, chunk_index) => {
      chunks.push({
        docIndex,
        content,
        metadata: {
          source: doc.source,
          ext_id: doc.extId,
          title: doc.title,
          chunk_index,
          ...doc.metadata,
        },
      });
    });
  });
  return chunks;
}

async function upsertDocument(client: PoolClient, doc: RawDoc): Promise<number> {
  const res = await client.query<{ id: string }>(
    `INSERT INTO documents (source, ext_id, title, metadata)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (source, ext_id)
     DO UPDATE SET title = EXCLUDED.title, metadata = EXCLUDED.metadata
     RETURNING id`,
    [doc.source, doc.extId, doc.title, JSON.stringify(doc.metadata)],
  );
  return Number(res.rows[0]!.id);
}

async function insertChunkRows(
  client: PoolClient,
  rows: Array<{ documentId: number; content: string; embedding: number[] | null; metadata: Record<string, unknown> }>,
): Promise<void> {
  if (rows.length === 0) return;
  const values: string[] = [];
  const params: unknown[] = [];
  rows.forEach((r, i) => {
    const b = i * 4;
    values.push(`($${b + 1}, $${b + 2}, $${b + 3}::vector, $${b + 4}::jsonb)`);
    params.push(
      r.documentId,
      r.content,
      r.embedding ? vectorToSql(r.embedding) : null,
      JSON.stringify(r.metadata),
    );
  });
  await client.query(
    `INSERT INTO chunks (document_id, content, embedding, metadata) VALUES ${values.join(", ")}`,
    params,
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `ingest: source=${args.source} limit=${args.limit} dryRun=${args.dryRun} noEmbed=${args.noEmbed}`,
  );

  // 1. Load source documents.
  const docs: RawDoc[] = [];
  if (args.source === "cve" || args.source === "all") {
    docs.push(...(await loadCve({ year: config.CVE_YEAR, maxCves: args.limit, apiKey: config.NVD_API_KEY })));
  }
  if (args.source === "attack" || args.source === "all") {
    docs.push(...(await loadAttack({ maxTechniques: args.maxTechniques })));
  }
  console.log(`loaded ${docs.length} documents`);

  // 2. Chunk.
  const pending = buildChunks(docs);
  console.log(`produced ${pending.length} chunks (avg ${(pending.length / Math.max(docs.length, 1)).toFixed(2)}/doc)`);

  if (args.dryRun) {
    const sample = pending.slice(0, 3).map((c) => ({ ext_id: c.metadata.ext_id, chars: c.content.length, preview: c.content.slice(0, 120) }));
    console.log("dry run — no DB writes. sample chunks:");
    console.dir(sample, { depth: null });
    return;
  }

  // 3. Embed (unless suppressed).
  let embeddings: Array<number[] | null>;
  if (args.noEmbed) {
    console.log("--no-embed: inserting chunks with NULL embeddings");
    embeddings = pending.map(() => null);
  } else {
    console.log(`embedding ${pending.length} chunks via ${config.EMBED_PROVIDER}/${config.EMBED_MODEL} ...`);
    const vectors = await embed(pending.map((c) => c.content));
    embeddings = vectors;
    console.log("embedding complete");
  }

  // 4. Insert in one transaction, idempotent per document.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const docIdByIndex = new Map<number, number>();
    for (let i = 0; i < docs.length; i++) {
      const id = await upsertDocument(client, docs[i]!);
      docIdByIndex.set(i, id);
      await client.query("DELETE FROM chunks WHERE document_id = $1", [id]); // clean re-ingest
    }
    const rows = pending.map((c, i) => ({
      documentId: docIdByIndex.get(c.docIndex)!,
      content: c.content,
      embedding: embeddings[i] ?? null,
      metadata: c.metadata,
    }));
    // Insert in batches to keep parameter counts sane (4 params/row).
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      await insertChunkRows(client, rows.slice(i, i + BATCH));
    }
    await client.query("COMMIT");
    console.log(`inserted ${docs.length} documents, ${rows.length} chunks`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => closePool())
  .catch(async (err) => {
    console.error("ingest failed:", err);
    await closePool();
    process.exit(1);
  });
