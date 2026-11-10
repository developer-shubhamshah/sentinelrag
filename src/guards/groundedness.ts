import { z } from "zod";
import { generateStructured, type Usage } from "../llm/claude.js";
import { config } from "../config.js";
import type { Answer } from "../schema.js";

/**
 * Groundedness guard (the "hallucinations" control). A cheap JUDGE_MODEL call
 * scores how well the answer is SUPPORTED BY the retrieved context, 0..1. The
 * RAG path uses it to return "insufficient evidence" below a threshold instead
 * of a confident but unsupported answer.
 */
export const GroundednessScore = z.object({
  groundedness: z.number().min(0).max(1),
});

export interface GroundednessResult {
  score: number;
  model: string;
  usage: Usage;
}

const SYSTEM = `You are a strict groundedness judge for a security assistant.
Given a QUESTION, the retrieved CONTEXT, and an ANSWER, output a single number
in [0,1] for how well the answer is SUPPORTED BY THE CONTEXT:
- 1.0 = every factual claim in the answer is directly supported by the context.
- 0.0 = the answer asserts things absent from, or contradicted by, the context.
Penalize invented CVE IDs, ATT&CK technique IDs, or CVSS scores not in context.
Judge ONLY support-by-context, not whether the answer merely sounds correct.`;

export async function scoreGroundedness(
  query: string,
  answer: string,
  context: string,
): Promise<GroundednessResult | null> {
  const user = `QUESTION:\n${query}\n\nCONTEXT:\n${context}\n\nANSWER:\n${answer}`;
  const res = await generateStructured(GroundednessScore, {
    system: SYSTEM,
    user,
    model: config.JUDGE_MODEL,
    effort: "low",
  });
  if (!res.data) return null;
  return { score: res.data.groundedness, model: res.model, usage: res.usage };
}

/** The response used when the guard overrides a low-groundedness answer. */
export const INSUFFICIENT_EVIDENCE =
  "Insufficient evidence in the retrieved context to answer this confidently.";

/**
 * Apply the groundedness threshold (pure, LLM-free so it is unit-testable).
 * Stamps the answer with the judged `score`; if that score is below `threshold`,
 * OVERRIDES the answer text with an insufficient-evidence response regardless of
 * what the generator produced (citations retained). A null score (judge
 * unavailable) leaves the text unchanged with groundedness null.
 */
export function guardAnswer(answer: Answer, score: number | null, threshold: number): Answer {
  const text = score !== null && score < threshold ? INSUFFICIENT_EVIDENCE : answer.text;
  return { ...answer, text, groundedness: score };
}
