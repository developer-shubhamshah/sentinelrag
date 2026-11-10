import { setTimeout as sleep } from "node:timers/promises";
import { CohereClientV2 } from "cohere-ai";
import { config } from "../config.js";
import type { Retrieved } from "./types.js";

/**
 * Optional reranking stage. Sends (query, passages) to Cohere Rerank and reorders
 * the retrieved chunks by the cross-encoder relevance score (verified against the
 * cohere-ai v2 SDK: client.rerank → results[{ index, relevanceScore }]). Gated on
 * COHERE_API_KEY — without a key it is a passthrough so the eval still runs.
 * The model ID comes from .env (COHERE_RERANK_MODEL), never hardcoded.
 */
export interface RerankOptions {
  topN?: number;
}

let _client: CohereClientV2 | null = null;
function client(): CohereClientV2 {
  if (!_client) _client = new CohereClientV2({ token: config.COHERE_API_KEY! });
  return _client;
}

export function rerankEnabled(): boolean {
  return Boolean(config.COHERE_API_KEY);
}

/**
 * Pure reorder (LLM-free, unit-testable): map Cohere's ranked results — already
 * ordered most- to least-relevant, each carrying the `index` into the original
 * `docs` — back to the retrieved chunks, stamping the relevance score. Keeps topN.
 */
export function applyRerank(
  docs: Retrieved[],
  results: Array<{ index: number; relevanceScore: number }>,
  topN: number,
): Retrieved[] {
  return results
    .slice(0, topN)
    .filter((r) => docs[r.index] !== undefined)
    .map((r) => ({ ...docs[r.index]!, score: r.relevanceScore }));
}

function isRateLimit(e: unknown): boolean {
  const err = e as { statusCode?: number; name?: string } | undefined;
  return err?.statusCode === 429 || /toomanyrequests|rate.?limit/i.test(err?.name ?? "");
}

export async function rerank(
  query: string,
  docs: Retrieved[],
  opts: RerankOptions = {},
): Promise<Retrieved[]> {
  const topN = opts.topN ?? docs.length;
  if (!rerankEnabled() || docs.length === 0) {
    return docs.slice(0, topN); // passthrough: no provider configured
  }
  const request = {
    model: config.COHERE_RERANK_MODEL,
    query,
    documents: docs.map((d) => d.content),
    topN,
  };
  // Bounded retry with exponential backoff on 429 (trial keys are rate-limited).
  let lastErr: unknown;
  for (let attempt = 0; attempt <= 5; attempt++) {
    try {
      const res = await client().rerank(request);
      return applyRerank(docs, res.results, topN);
    } catch (e) {
      lastErr = e;
      if (!isRateLimit(e) || attempt === 5) throw e;
      await sleep(Math.min(1500 * 2 ** attempt, 20000));
    }
  }
  throw lastErr;
}
