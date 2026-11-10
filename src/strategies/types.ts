import type { Answer } from "../schema.js";
import type { Trace } from "../obs/trace.js";

/** Every LLM-backed strategy shares this signature so the router can swap them. */
export type StrategyFn = (query: string, trace: Trace) => Promise<Answer>;
