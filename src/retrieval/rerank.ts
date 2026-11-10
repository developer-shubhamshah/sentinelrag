import { config } from "../config.js";
import type { Retrieved } from "./types.js";

/**
 * Optional reranking stage (stretch goal). There is no reranker in Postgres;
 * a real implementation would send (query, passages) to Cohere/Voyage rerank
 * and keep the top results. Kept as a flag-gated passthrough so the eval can
 * toggle "hybrid" vs "hybrid+rerank" once a provider is wired.
 */
export interface RerankOptions {
  topN?: number;
}

export function rerankEnabled(): boolean {
  return Boolean(config.COHERE_API_KEY);
}

export async function rerank(
  _query: string,
  docs: Retrieved[],
  opts: RerankOptions = {},
): Promise<Retrieved[]> {
  const topN = opts.topN ?? docs.length;
  if (!rerankEnabled()) {
    // Passthrough: no provider configured.
    return docs.slice(0, topN);
  }
  // TODO(stretch): call Cohere/Voyage rerank here and reorder by relevance.
  return docs.slice(0, topN);
}
