import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertUrlAllowed,
  isBlockedIp,
  safeFetch,
  SsrfError,
} from "../src/guards/ssrf.js";

/** Resolver stub so URL checks run offline and deterministically. */
const resolvesPublic = async () => ["8.8.8.8"];

describe("isBlockedIp — blocked ranges", () => {
  it("blocks IPv4 loopback (127.0.0.0/8)", () => {
    expect(isBlockedIp("127.0.0.1")).toBe(true);
    expect(isBlockedIp("127.255.255.254")).toBe(true);
  });

  it("blocks the cloud-metadata IP and the rest of link-local (169.254.0.0/16)", () => {
    expect(isBlockedIp("169.254.169.254")).toBe(true); // AWS/GCP/Azure metadata
    expect(isBlockedIp("169.254.0.1")).toBe(true);
  });

  it("blocks RFC1918 private ranges", () => {
    for (const ip of ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it("blocks unspecified, CGNAT, multicast and reserved", () => {
    for (const ip of ["0.0.0.0", "100.64.0.1", "224.0.0.1", "240.0.0.1", "255.255.255.255"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it("blocks IPv6 loopback, link-local and unique-local", () => {
    for (const ip of ["::1", "fe80::1", "febf::1", "fc00::1", "fd12:3456::1"]) {
      expect(isBlockedIp(ip)).toBe(true);
    }
  });

  it("blocks IPv4-mapped IPv6 loopback (::ffff:127.0.0.1)", () => {
    expect(isBlockedIp("::ffff:127.0.0.1")).toBe(true);
  });
});

describe("isBlockedIp — public addresses pass", () => {
  it("does not block routable addresses just outside the private ranges", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "172.32.0.1", // just above 172.16/12
      "192.169.0.1", // just above 192.168/16
      "100.63.0.1", // just below CGNAT
      "2606:4700:4700::1111", // public IPv6
    ]) {
      expect(isBlockedIp(ip)).toBe(false);
    }
  });
});

describe("assertUrlAllowed", () => {
  it("accepts an allowlisted host that resolves to a public IP", async () => {
    const url = await assertUrlAllowed(
      "https://services.nvd.nist.gov/rest/json/cves/2.0",
      { resolve: resolvesPublic },
    );
    expect(url).toBeInstanceOf(URL);
  });

  it("rejects a host that is not on the allowlist", async () => {
    await expect(
      assertUrlAllowed("https://evil.example.com/steal", { resolve: resolvesPublic }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("rejects non-http(s) schemes", async () => {
    for (const u of [
      "file:///etc/passwd",
      "ftp://services.nvd.nist.gov/x",
      "gopher://services.nvd.nist.gov/",
    ]) {
      await expect(
        assertUrlAllowed(u, { resolve: resolvesPublic }),
      ).rejects.toBeInstanceOf(SsrfError);
    }
  });

  it("rejects an allowlisted host that resolves to an internal IP (DNS-rebind defence)", async () => {
    const resolvesPrivate = async () => ["169.254.169.254"];
    await expect(
      assertUrlAllowed("https://services.nvd.nist.gov/x", { resolve: resolvesPrivate }),
    ).rejects.toThrow(/blocked address/);
  });

  it("rejects a literal metadata IP even when passed as an allowed host", async () => {
    await expect(
      assertUrlAllowed("http://169.254.169.254/latest/meta-data/", {
        allowedHosts: ["169.254.169.254"],
      }),
    ).rejects.toBeInstanceOf(SsrfError);
  });
});

describe("safeFetch — redirect refusal", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("refuses an opaque redirect (redirect:'manual' => type opaqueredirect)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ type: "opaqueredirect", status: 0 }) as unknown as Response),
    );
    await expect(
      safeFetch("https://services.nvd.nist.gov/x", {}, { resolve: resolvesPublic }),
    ).rejects.toBeInstanceOf(SsrfError);
  });

  it("returns a normal 200 response unchanged", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ type: "basic", status: 200 }) as unknown as Response),
    );
    const res = await safeFetch(
      "https://services.nvd.nist.gov/x",
      {},
      { resolve: resolvesPublic },
    );
    expect(res.status).toBe(200);
  });

  it("blocks a disallowed host before fetch() is ever called", async () => {
    const spy = vi.fn(async () => ({ type: "basic", status: 200 }) as unknown as Response);
    vi.stubGlobal("fetch", spy);
    await expect(
      safeFetch("https://evil.example.com/x", {}, { resolve: resolvesPublic }),
    ).rejects.toBeInstanceOf(SsrfError);
    expect(spy).not.toHaveBeenCalled();
  });
});
