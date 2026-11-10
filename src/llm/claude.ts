import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { z } from "zod";
import { config, requireAnthropicKey } from "../config.js";

/**
 * Claude is used ONLY for generation and LLM-as-a-judge here — never embeddings.
 * Model IDs come from .env (GEN_MODEL / JUDGE_MODEL / ROUTER_MODEL).
 */

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

let _client: Anthropic | null = null;
export function claude(): Anthropic {
  if (!_client) _client = new Anthropic({ apiKey: requireAnthropicKey() });
  return _client;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export function toUsage(u: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number | null }): Usage {
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
  };
}

export interface GenResult {
  text: string;
  usage: Usage;
  stopReason: string | null;
  model: string;
  refused: boolean;
}

export interface GenOptions {
  system?: string;
  user: string;
  model?: string;
  maxTokens?: number;
  effort?: Effort;
}

/** Plain text generation. */
export async function generate(opts: GenOptions): Promise<GenResult> {
  const model = opts.model ?? config.GEN_MODEL;
  const res = await claude().messages.create({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    ...(opts.system ? { system: opts.system } : {}),
    ...(opts.effort ? { output_config: { effort: opts.effort } } : {}),
    messages: [{ role: "user", content: opts.user }],
  });

  const text = res.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");

  return {
    text,
    usage: toUsage(res.usage),
    stopReason: res.stop_reason,
    model: res.model,
    refused: res.stop_reason === "refusal",
  };
}

export interface StructResult<T> {
  data: T | null;
  usage: Usage;
  stopReason: string | null;
  model: string;
  refused: boolean;
}

/** Structured generation validated against a Zod schema via the SDK parser. */
export async function generateStructured<S extends z.ZodType>(
  schema: S,
  opts: GenOptions,
): Promise<StructResult<z.infer<S>>> {
  const model = opts.model ?? config.GEN_MODEL;
  const res = await claude().messages.parse({
    model,
    max_tokens: opts.maxTokens ?? 4096,
    ...(opts.system ? { system: opts.system } : {}),
    output_config: {
      format: zodOutputFormat(schema),
      ...(opts.effort ? { effort: opts.effort } : {}),
    },
    messages: [{ role: "user", content: opts.user }],
  });

  return {
    data: (res.parsed_output as z.infer<S> | null) ?? null,
    usage: toUsage(res.usage),
    stopReason: res.stop_reason,
    model: res.model,
    refused: res.stop_reason === "refusal",
  };
}
