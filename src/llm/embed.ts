import OpenAI from "openai";
import { config, EMBED_DIM, requireEmbeddingKey } from "../config.js";

/**
 * Provider-agnostic embeddings. The signature never changes across providers,
 * so retrieval/ingest code doesn't care who produces the vectors.
 *
 *   embed(texts) -> number[][]   (one vector per input, same order, length EMBED_DIM)
 *
 * Active provider + model come from env (EMBED_PROVIDER / EMBED_MODEL).
 */

// OpenAI caps batch size and total tokens per request; stay well under both.
const BATCH_SIZE = 96;

let _openai: OpenAI | null = null;
function openaiClient(): OpenAI {
  if (!_openai) _openai = new OpenAI({ apiKey: requireEmbeddingKey() });
  return _openai;
}

async function embedOpenAI(texts: string[]): Promise<number[][]> {
  const client = openaiClient();
  const res = await client.embeddings.create({
    model: config.EMBED_MODEL,
    input: texts,
    encoding_format: "float",
  });
  // Response order isn't guaranteed; sort by the returned index.
  return res.data
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding as number[]);
}

async function embedVoyage(_texts: string[]): Promise<number[][]> {
  // Deliberately unimplemented: OpenAI is the chosen provider. Wire this with
  // the `voyageai` SDK (client.embed({ input, model })) and keep the same shape.
  throw new Error(
    "EMBED_PROVIDER=voyage is not wired yet. Use EMBED_PROVIDER=openai or implement embedVoyage().",
  );
}

/** Embed a batch of texts into vectors of length EMBED_DIM. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);
    const vectors =
      config.EMBED_PROVIDER === "openai"
        ? await embedOpenAI(batch)
        : await embedVoyage(batch);

    if (vectors.length !== batch.length) {
      throw new Error(
        `Embedding count mismatch: sent ${batch.length}, got ${vectors.length}.`,
      );
    }
    for (const v of vectors) {
      if (v.length !== EMBED_DIM) {
        throw new Error(
          `Embedding dimension mismatch: expected ${EMBED_DIM} (model ${config.EMBED_MODEL}), got ${v.length}.`,
        );
      }
    }
    out.push(...vectors);
  }
  return out;
}

/** Convenience for the single-query retrieval path. */
export async function embedOne(text: string): Promise<number[]> {
  const [v] = await embed([text]);
  if (!v) throw new Error("embed() returned no vector for a single input.");
  return v;
}
