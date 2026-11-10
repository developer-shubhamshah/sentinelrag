import { fetchJson, sleep, type RawDoc } from "./types.js";

/**
 * NVD CVE API 2.0 (verified live):
 *   base: https://services.nvd.nist.gov/rest/json/cves/2.0
 *   params: pubStartDate / pubEndDate (ISO-8601, <=120-day window),
 *           resultsPerPage (<=2000), startIndex (pagination)
 *   rate limit: 5 req / 30s (no key) or 50 / 30s (apiKey header)
 *
 * We pull a bounded slice — the first `maxCves` CVEs published in a 120-day
 * window of CVE_YEAR — to keep the corpus to a few thousand chunks.
 */

const BASE = "https://services.nvd.nist.gov/rest/json/cves/2.0";
const PAGE = 2000;

interface CveItem {
  cve: {
    id: string;
    published?: string;
    lastModified?: string;
    vulnStatus?: string;
    descriptions?: Array<{ lang: string; value: string }>;
    metrics?: {
      cvssMetricV31?: Array<{ cvssData?: { baseScore?: number; baseSeverity?: string; vectorString?: string } }>;
      cvssMetricV30?: Array<{ cvssData?: { baseScore?: number; baseSeverity?: string; vectorString?: string } }>;
      cvssMetricV2?: Array<{ baseSeverity?: string; cvssData?: { baseScore?: number } }>;
    };
    weaknesses?: Array<{ description?: Array<{ lang: string; value: string }> }>;
    configurations?: Array<{ nodes?: Array<{ cpeMatch?: Array<{ criteria?: string }> }> }>;
  };
}

interface CveResponse {
  totalResults: number;
  vulnerabilities?: CveItem[];
}

function englishDescription(item: CveItem): string {
  const d = item.cve.descriptions?.find((x) => x.lang === "en");
  return d?.value ?? "";
}

function severity(item: CveItem): { baseSeverity: string | null; baseScore: number | null; vector: string | null } {
  const m = item.cve.metrics;
  const v3 = m?.cvssMetricV31?.[0]?.cvssData ?? m?.cvssMetricV30?.[0]?.cvssData;
  if (v3?.baseSeverity) {
    return { baseSeverity: v3.baseSeverity, baseScore: v3.baseScore ?? null, vector: v3.vectorString ?? null };
  }
  const v2 = m?.cvssMetricV2?.[0];
  if (v2) return { baseSeverity: v2.baseSeverity ?? null, baseScore: v2.cvssData?.baseScore ?? null, vector: null };
  return { baseSeverity: null, baseScore: null, vector: null };
}

function cwes(item: CveItem): string[] {
  const out = new Set<string>();
  for (const w of item.cve.weaknesses ?? []) {
    for (const d of w.description ?? []) {
      if (d.lang === "en" && /^CWE-\d+$/.test(d.value)) out.add(d.value);
    }
  }
  return [...out];
}

function products(item: CveItem): string[] {
  const out = new Set<string>();
  for (const cfg of item.cve.configurations ?? []) {
    for (const node of cfg.nodes ?? []) {
      for (const match of node.cpeMatch ?? []) {
        const parts = match.criteria?.split(":"); // cpe:2.3:a:vendor:product:version:...
        if (parts && parts.length > 4 && parts[3] && parts[4]) {
          out.add(`${parts[3]} ${parts[4]}`.replace(/_/g, " "));
        }
      }
    }
    if (out.size >= 10) break;
  }
  return [...out].slice(0, 10);
}

function toRawDoc(item: CveItem): RawDoc | null {
  const desc = englishDescription(item);
  if (!desc) return null; // rejected/placeholder entries have no usable text
  const sev = severity(item);
  const cwe = cwes(item);
  const prod = products(item);

  const lines = [
    `${item.cve.id}: ${desc}`,
    sev.baseSeverity ? `Severity: ${sev.baseSeverity}${sev.baseScore != null ? ` (CVSS ${sev.baseScore})` : ""}.` : "",
    cwe.length ? `Weaknesses: ${cwe.join(", ")}.` : "",
    prod.length ? `Affected products: ${prod.join("; ")}.` : "",
  ].filter(Boolean);

  return {
    source: "nvd",
    extId: item.cve.id,
    title: item.cve.id,
    text: lines.join("\n"),
    metadata: {
      severity: sev.baseSeverity,
      baseScore: sev.baseScore,
      cvssVector: sev.vector,
      published: item.cve.published ?? null,
      cwe,
      products: prod,
      vulnStatus: item.cve.vulnStatus ?? null,
    },
  };
}

export interface LoadCveOptions {
  year: number;
  maxCves: number;
  apiKey?: string | undefined;
}

export async function loadCve(opts: LoadCveOptions): Promise<RawDoc[]> {
  const { year, maxCves, apiKey } = opts;
  // NVD caps the window at 120 days; 110 days stays safely under it in leap
  // years too, and still exposes thousands of CVEs — plenty for our bounded cap.
  const pubStartDate = `${year}-01-01T00:00:00.000`;
  const pubEndDate = `${year}-04-20T00:00:00.000`;
  const spacingMs = apiKey ? 700 : 6500; // honor 50/30s vs 5/30s limits
  const headers: Record<string, string> = apiKey ? { apiKey } : {};

  const docs: RawDoc[] = [];
  let startIndex = 0;
  let total = Infinity;

  while (docs.length < maxCves && startIndex < total) {
    const url =
      `${BASE}?pubStartDate=${encodeURIComponent(pubStartDate)}` +
      `&pubEndDate=${encodeURIComponent(pubEndDate)}` +
      `&resultsPerPage=${PAGE}&startIndex=${startIndex}`;
    const res = (await fetchJson(url, { headers })) as CveResponse;
    total = res.totalResults ?? 0;
    const items = res.vulnerabilities ?? [];
    if (items.length === 0) break;

    for (const item of items) {
      const doc = toRawDoc(item);
      if (doc) docs.push(doc);
      if (docs.length >= maxCves) break;
    }
    process.stdout.write(`  [cve] fetched ${Math.min(startIndex + items.length, total)}/${total}, kept ${docs.length}\r`);
    startIndex += items.length;
    if (docs.length < maxCves && startIndex < total) await sleep(spacingMs);
  }
  process.stdout.write("\n");
  return docs;
}
