/**
 * Every retriever returns the SAME shape so strategies can swap them freely —
 * that interchangeability is the whole point of the demo.
 */
export interface Retrieved {
  chunkId: number;
  content: string;
  score: number; // higher = more relevant (similarity or fused rank score)
  metadata: Record<string, unknown>; // includes source, ext_id, title, chunk_index, ...
}

export interface RetrieveOptions {
  k?: number;
}

export type Retriever = (query: string, opts?: RetrieveOptions) => Promise<Retrieved[]>;

export const DEFAULT_K = 5;

/** Convenience: pull ext_id out of a retrieved chunk's metadata. */
export function extIdOf(r: Retrieved): string {
  const id = r.metadata?.["ext_id"];
  return typeof id === "string" ? id : "";
}
