/**
 * Recursive character splitter with overlap. Token budget is approximated by
 * characters (~4 chars/token), which is plenty for chunk-sizing decisions —
 * the real token accounting happens at the embedding provider.
 *
 * Most corpus docs (a CVE description, one ATT&CK technique) fall under one
 * chunk; this only kicks in for the longer technique write-ups.
 */

export interface ChunkOptions {
  maxTokens?: number; // target chunk size
  overlapTokens?: number; // overlap carried between consecutive chunks
  charsPerToken?: number; // approximation factor
}

const DEFAULTS: Required<ChunkOptions> = {
  maxTokens: 600,
  overlapTokens: 80,
  charsPerToken: 4,
};

/** Split text into progressively finer segments, each ideally <= maxChars. */
function segment(text: string, maxChars: number): string[] {
  const separators = ["\n\n", "\n", ". ", " "];
  let units = [text];
  for (const sep of separators) {
    if (units.every((u) => u.length <= maxChars)) break;
    const next: string[] = [];
    for (const u of units) {
      if (u.length <= maxChars) {
        next.push(u);
      } else {
        // Re-attach the separator so sentences keep their period, etc.
        const parts = u.split(sep);
        parts.forEach((p, i) => {
          const piece = i < parts.length - 1 ? p + sep : p;
          if (piece) next.push(piece);
        });
      }
    }
    units = next;
  }
  // Hard-split anything still over budget (e.g. a giant token-free blob).
  const out: string[] = [];
  for (const u of units) {
    if (u.length <= maxChars) {
      out.push(u);
    } else {
      for (let i = 0; i < u.length; i += maxChars) out.push(u.slice(i, i + maxChars));
    }
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

/** The trailing `overlapChars` of a chunk, snapped to a word boundary. */
function overlapTail(chunk: string, overlapChars: number): string {
  if (overlapChars <= 0 || chunk.length <= overlapChars) return chunk;
  const tail = chunk.slice(chunk.length - overlapChars);
  const space = tail.indexOf(" ");
  return space === -1 ? tail : tail.slice(space + 1);
}

export function chunkText(text: string, opts: ChunkOptions = {}): string[] {
  const { maxTokens, overlapTokens, charsPerToken } = { ...DEFAULTS, ...opts };
  const maxChars = maxTokens * charsPerToken;
  const overlapChars = overlapTokens * charsPerToken;

  const clean = text.replace(/\r\n/g, "\n").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];

  const segments = segment(clean, maxChars);
  const chunks: string[] = [];
  let cur = "";

  for (const seg of segments) {
    const candidate = cur ? `${cur} ${seg}` : seg;
    if (candidate.length > maxChars && cur) {
      chunks.push(cur);
      const tail = overlapTail(cur, overlapChars);
      cur = tail ? `${tail} ${seg}` : seg;
    } else {
      cur = candidate;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}
