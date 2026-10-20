import { describe, expect, test } from "bun:test";
import { clientIp, edgeNode, parseIpapi, parseIpwhois, rateLimit } from "./server.ts";

describe("provider normalization", () => {
  test("ipapi.is fields map to the shared shape", () => {
    const out = parseIpapi({
      ip: "8.8.8.8",
      is_bogon: false,
      company: "Google LLC",
      asn: "AS15169 Google LLC",
      city: "Mountain View",
      region: "California",
      country: "United States",
      lat: 37.38605,
      lon: -122.08385,
      timezone: "America/Los_Angeles",
    });

    expect(out).toMatchObject({
      ip: "8.8.8.8",
      country: "United States",
      region: "California",
      city: "Mountain View",
      isp: "Google LLC",
      asn: "15169",
      timezone: "America/Los_Angeles",
    });
  });

  test("ipapi.is rejects an error envelope", () => {
    expect(() => parseIpapi({ error: "Invalid IP Address or AS Number" })).toThrow(
      "Invalid IP Address or AS Number",
    );
  });

  test("ipwho.is nests connection and timezone", () => {
    const out = parseIpwhois({
      success: true,
      ip: "8.8.8.8",
      country: "United States",
      country_code: "US",
      region: "California",
      city: "San Jose",
      connection: { isp: "Google LLC", org: "Google LLC", asn: 15169 },
      timezone: { id: "America/Los_Angeles" },
      latitude: 37.33,
      longitude: -121.89,
    });

    expect(out).toMatchObject({
      asn: "15169",
      timezone: "America/Los_Angeles",
      isp: "Google LLC",
    });
  });

  test("ipwho.is rejects a failed envelope", () => {
    expect(() => parseIpwhois({ success: false, message: "invalid ip" })).toThrow("invalid ip");
  });
});

describe("edgeNode", () => {
  const probe = (headers: Record<string, string>) => edgeNode(new Headers(headers));

  test("Cloudflare colo comes from cf-ray", () => {
    expect(probe({ "cf-ray": "a4d75b83187335a6-GYD" })).toEqual({ node: "GYD", via: "cf-ray" });
  });

  test("CloudFront point of presence comes from x-amz-cf-pop", () => {
    expect(probe({ "x-amz-cf-pop": "SOF50-P1" })).toEqual({ node: "SOF50-P1", via: "x-amz-cf-pop" });
  });

  test("Fastly pop is the suffix of the first x-served-by entry", () => {
    expect(probe({ "x-served-by": "cache-sjc1000127-SJC, cache-fra-eddf8230094-FRA" })).toEqual({
      node: "SJC",
      via: "x-served-by",
    });
  });

  test("Bunny keeps its edge id in the server banner", () => {
    expect(probe({ server: "BunnyCDN-AZ1-1530" })).toEqual({ node: "AZ1-1530", via: "server" });
  });
});

describe("rateLimit", () => {
  test("allows requests up to the window limit", () => {
    for (let i = 0; i < 5; i++) expect(rateLimit("1.1.1.1", 1000 + i)).toBe(true);
  });

  test("blocks requests over the window limit", () => {
    const t0 = 2000;
    for (let i = 0; i < 5; i++) rateLimit("2.2.2.2", t0 + i, 5);
    expect(rateLimit("2.2.2.2", t0 + 5, 5)).toBe(false);
  });

  test("resets the counter after the window elapses", () => {
    const t0 = 3000;
    for (let i = 0; i < 5; i++) rateLimit("3.3.3.3", t0 + i);
    expect(rateLimit("3.3.3.3", t0 + 60_001)).toBe(true);
  });

  test("tracks keys independently", () => {
    const t0 = 4000;
    for (let i = 0; i < 5; i++) rateLimit("4.4.4.4", t0 + i);
    expect(rateLimit("5.5.5.5", t0)).toBe(true);
  });

  test("drops the oldest key once the tracker is at capacity", () => {
    const hits = new Map();
    const t0 = 6000;
    for (let i = 0; i < 5; i++) rateLimit("10.0.0.1", t0 + i, 5, 60_000, 2, hits);
    expect(rateLimit("10.0.0.1", t0 + 5, 5, 60_000, 2, hits)).toBe(false);
    rateLimit("10.0.0.2", t0 + 6, 5, 60_000, 2, hits);
    rateLimit("10.0.0.3", t0 + 7, 5, 60_000, 2, hits);
    expect(rateLimit("10.0.0.1", t0 + 8, 5, 60_000, 2, hits)).toBe(true);
  });
});

describe("clientIp", () => {
  const req = (headers: Record<string, string>) => new Request("http://localhost/", { headers });

  test("prefers cf-connecting-ip", () => {
    expect(clientIp(req({ "cf-connecting-ip": "5.1.2.3", "x-forwarded-for": "9.9.9.9" }))).toBe("5.1.2.3");
  });

  test("takes the first forwarded address", () => {
    expect(clientIp(req({ "x-forwarded-for": "5.1.2.3, 10.0.0.1" }))).toBe("5.1.2.3");
  });

  test("returns null for loopback and missing headers", () => {
    expect(clientIp(req({ "x-forwarded-for": "127.0.0.1" }))).toBeNull();
    expect(clientIp(req({}))).toBeNull();
  });
});
