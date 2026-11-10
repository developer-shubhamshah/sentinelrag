import { z } from "zod";
import { generateStructured, type Usage } from "../src/llm/claude.js";
import { config } from "../src/config.js";
import { keywordRecall } from "./metrics.js";

/**
 * LLM-as-a-judge. One cheap JUDGE_MODEL call (model ID from .env, never
 * hardcoded) scores an answer on two axes, each 0..1, returned as structured
 * JSON validated against the Zod `JudgeScore` schema:
 *   - faithfulness: is every claim supported by CONTEXT? (invented CVE/technique
 *     IDs or scores not in CONTEXT => low). For parametric (direct) answers with
 *     no CONTEXT, score whether the answer avoids fabricated specifics.
 *   - relevance: does the answer address the QUESTION?
 * Plus a cheap, non-LLM keyword-containment sanity check as a cross-reference.
 */
export const JudgeScore = z.object({
  faithfulness: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
});
export type JudgeScore = z.infer<typeof JudgeScore>;

const SYSTEM = `You are a strict evaluator of a security assistant's answers.
Return a JSON object with two numeric fields, each in [0,1]:
- faithfulness: 1.0 only if every factual claim is supported by the CONTEXT block.
  Invented CVE IDs, technique IDs, or CVSS scores not present in CONTEXT => low.
  If CONTEXT is "(none)" (a parametric answer), score faithfulness on whether the
  answer avoids fabricated specific identifiers/scores and stays general.
- relevance: does the answer address the QUESTION? 1.0 = fully on point, 0 = off-topic.
Judge support-by-context and on-topic-ness only; output nothing but the two scores.`;

export interface JudgeResult extends JudgeScore {
  /** Cheap non-LLM sanity net: fraction of expected keywords present (0..1). */
  keywordContainment: number;
  model: string;
  usage: Usage;
}

export async function judgeAnswer(
  query: string,
  answer: string,
  context: string,
  keywords: string[] = [],
): Promise<JudgeResult | null> {
  const user = `QUESTION:\n${query}\n\nCONTEXT:\n${context || "(none)"}\n\nANSWER:\n${answer}`;
  const res = await generateStructured(JudgeScore, {
    system: SYSTEM,
    user,
    model: config.JUDGE_MODEL, // from .env (JUDGE_MODEL), not a hardcoded string
    effort: "low",
  });
  if (!res.data) return null;
  return {
    faithfulness: res.data.faithfulness,
    relevance: res.data.relevance,
    keywordContainment: keywordRecall(answer, keywords),
    model: res.model,
    usage: res.usage,
  };
}
