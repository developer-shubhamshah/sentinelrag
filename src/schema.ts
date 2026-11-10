import { z } from "zod";

/** A citation ties a claim back to a specific chunk and its external ID. */
export const Citation = z.object({
  chunkId: z.number(),
  extId: z.string(),
});
export type Citation = z.infer<typeof Citation>;

/** The single structured answer shape every strategy returns. */
export const Answer = z.object({
  text: z.string(),
  citations: z.array(Citation),
  strategy: z.enum(["deterministic", "direct", "rag", "agentic"]),
  /** 0..1 supported-by-context score, or null for parametric (direct) answers. */
  groundedness: z.number().min(0).max(1).nullable(),
});
export type Answer = z.infer<typeof Answer>;

export type Strategy = Answer["strategy"];
