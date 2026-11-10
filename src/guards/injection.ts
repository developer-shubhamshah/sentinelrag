import { extIdOf, type Retrieved } from "../retrieval/types.js";

/**
 * Prompt-injection screen for UNTRUSTED retrieved corpus text (OWASP 2025 A05 —
 * LLM injection). CVE/advisory text can carry instructions aimed at the model
 * ("ignore previous instructions", role headers, template markers). We screen
 * each retrieved chunk and EXCLUDE any that looks like instructions before it
 * reaches the prompt — the corpus is data, never commands.
 *
 * Patterns are deliberately tuned to avoid false positives on security prose:
 * they do NOT fire on benign text like "bypass user account control",
 * "disable security tools", "use the native API", or "obtain credentials".
 */
const INJECTION_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // "ignore/disregard the previous instructions"
  { name: "ignore-instructions", re: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|above|prior|earlier|all)\b[^.\n]{0,25}\b(instruction|prompt|context|rule|message)/i },
  // "override/bypass the instructions/guardrails/system prompt"
  { name: "override-instructions", re: /\b(override|bypass|disable)\b[^.\n]{0,30}\b(instruction|prompt|guardrail|safety|system prompt)\b/i },
  // a chat role header at the start of a line: "system:", "assistant:"
  { name: "role-header", re: /^[ \t>*-]{0,4}(system|assistant|developer|user)\s*:/im },
  // "you are now an AI…", "act as a system…"
  { name: "role-reassign", re: /\byou are (now|a)\b[^.\n]{0,40}\b(assistant|ai|model|dan|jailbreak)\b|\bact as\b[^.\n]{0,30}\b(assistant|system|dan)\b/i },
  // "new/updated instructions:"
  { name: "new-instructions", re: /\b(new|updated|revised|following)\b\s+instructions?\s*:/i },
  // exfiltration of the prompt itself
  { name: "exfil-prompt", re: /\b(print|reveal|repeat|output|show|disclose)\b[^.\n]{0,30}\b(system prompt|your (previous )?instructions|the instructions above)\b/i },
  // model chat-template / instruction markers
  { name: "template-marker", re: /(\[\s*INST\s*\]|<\|im_start\|>|<\|im_end\|>|<\|system\|>|###\s*instruction)/i },
];

export interface ScreenResult {
  /** Chunks that passed — safe to put in the prompt context. */
  safe: Retrieved[];
  /** Chunks excluded, with the rule that flagged them. */
  flagged: Array<{ chunkId: number; extId: string; rule: string }>;
}

/** First matching rule name for a piece of text, or null if it looks clean. */
export function detectInjection(text: string): string | null {
  for (const { name, re } of INJECTION_PATTERNS) {
    if (re.test(text)) return name;
  }
  return null;
}

/** Partition retrieved chunks into safe (keep) and flagged (exclude). */
export function screenChunks(chunks: Retrieved[]): ScreenResult {
  const safe: Retrieved[] = [];
  const flagged: ScreenResult["flagged"] = [];
  for (const c of chunks) {
    const rule = detectInjection(c.content);
    if (rule) flagged.push({ chunkId: c.chunkId, extId: extIdOf(c), rule });
    else safe.push(c);
  }
  return { safe, flagged };
}
