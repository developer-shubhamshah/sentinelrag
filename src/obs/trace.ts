import { performance } from "node:perf_hooks";
import type { Usage } from "../llm/claude.js";

/**
 * Per-request observability: latency, tokens, and cost. The cost table is the
 * "token/context budgeting" evidence — prices are per 1M tokens, verified
 * against the model list in .env / docs. Update here if prices move.
 */
export const LLM_PRICING: Record<string, { in: number; out: number }> = {
  "claude-opus-5-5": { in: 4, out: 20 },
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5-5": { in: 2, out: 10 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-5-5": { in: 0.1, out: 0.5 },
};

/** Embeddings priced on input tokens only (per 1M). */
export const EMBED_PRICING: Record<string, number> = {
  "text-embedding-3-small": 0.02,
  "text-embedding-3-large": 0.13,
  "voyage-3": 0.06,
};

/** Rough token estimate for cost-attributing a query embedding (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

interface LlmEntry extends Usage {
  model: string;
}

export class Trace {
  private readonly t0 = performance.now();
  readonly query: string;
  readonly llmCalls: LlmEntry[] = [];
  readonly embedCalls: Array<{ model: string; tokens: number }> = [];

  constructor(query: string) {
    this.query = query;
  }

  /** Record one Claude call's usage (generation or judge). */
  llm(call: { model: string; usage: Usage }): void {
    this.llmCalls.push({ model: call.model, ...call.usage });
  }

  /** Record an embedding call (e.g. a retrieval query embedding). */
  embed(model: string, tokens: number): void {
    this.embedCalls.push({ model, tokens });
  }

  latencyMs(): number {
    return Math.round(performance.now() - this.t0);
  }

  inputTokens(): number {
    return this.llmCalls.reduce((s, c) => s + c.inputTokens, 0);
  }

  outputTokens(): number {
    return this.llmCalls.reduce((s, c) => s + c.outputTokens, 0);
  }

  costUSD(): number {
    let cost = 0;
    for (const c of this.llmCalls) {
      const p = LLM_PRICING[c.model];
      if (p) {
        // Cache reads are billed at a fraction, but we bill them at full input
        // rate here as a conservative upper bound (keeps the number honest-high).
        cost += (c.inputTokens / 1e6) * p.in + (c.outputTokens / 1e6) * p.out;
      }
    }
    for (const e of this.embedCalls) {
      const p = EMBED_PRICING[e.model];
      if (p) cost += (e.tokens / 1e6) * p;
    }
    return cost;
  }

  /** Flat record for logging — the "when to use what" decision evidence. */
  summary(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      latencyMs: this.latencyMs(),
      inputTokens: this.inputTokens(),
      outputTokens: this.outputTokens(),
      llmCalls: this.llmCalls.length,
      costUSD: Number(this.costUSD().toFixed(6)),
      ...extra,
    };
  }
}
