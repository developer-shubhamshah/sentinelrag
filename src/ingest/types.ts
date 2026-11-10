/** A source document before chunking. One per CVE or ATT&CK technique. */
export interface RawDoc {
  source: "nvd" | "attack";
  extId: string; // 'CVE-2024-1234' | 'T1059' | 'T1059.001'
  title: string;
  /** Full text to be chunked + embedded. */
  text: string;
  /** Attached to the document row and inherited by its chunks. */
  metadata: Record<string, unknown>;
}

/** A fetch with bounded retries and a minimum spacing between calls. */
export async function fetchJson(
  url: string,
  opts: { headers?: Record<string, string>; retries?: number } = {},
): Promise<unknown> {
  const { headers = {}, retries = 4 } = opts;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "SentinelRAG-ingest/0.1", ...headers },
      });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      if (!res.ok) {
        throw Object.assign(new Error(`HTTP ${res.status} ${res.statusText}`), {
          fatal: true,
        });
      }
      return await res.json();
    } catch (err) {
      lastErr = err;
      if ((err as { fatal?: boolean }).fatal) throw err;
      const backoff = Math.min(2000 * 2 ** attempt, 20000);
      if (attempt < retries) await sleep(backoff);
    }
  }
  throw lastErr;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
