import { generate } from "../llm/claude.js";
import type { Answer } from "../schema.js";
import type { Trace } from "../obs/trace.js";

const SYSTEM = `You are a security-domain assistant answering a general, conceptual question from your own knowledge (no document retrieval).
Rules:
- Be accurate and concise.
- Do NOT invent specific CVE IDs, ATT&CK technique IDs, CVSS scores, or citations. If the question needs a specific record, say it should be looked up in the corpus instead.
- This is a parametric answer, so it carries no citations.`;

/**
 * Direct LLM: one Claude call, no retrieval. For definitional/conceptual
 * questions. groundedness is null — we're honest that this is parametric.
 */
export async function runDirect(query: string, trace: Trace): Promise<Answer> {
  const res = await generate({ system: SYSTEM, user: query, effort: "low" });
  trace.llm({ model: res.model, usage: res.usage });

  return {
    text: res.refused ? "The request was declined by the safety system." : res.text,
    citations: [],
    strategy: "direct",
    groundedness: null,
  };
}
