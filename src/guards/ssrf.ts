import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * SSRF guard (OWASP 2025 A01 — SSRF/CWE-918 folded into Broken Access Control).
 *
 * Used by the ingestion fetcher and by any agentic tool that fetches a URL.
 * Defence is layered:
 *   1. scheme allowlist  (http/https only — blocks file:, ftp:, gopher:, data:, …)
 *   2. host allowlist    (only the corpora we actually ingest)
 *   3. address screen     (resolve the host and reject any private/loopback/
 *                          link-local/metadata/reserved IP — also catches a
 *                          hostname that resolves to an internal address)
 *   4. redirect refusal   (see safeFetch)
 *
 * Note on step 3: global fetch (undici) re-resolves DNS when it connects, so a
 * determined DNS-rebind could still differ from what we validated here. The host
 * allowlist (step 2) is the primary control; the address screen is defence in
 * depth and the gate for any future tool that fetches a non-allowlisted host.
 */

export class SsrfError extends Error {
  /** The ingestion retry loop treats `fatal` errors as non-retryable. */
  readonly fatal = true;
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/** Hosts the ingestion layer is allowed to reach. Callers may override. */
export const DEFAULT_ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "services.nvd.nist.gov", // NVD CVE API 2.0
  "raw.githubusercontent.com", // MITRE ATT&CK STIX bundle
]);

function ipv4Octets(ip: string): [number, number, number, number] | null {
  const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return null;
  const octets: [number, number, number, number] = [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
  ];
  for (const o of octets) if (o > 255) return null;
  return octets;
}

/**
 * True if `ip` is a literal address that must never be reached from the server:
 * private, loopback, link-local (incl. the cloud-metadata IP 169.254.169.254),
 * CGNAT, unspecified, multicast, or otherwise reserved. Pure + synchronous so it
 * is trivially unit-testable.
 */
export function isBlockedIp(ip: string): boolean {
  const host = ip.trim().toLowerCase();

  // IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) — screen the embedded IPv4.
  const mapped = host.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped && mapped[1]) return isBlockedIp(mapped[1]);

  const v4 = ipv4Octets(host);
  if (v4) {
    const [a, b] = v4;
    if (a === 0) return true; // 0.0.0.0/8  "this host"
    if (a === 10) return true; // 10.0.0.0/8  private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. 169.254.169.254 metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
    return false;
  }

  // IPv6. String-prefix checks assume a normalized address; the host allowlist
  // is the primary gate, so this covers the common internal ranges.
  if (host === "::1") return true; // loopback
  if (host === "::") return true; // unspecified
  if (/^fe[89ab]/.test(host)) return true; // fe80::/10 link-local
  if (/^f[cd]/.test(host)) return true; // fc00::/7 unique-local
  if (host.startsWith("ff")) return true; // ff00::/8 multicast
  return false;
}

export interface SsrfOptions {
  /** Overrides DEFAULT_ALLOWED_HOSTS when provided. */
  allowedHosts?: Iterable<string>;
  /** Injectable resolver (host → IP strings); defaults to DNS. Tests mock this. */
  resolve?: (host: string) => Promise<string[]>;
}

async function defaultResolve(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

/**
 * Throw SsrfError unless `rawUrl` passes every check (scheme, host allowlist,
 * resolved-address screen). Returns the parsed URL on success.
 */
export async function assertUrlAllowed(rawUrl: string, opts: SsrfOptions = {}): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new SsrfError(`invalid URL: ${String(rawUrl)}`);
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new SsrfError(`scheme not allowed: ${url.protocol} (only http/https)`);
  }

  const allowed = opts.allowedHosts
    ? new Set([...opts.allowedHosts].map((h) => h.toLowerCase()))
    : DEFAULT_ALLOWED_HOSTS;
  const host = url.hostname.toLowerCase();
  if (!allowed.has(host)) {
    throw new SsrfError(`host not on allowlist: ${host}`);
  }

  const resolve = opts.resolve ?? defaultResolve;
  const addrs = isIP(host) ? [host] : await resolve(host);
  if (addrs.length === 0) {
    throw new SsrfError(`host did not resolve: ${host}`);
  }
  for (const addr of addrs) {
    if (isBlockedIp(addr)) {
      throw new SsrfError(`host ${host} resolves to blocked address ${addr}`);
    }
  }
  return url;
}

/**
 * SSRF-safe fetch: validates the URL, then fetches with redirects disabled.
 *
 * We use `redirect: "manual"`, which (per the Fetch spec / undici in Node 20+)
 * yields an opaque response — `type: "opaqueredirect"`, `status: 0`, Location
 * NOT readable — for any 3xx. Because the redirect target cannot be inspected,
 * we reject every redirect, a strict superset of "reject redirects to
 * disallowed hosts." Allowlisted corpora (NVD API, raw.githubusercontent.com)
 * serve 200 directly, so this costs us nothing operationally.
 */
export async function safeFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: SsrfOptions = {},
): Promise<Response> {
  await assertUrlAllowed(rawUrl, opts);
  const res = await fetch(rawUrl, { ...init, redirect: "manual" });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    throw new SsrfError(`redirect refused for ${rawUrl} (status ${res.status})`);
  }
  return res;
}
