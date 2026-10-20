// Minimal IP lookup server: static UI + geo enrichment from two public sources.
import { Resolver } from "node:dns/promises";
import { z } from "zod";
import { TARGETS } from "./public/targets.js";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = new URL("./public/", import.meta.url);
const CACHE_MS = 60_000;

// Every page is the same document; the client router picks the view.
const APP_ROUTES: Record<string, true> = {
  "/": true,
  "/split-tunnel": true,
  "/cdn-node-lookup": true,
  "/dns-exit-lookup": true,
  "/stun": true,
  "/multi": true,
  "/query": true,
};

type Lookup = {
  ip: string;
  country?: string;
  countryCode?: string;
  region?: string;
  city?: string;
  isp?: string;
  org?: string;
  asn?: string;
  timezone?: string;
  lat?: number;
  lon?: number;
};

// Response shapes of the two public providers; parsed once at the boundary.
const IpapiisResponse = z.object({
  ip: z.string().optional(),
  error: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  company: z.string().optional(),
  asn: z.string().optional(),
  timezone: z.string().optional(),
  lat: z.number().optional(),
  lon: z.number().optional(),
});

const IpwhoResponse = z.object({
  success: z.boolean(),
  message: z.string().optional(),
  ip: z.string().optional(),
  country: z.string().optional(),
  country_code: z.string().optional(),
  region: z.string().optional(),
  city: z.string().optional(),
  connection: z
    .object({
      isp: z.string().optional(),
      org: z.string().optional(),
      asn: z.union([z.number(), z.string()]).optional(),
    })
    .optional(),
  timezone: z.object({ id: z.string().optional() }).optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

const CACHE_MAX = 5_000;
const cache = new Map<string, { at: number; data: unknown }>();

export function parseIpapi(raw: unknown): Lookup {
  const parsed = IpapiisResponse.safeParse(raw);
  if (!parsed.success) throw new Error("unexpected ipapi.is response");
  const j = parsed.data;
  if (j.error) throw new Error(j.error);
  return {
    ip: j.ip ?? "",
    country: j.country,
    region: j.region,
    city: j.city,
    isp: j.company,
    asn: j.asn?.replace(/^AS/, "").split(" ")[0],
    timezone: j.timezone,
    lat: j.lat,
    lon: j.lon,
  };
}

async function fromIpapi(ip: string): Promise<Lookup> {
  const res = await fetch(`https://api.ipapi.is?q=${encodeURIComponent(ip)}`, {
    signal: AbortSignal.timeout(6000),
  });
  return { ...parseIpapi(await res.json()), ip: ip };
}

export function parseIpwhois(raw: unknown): Lookup {
  const parsed = IpwhoResponse.safeParse(raw);
  if (!parsed.success) throw new Error("unexpected ipwho.is response");
  const j = parsed.data;
  if (!j.success) throw new Error(j.message ?? "lookup failed");
  const asn = j.connection?.asn;
  return {
    ip: j.ip ?? "",
    country: j.country,
    countryCode: j.country_code,
    region: j.region,
    city: j.city,
    isp: j.connection?.isp,
    org: j.connection?.org,
    asn: asn === undefined ? undefined : String(asn),
    timezone: j.timezone?.id,
    lat: j.latitude,
    lon: j.longitude,
  };
}

async function fromIpwhois(ip: string): Promise<Lookup> {
  const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, {
    signal: AbortSignal.timeout(6000),
  });
  return parseIpwhois(await res.json());
}

const SOURCES = [
  { name: "ipapi.is", fn: fromIpapi },
  { name: "ipwho.is", fn: fromIpwhois },
];


export function clientIp(req: Request): string | null {
  const h = req.headers;
  const raw = h.get("cf-connecting-ip") ?? h.get("x-real-ip") ?? h.get("x-forwarded-for")?.split(",")[0];
  const ip = raw?.trim();
  if (!ip || ip === "::1" || ip.startsWith("127.")) return null;
  return ip;
}

// Fixed-window limiter per key; guards the open /api/lookup endpoint.
const RATE_LIMIT_MAX = 60;
const RATE_WINDOW_MS = 60_000;
const rateHits = new Map<string, { start: number; count: number }>();

export function rateLimit(
  key: string,
  now = Date.now(),
  max = RATE_LIMIT_MAX,
  windowMs = RATE_WINDOW_MS,
  capacity = 10_000,
  hits: Map<string, { start: number; count: number }> = rateHits,
): boolean {
  const hit = hits.get(key);
  if (!hit || now - hit.start >= windowMs) {
    if (hits.size >= capacity) hits.delete(hits.keys().next().value);
    hits.set(key, { start: now, count: 1 });
    return true;
  }
  if (hit.count >= max) return false;
  hit.count++;
  return true;
}

async function lookup(ip: string) {
  const hit = cache.get(ip);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const results = await Promise.all(
    SOURCES.map(async ({ name, fn }) => {
      try {
        return { name, ok: true as const, ...(await fn(ip)) };
      } catch (e) {
        return { name, ok: false as const, error: e instanceof Error ? e.message : "failed" };
      }
    }),
  );
  const data = { ip, primary: results.find((r) => r.ok) ?? null, sources: results };
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(ip, { at: Date.now(), data });
  return data;
}

const CDN_PROBES = [
  { name: "Cloudflare", url: "https://www.cloudflare.com/" },
  { name: "jsDelivr", url: "https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js" },
  { name: "Fastly", url: "https://code.jquery.com/jquery-3.7.1.min.js" },
  { name: "AWS CloudFront", url: "https://d1.awsstatic.com/" },
  { name: "Akamai", url: "https://www.microsoft.com/" },
  { name: "Bunny", url: "https://bunny.net/" },
  { name: "CDN77", url: "https://www.cdn77.com/" },
];

// Each CDN stamps the serving edge into a different response header.
export function edgeNode(headers: Headers): { node: string; via: string } {
  const ray = headers.get("cf-ray"); // Cloudflare: "<hash>-<colo>"
  if (ray) return { node: ray.split("-").pop() ?? ray, via: "cf-ray" };
  const pop = headers.get("x-amz-cf-pop"); // CloudFront: "SOF50-P1"
  if (pop) return { node: pop, via: "x-amz-cf-pop" };
  const served = headers.get("x-served-by"); // Fastly: "cache-fra-etou8220048-FRA"
  if (served) {
    const first = served.split(",")[0].trim();
    return { node: first.split("-").pop() ?? first, via: "x-served-by" };
  }
  const server = headers.get("server"); // Bunny: "BunnyCDN-AZ1-1530"
  return { node: server?.replace(/^BunnyCDN-/, "") ?? "—", via: "server" };
}

async function probeCdn({ name, url }: (typeof CDN_PROBES)[number]) {
  const started = performance.now();
  try {
    const res = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "ipcheck/1.0" },
    });
    const { node, via } = edgeNode(res.headers);
    return { name, ok: true, status: res.status, ms: Math.round(performance.now() - started), node, via };
  } catch {
    return { name, ok: false, status: null, ms: null, node: null, via: null };
  }
}

// Each service answers with the address it sees; different answers mean the
// host leaves through more than one route.
const ECHO_SERVICES = [
  { name: "ipify.org", url: "https://api.ipify.org?format=json", pattern: /"ip":"([^"]+)"/ },
  { name: "Amazon", url: "https://checkip.amazonaws.com", pattern: /^([0-9a-fA-F:.]+)/ },
  { name: "ipinfo.io", url: "https://ipinfo.io/json", pattern: /"ip":\s*"([^"]+)"/ },
  { name: "ipwho.is", url: "https://ipwho.is/", pattern: /"ip":\s*"([^"]+)"/ },
  { name: "ipapi.is", url: "https://api.ipapi.is/", pattern: /"ip":"([^"]+)"/ },
  { name: "ifconfig.co", url: "https://ifconfig.co/json", pattern: /"ip":\s*"([^"]+)"/ },
  { name: "ipapi.co", url: "https://ipapi.co/json/", pattern: /"ip":\s*"([^"]+)"/ },
  { name: "icanhazip", url: "https://ipv4.icanhazip.com", pattern: /^([0-9.]+)/ },
  { name: "Cloudflare", url: "https://www.cloudflare.com/cdn-cgi/trace", pattern: /^ip=(.+)$/m },
];

async function echoProbe({ name, url, pattern }: (typeof ECHO_SERVICES)[number]) {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
      headers: { "user-agent": "ipcheck/1.0" },
    });
    const match = pattern.exec(await res.text());
    const ip = match?.[1]?.trim() ?? null;
    return { name, ok: ip !== null, ip };
  } catch {
    return { name, ok: false, ip: null };
  }
}

// Every Cloudflare-fronted site answers /cdn-cgi/trace with the address it sees,
// so one request per site shows which exit IP that site actually receives.
const SPLIT_SITES = [
  { group: "az", name: "oxu.az", url: "https://oxu.az/" },
  { group: "az", name: "apa.az", url: "https://apa.az/" },
  { group: "az", name: "trend.az", url: "https://www.trend.az/" },
  { group: "az", name: "azercell.com", url: "https://azercell.com/az/" },
  { group: "az", name: "bakcell.com", url: "https://www.bakcell.com/" },
  { group: "az", name: "nar.az", url: "https://nar.az/" },
  { group: "cn", name: "alibaba.com", url: "https://www.alibaba.com/" },
  { group: "cn", name: "163.com (NetEase)", url: "https://www.163.com/" },
  { group: "cn", name: "bytedance.com", url: "https://www.bytedance.com/" },
  { group: "cn", name: "tencent.com", url: "https://www.tencent.com/" },
  { group: "cn", name: "www.qualcomm.cn", url: "https://www.qualcomm.cn/" },
  { group: "intl", name: "www.cloudflare.com", url: "https://www.cloudflare.com/" },
  { group: "intl", name: "discord.com", url: "https://discord.com/" },
  { group: "intl", name: "www.visa.com", url: "https://www.visa.com/" },
  { group: "intl", name: "x.com", url: "https://x.com/" },
  { group: "intl", name: "medium.com", url: "https://medium.com/" },
  { group: "games", name: "store.steampowered.com", url: "https://store.steampowered.com/" },
  { group: "games", name: "steamcommunity.com", url: "https://steamcommunity.com/" },
  { group: "games", name: "www.epicgames.com", url: "https://www.epicgames.com/" },
  { group: "games", name: "www.ea.com", url: "https://www.ea.com/" },
  { group: "games", name: "battle.net", url: "https://battle.net/" },
  { group: "games", name: "www.riotgames.com", url: "https://www.riotgames.com/" },
  { group: "games", name: "www.gog.com", url: "https://www.gog.com/" },
  { group: "games", name: "www.playstation.com", url: "https://www.playstation.com/" },
  { group: "games", name: "www.xbox.com", url: "https://www.xbox.com/" },
  { group: "games", name: "www.roblox.com", url: "https://www.roblox.com/" },
  { group: "ai", name: "chatgpt.com", url: "https://chatgpt.com/" },
  { group: "ai", name: "sora.com", url: "https://sora.com/" },
  { group: "ai", name: "openai.com", url: "https://openai.com/" },
  { group: "ai", name: "claude.ai", url: "https://claude.ai/" },
  { group: "ai", name: "grok.com", url: "https://grok.com/" },
  { group: "ai", name: "anthropic.com", url: "https://www.anthropic.com/" },
  { group: "ai", name: "www.perplexity.ai", url: "https://www.perplexity.ai/" },
  { group: "crypto", name: "coinbase.com", url: "https://www.coinbase.com/" },
  { group: "crypto", name: "www.okx.com", url: "https://www.okx.com/" },
  { group: "crypto", name: "binance.com", url: "https://www.binance.com/" },
  { group: "static", name: "cdn.jsdelivr.net", url: "https://cdn.jsdelivr.net/" },
  { group: "static", name: "cdnjs.cloudflare.com", url: "https://cdnjs.cloudflare.com/" },
  { group: "static", name: "cloudflaremirrors.com", url: "https://cloudflaremirrors.com/" },
  { group: "static", name: "registry.npmjs.org", url: "https://registry.npmjs.org/" },
  { group: "static", name: "kali.download", url: "https://kali.download/" },
  { group: "static", name: "unpkg.com", url: "https://unpkg.com/" },
  { group: "other", name: "crunchyroll.com", url: "https://www.crunchyroll.com/" },
  { group: "other", name: "nodejs.org", url: "https://nodejs.org/" },
  { group: "other", name: "gitlab.com", url: "https://gitlab.com/" },
  { group: "cn", name: "www.temu.com", url: "https://www.temu.com/" },
];

type SplitProbeResult = {
  group: string;
  name: string;
  exitIp: string | null;
  reachable: boolean;
  status: number | null;
  ms: number | null;
};

async function splitProbe({ group, name, url }: (typeof SPLIT_SITES)[number]): Promise<SplitProbeResult> {
  const started = performance.now();
  try {
    const res = await fetch(new URL("/cdn-cgi/trace", url), {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(7000),
      headers: { "user-agent": "ipcheck/1.0" },
    });
    const exitIp = /^ip=(.+)$/m.exec(await res.text())?.[1]?.trim() ?? null;
    if (exitIp) {
      return { group, name, exitIp, reachable: true, status: res.status, ms: Math.round(performance.now() - started) };
    }
  } catch {
    /* no trace endpoint or the host refused it; fall through to a plain check */
  }
  try {
    const res = await fetch(url, {
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(7000),
      headers: { "user-agent": "ipcheck/1.0" },
    });
    return {
      group,
      name,
      exitIp: null,
      reachable: res.status < 500,
      status: res.status,
      ms: Math.round(performance.now() - started),
    };
  } catch {
    return { group, name, exitIp: null, reachable: false, status: null, ms: null };
  }
}

const RESOLVERS = [
  { name: "Системный", server: null },
  { name: "Cloudflare", server: "1.1.1.1" },
  { name: "Google", server: "8.8.8.8" },
  { name: "Quad9", server: "9.9.9.9" },
  { name: "OpenDNS", server: "208.67.222.222" },
  { name: "AdGuard", server: "94.140.14.14" },
  { name: "AliDNS", server: "223.5.5.5" },
  { name: "Yandex", server: "77.88.8.8" },
];

// whoami.akamai.net answers with the address the resolver used, i.e. its exit IP.
// IPv4-first: some hosts and resolvers only answer over a v6 path.
async function dnsExit({ name, server }: (typeof RESOLVERS)[number]) {
  const resolver = new Resolver({ timeout: 4000, tries: 1 });
  if (server) resolver.setServers([server]);
  const started = performance.now();
  try {
    let exitIp: string;
    try {
      [exitIp] = await resolver.resolve4("whoami.akamai.net");
    } catch {
      [exitIp] = await resolver.resolve6("whoami.akamai.net");
    }
    return { name, server, ok: true, ms: Math.round(performance.now() - started), exitIp };
  } catch {
    return { name, server, ok: false, ms: null, exitIp: null };
  }
}

// Broad reachability sweep over the public Speedtest.net server list. The list
// is what the original tool uses; the exit address itself comes from the echo
// services above, because these servers do not report the caller's IP.
const SPEEDTEST_LIST = "https://speedtest-net-servers.cdn.skk.moe/servers.json";
const SWEEP_CONCURRENCY = 40;
const SWEEP_TIMEOUT_MS = 2500;

const ProbeList = z.array(
  z.object({
    host: z.string().min(3),
    cc: z.string().optional(),
    name: z.string().optional(),
    sponsor: z.string().optional(),
  }),
);

type ProbeEntry = { host: string; cc: string; label: string };

type Sweep = {
  running: boolean;
  total: number;
  done: number;
  ok: number;
  fail: number;
  startedAt: number;
  countries: Map<string, { ok: number; fail: number; labels: string[]; failed: string[] }>;
};

let probeHosts: ProbeEntry[] | null = null;
let sweep: Sweep | null = null;

async function loadProbeHosts() {
  if (probeHosts) return probeHosts;
  const res = await fetch(SPEEDTEST_LIST, { signal: AbortSignal.timeout(20000) });
  const parsed = ProbeList.safeParse(await res.json());
  if (!parsed.success) throw new Error("unexpected Speedtest server list");
  probeHosts = parsed.data.map((entry) => ({
    host: entry.host,
    cc: entry.cc ?? "??",
    label: entry.name ? `${entry.name}${entry.sponsor ? ` (${entry.sponsor})` : ""}` : entry.host,
  }));
  return probeHosts;
}

function startSweep(limit: number) {
  if (sweep?.running) return sweep;
  sweep = {
    running: true,
    total: 0,
    done: 0,
    ok: 0,
    fail: 0,
    startedAt: Date.now(),
    countries: new Map(),
  };
  const current = sweep;

  void (async () => {
    let hosts: ProbeEntry[];
    try {
      hosts = (await loadProbeHosts()).slice(0, limit);
    } catch {
      current.running = false;
      return;
    }
    current.total = hosts.length;
    let cursor = 0;

    const worker = async () => {
      while (cursor < hosts.length) {
        const entry = hosts[cursor++];
        let ok = false;
        try {
          const res = await fetch(`http://${entry.host}/speedtest/latency.txt`, {
            cache: "no-store",
            redirect: "follow",
            signal: AbortSignal.timeout(SWEEP_TIMEOUT_MS),
          });
          ok = res.ok;
        } catch {
          ok = false;
        }
        current.done++;
        if (ok) current.ok++;
        else current.fail++;
        const bucket = current.countries.get(entry.cc) ?? { ok: 0, fail: 0, labels: [], failed: [] };
        if (ok) {
          bucket.ok++;
          bucket.labels.push(entry.label);
        } else {
          bucket.fail++;
          bucket.failed.push(entry.label);
        }
        current.countries.set(entry.cc, bucket);
      }
    };

    await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, hosts.length) }, worker));
    current.running = false;
  })();

  return sweep;
}

function sweepSnapshot() {
  if (!sweep) return { running: false, total: 0, done: 0, ok: 0, fail: 0, elapsedMs: 0, countries: [] };
  return {
    running: sweep.running,
    total: sweep.total,
    done: sweep.done,
    ok: sweep.ok,
    fail: sweep.fail,
    elapsedMs: Date.now() - sweep.startedAt,
    countries: [...sweep.countries.entries()]
      .map(([cc, v]) => ({ cc, ok: v.ok, fail: v.fail }))
      .sort((a, b) => b.ok - a.ok),
  };
}

// Attached to every response. The script hash matches the inline theme script
// in public/index.html; bump it there together.
const SECURITY_HEADERS = {
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'sha256-hVsJGBC8YgkvmDOD7j0PHU9Nnr/0ZPpu1sPtHb1y4AE='; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https:; font-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=()",
  "cross-origin-opener-policy": "same-origin",
};

export function createServer(port = PORT) {
  const handle = async (req: Request, rateKey: string): Promise<Response> => {
    const url = new URL(req.url);

    if (url.pathname === "/api/client-ip") {
      return Response.json({ ip: clientIp(req) });
    }

    if (url.pathname === "/api/targets") {
      return Response.json(TARGETS, { headers: { "cache-control": "no-store" } });
    }

      if (url.pathname === "/api/cdn") {
        return Response.json(await Promise.all(CDN_PROBES.map(probeCdn)));
      }

      if (url.pathname === "/api/dns") {
        const exits = await Promise.all(RESOLVERS.map(dnsExit));
        const withGeo = await Promise.all(
          exits.map(async (r) => {
            const geo = r.exitIp ? (await lookup(r.exitIp)).primary : null;
            return {
              ...r,
              country: geo?.country ?? null,
              city: geo?.city ?? null,
              isp: geo?.isp ?? null,
              asn: geo?.asn ?? null,
            };
          }),
        );
        return Response.json(withGeo);
      }

      if (url.pathname === "/api/multi") {
        const probes = await Promise.all(ECHO_SERVICES.map(echoProbe));
        const geo = await Promise.all(probes.map(async (p) => (p.ip ? (await lookup(p.ip)).primary : null)));
        const rows = probes.map((p, i) => ({
          name: p.name,
          ok: p.ok,
          ip: p.ip,
          country: geo[i]?.country ?? null,
          countryCode: geo[i]?.countryCode ?? null,
          city: geo[i]?.city ?? null,
        }));
        const unique = [...new Set(rows.flatMap((r) => (r.ip ? [r.ip] : [])))];
        return Response.json({ unique, rows });
      }

      if (url.pathname === "/api/sweep/status") {
        return Response.json(sweepSnapshot());
      }

      if (url.pathname === "/api/sweep/country") {
        const cc = url.searchParams.get("cc") ?? "";
        const bucket = sweep?.countries.get(cc);
        return Response.json({ cc, labels: bucket?.labels ?? [], failed: bucket?.failed ?? [] });
      }

      if (url.pathname === "/api/sweep/start") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 1665, 1), 1801);
        startSweep(limit);
        return Response.json(sweepSnapshot());
      }

      if (url.pathname === "/api/split") {
        // Chunked so one burst does not time out on slower hosts.
        const probes: SplitProbeResult[] = [];
        for (let i = 0; i < SPLIT_SITES.length; i += 8) {
          probes.push(...(await Promise.all(SPLIT_SITES.slice(i, i + 8).map(splitProbe))));
        }
        const geo = await Promise.all(probes.map(async (p) => (p.exitIp ? (await lookup(p.exitIp)).primary : null)));
        return Response.json(
          probes.map((p, i) => ({
            ...p,
            country: geo[i]?.country ?? null,
            countryCode: geo[i]?.countryCode ?? null,
            city: geo[i]?.city ?? null,
            isp: geo[i]?.isp ?? null,
          })),
        );
      }

      if (url.pathname === "/api/lookup") {
        if (!rateLimit(rateKey)) {
          return Response.json({ error: "rate limited" }, { status: 429 });
        }
        const ip = url.searchParams.get("ip")?.trim();
        if (!ip) return Response.json({ error: "ip is required" }, { status: 400 });
        if (!/^[0-9a-fA-F:.]{3,45}$/.test(ip)) return Response.json({ error: "malformed ip" }, { status: 400 });
        return Response.json(await lookup(ip));
      }

      if (url.pathname === "/api/sweep/export") {
        const cell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
        const rows = ["cc,status,label"];
        for (const [cc, bucket] of sweep?.countries ?? []) {
          for (const label of bucket.labels) rows.push([cc, "ok", label].map(cell).join(","));
          for (const label of bucket.failed) rows.push([cc, "fail", label].map(cell).join(","));
        }
        return new Response(rows.join("\n"), {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="sweep.csv"',
          },
        });
      }

      if (APP_ROUTES[url.pathname]) {
        return new Response(Bun.file(new URL("index.html", PUBLIC_DIR)), {
          headers: { "cache-control": "no-cache" },
        });
      }

      const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
      const file = Bun.file(new URL(path, PUBLIC_DIR));
      if (await file.exists()) {
        return new Response(file, { headers: { "cache-control": "no-cache" } });
      }
      return new Response("not found", { status: 404 });
    };
    return Bun.serve({
      port,
      async fetch(req, server) {
        // Socket address is the claim we cannot check; the proxy headers only
        // matter when the server sits behind one.
        const ip = server.requestIP(req)?.address ?? clientIp(req) ?? "unknown";
        const res = await handle(req, ip);
        for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.headers.set(name, value);
        return res;
      },
    });
}

if (import.meta.main) {
  const server = createServer();
  console.log(`ipcheck listening on http://localhost:${server.port}`);
}
