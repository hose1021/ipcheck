import { describe, expect, test } from "bun:test";
import { clientIp, edgeNode, parseIpApi, parseIpwhois } from "./server.ts";

describe("provider normalization", () => {
  test("ip-api.com fields map to the shared shape", () => {
    const out = parseIpApi({
      status: "success",
      query: "37.61.119.92",
      country: "Azerbaijan",
      countryCode: "AZ",
      regionName: "Baki",
      city: "Baku",
      isp: "Aztelekom LLC",
      org: "Aztelekom LLC",
      as: "AS28787 Aztelekom LLC",
      timezone: "Asia/Baku",
      lat: 40.37767,
      lon: 49.89201,
    });

    expect(out).toMatchObject({
      ip: "37.61.119.92",
      countryCode: "AZ",
      region: "Baki",
      city: "Baku",
      asn: "28787",
    });
  });

  test("ip-api.com failure status throws its message", () => {
    expect(() => parseIpApi({ status: "fail", message: "private range" })).toThrow("private range");
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
