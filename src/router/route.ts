import { ID_RE, runDeterministic } from "../strategies/deterministic.js";
import { runDirect } from "../strategies/directLlm.js";
import { runRag } from "../strategies/rag.js";
import { runAgentic } from "../strategies/agentic.js";
import type { Answer, Strategy } from "../schema.js";
import type { Trace } from "../obs/trace.js";

export interface RouteDecision {
  chosen: Strategy;
  reason: string;
}

/** Chaining / relationship language or stacked sub-questions → multi-hop. */
export function isMultiHop(q: string): boolean {
  const chaining = /\b(chain|chained|pivot|escalat\w*|lateral|related techniques?|relationship|combine[ds]?|leads? to|followed by)\b/i;
  if (chaining.test(q)) return true;
  // A conjunction joining a second interrogative ("..., and which CVEs...").
  if (/\b(and|then|as well as)\b[^?]*\b(which|what|how|list|find|map)\b/i.test(q)) return true;
  // Two or more distinct question words suggests more than one hop.
  const qWords = (q.match(/\b(which|what|how|why|where)\b/gi) ?? []).length;
  return qWords >= 2;
}

/** General definitional / conceptual question, not tied to a specific record. */
export function isConceptual(q: string): boolean {
  const definitional = /^\s*(what\s+is|what\s+are|what's|define|explain|describe|how\s+does\b[^?]*\bwork|difference\s+between|why\s+(is|are|do|does|would|should))/i;
  if (!definitional.test(q)) return false;
  // If it asks to enumerate corpus records, it's a retrieval job, not parametric.
  if (/\b(which|list|affect|affected|exploit|vulnerab|cve)\b/i.test(q)) return false;
  return true;
}

/**
 * Rules-first classifier (cheap, deterministic, logs its reason). An exact ID
 * that is NOT part of a multi-hop question takes the deterministic path; a
 * chained question goes agentic; a general concept goes direct; else RAG.
 * A small Claude fallback for ambiguous queries is a documented future add-on.
 */
export function classify(query: string): RouteDecision {
  const hasId = ID_RE.test(query);
  const multi = isMultiHop(query);

  if (hasId && !multi) {
    return { chosen: "deterministic", reason: "query is an exact CVE/technique ID lookup" };
  }
  if (multi) {
    return { chosen: "agentic", reason: "multi-hop / chained question needs tool-driven steps" };
  }
  if (isConceptual(query)) {
    return { chosen: "direct", reason: "general conceptual question, not corpus-specific" };
  }
  return { chosen: "rag", reason: "default: ground the answer in retrieved corpus context" };
}

/**
 * Route + execute. Returns the Answer and the decision (for logging). If an ID
 * query has no matching record, falls back to RAG rather than failing.
 */
export async function runRouted(
  query: string,
  trace: Trace,
): Promise<{ answer: Answer; decision: RouteDecision }> {
  let decision = classify(query);

  if (decision.chosen === "deterministic") {
    const det = await runDeterministic(query);
    if (det) return { answer: det, decision };
    decision = { chosen: "rag", reason: "ID not found in corpus; falling back to RAG" };
  }

  let answer: Answer;
  if (decision.chosen === "agentic") answer = await runAgentic(query, trace);
  else if (decision.chosen === "direct") answer = await runDirect(query, trace);
  else answer = await runRag(query, trace);

  return { answer, decision };
}
