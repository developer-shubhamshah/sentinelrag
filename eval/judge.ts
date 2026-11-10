import { z } from "zod";
import { generateStructured, type Usage } from "../src/llm/claude.js";
import { config } from "../src/config.js";

/**
 * LLM-as-a-judge. A cheap JUDGE_MODEL (haiku) call scores an answer on two axes,
 * each 0..1:
 *   - faithfulness: is every claim supported by CONTEXT? (invented CVE/technique
 *     IDs or scores not in CONTEXT => low). For parametric (direct) answers with
 *     no CONTEXT, it scores whether the answer avoids fabricated specifics.
 *   - relevance: does the answer actually address the QUESTION?
 */
export const JudgeScore = z.object({
  faithfulness: z.number().min(0).max(1),
  relevance: z.number().min(0).max(1),
});
export type JudgeScore = z.infer<typeof JudgeScore>;

const SYSTEM = `You are a strict evaluator of a security assistant's answers.
Score two axes, each a number in [0,1]:
- faithfulness: 1.0 only if every factual claim is supported by the CONTEXT block.
  Invented CVE IDs, technique IDs, or CVSS scores not present in CONTEXT => low.
  If CONTEXT is "(none)" (a parametric answer), score faithfulness on whether the
  answer avoids fabricated specific identifiers/scores and stays general.
- relevance: does the answer address the QUESTION? 1.0 = fully on point, 0 = off-topic.
Return ONLY the two numbers.`;

export interface JudgeResult extends JudgeScore {
  model: string;
  usage: Usage;
}

export async function judgeAnswer(
  query: string,
  answer: string,
  context: string,
): Promise<JudgeResult | null> {
  const user = `QUESTION:\n${query}\n\nCONTEXT:\n${context || "(none)"}\n\nANSWER:\n${answer}`;
  const res = await generateStructured(JudgeScore, {
    system: SYSTEM,
    user,
    model: config.JUDGE_MODEL,
    effort: "low",
  });
  if (!res.data) return null;
  return { ...res.data, model: res.model, usage: res.usage };
}
