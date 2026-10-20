import { LANGS, t } from "./i18n.js";
import { TARGETS } from "./targets.js";
import { SPLIT_SITES } from "./split.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const STORE_LANG = "ipcheck-lang";

// The same files serve two deployments: the Bun app (server API) and a static
// GitHub Pages build where every lookup must go straight to public APIs.
let HAS_API = true;

const VIEW_OF_PATH = {
  "/": "home",
  "/query": "home",
  "/split-tunnel": "split",
  "/multi": "multi",
  "/cdn-node-lookup": "cdn",
  "/dns-exit-lookup": "dns",
  "/stun": "stun",
};

const TITLE_OF_VIEW = {
  home: "title",
  split: "splitTitle",
  multi: "multiTitle",
  cdn: "cdnTitle",
  dns: "dnsTitle",
  stun: "stunTitle",
};

const STUN_SERVERS = [
  "stun.l.google.com:19302",
  "stun1.l.google.com:19302",
  "stun.cloudflare.com:3478",
  "stun.nextcloud.com:443",
  "stun.miwifi.com:3478",
  "stun.qq.com:3478",
  "stun.sipnet.net:3478",
  "stun.mullvad.net:3478",
];

const SPLIT_GROUPS = ["az", "cn", "intl", "games", "ai", "crypto", "static", "other"];

let lang = localStorage.getItem(STORE_LANG);
if (!LANGS.includes(lang)) lang = "ru";

const state = { ip: null, data: null, view: null, homeReady: false, multi: null, sweep: null, split: null };
const started = { split: false, multi: false, cdn: false, dns: false, stun: false };

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const countryCode = (code) => (typeof code === "string" && /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : "");

const CELL = "border-t border-line py-[7px] pr-3 align-top";

const cells = (values, cls = "") =>
  `<tr${cls ? ` class="${cls}"` : ""}>${values
    .map((v) => `<td class="${CELL}">${v === null || v === undefined || v === "" ? "—" : esc(v)}</td>`)
    .join("")}</tr>`;

const STORE_THEME = "ipcheck-theme";
const darkMedia = matchMedia("(prefers-color-scheme: dark)");

function setTheme(mode, persist) {
  document.documentElement.dataset.theme = mode;
  const button = document.getElementById("theme");
  if (button) {
    const label = t(lang, mode === "dark" ? "themeToLight" : "themeToDark");
    button.textContent = mode === "dark" ? "☀" : "☾";
    button.setAttribute("aria-label", label);
    button.title = label;
  }
  if (persist) localStorage.setItem(STORE_THEME, mode);
}

function applyLanguage() {
  document.documentElement.lang = lang;
  for (const el of $$("[data-i18n]")) el.textContent = t(lang, el.dataset.i18n);
  for (const el of $$("[data-i18n-placeholder]")) el.placeholder = t(lang, el.dataset.i18nPlaceholder);
  $("#q").placeholder = t(lang, "placeholder");
  for (const b of $$("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  document.title = `${t(lang, TITLE_OF_VIEW[state.view ?? "home"])} · ipcheck`;
  setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light", false);
  if (state.data) render(state.data);
  if (state.multi) renderFound(state.multi);
  if (state.sweep) renderSweep(state.sweep);
  if (state.split) renderSplit(state.split);
}

function fact(label, value) {
  if (!value) return "";
  return `<div><dt class="text-xs uppercase tracking-[0.06em] text-muted">${t(lang, label)}</dt><dd class="mb-0 mt-0.5 tabular-nums">${value}</dd></div>`;
}

function render(data) {
  const p = data.primary;
  $("#ip").textContent = data.ip;
  if (!p) {
    $("#facts").innerHTML = `<div><dd class="text-bad">${t(lang, "failed")}</dd></div>`;
  } else {
    const place = [p.city, p.region].filter(Boolean).join(", ");
    $("#facts").innerHTML = [
      fact("country", p.country ? `${p.countryCode ? `<span class="mr-[7px] inline-block rounded border border-line px-[5px] align-[1px] text-[11px] tracking-[0.04em] text-muted">${countryCode(p.countryCode)}</span>` : ""}${esc(p.country)}` : ""),
      fact("city", esc(place)),
      fact("isp", esc(p.isp ?? p.org)),
      fact("asn", p.asn ? `AS${esc(p.asn)}` : ""),
      fact("timezone", esc(p.timezone)),
      fact("coords", p.lat !== undefined && p.lon !== undefined ? `${p.lat}, ${p.lon}` : ""),
    ].join("");
  }
  $("#sources").innerHTML = data.sources
    .map((s) =>
      s.ok
        ? cells([s.name, s.country, s.city, s.isp ?? s.org, s.asn ? `AS${s.asn}` : "—"])
        : cells([s.name, `${t(lang, "error")}: ${s.error}`, "", "", ""], "text-bad"),
    )
    .join("");
}

async function detectIp() {
  try {
    const res = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
    const j = await res.json();
    if (j && typeof j.ip === "string") return j.ip;
  } catch {
    /* fall through to the server view of the client address */
  }
  if (HAS_API) {
    try {
      const j = await (await fetch("/api/client-ip")).json();
      if (j && typeof j.ip === "string") return j.ip;
    } catch {
      /* nothing else to try */
    }
  }
  return null;
}

const fetchJson = async (url) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};

// Static build: no server, so each provider is asked directly from the page.
async function staticLookup(ip) {
  const query = encodeURIComponent(ip);
  const results = await Promise.all([
    fetchJson(`https://ipwho.is/${query}`)
      .then((j) =>
        j.success
          ? {
              name: "ipwho.is",
              ok: true,
              ip: j.ip,
              country: j.country,
              countryCode: j.country_code,
              region: j.region,
              city: j.city,
              isp: j.connection?.isp,
              org: j.connection?.org,
              asn: j.connection?.asn ? String(j.connection.asn) : undefined,
              timezone: j.timezone?.id,
              lat: j.latitude,
              lon: j.longitude,
            }
          : Promise.reject(new Error(j.message ?? "failed")),
      )
      .catch((e) => ({ name: "ipwho.is", ok: false, error: e.message })),
    fetchJson(`https://api.ipapi.is/?q=${query}`)
      .then((j) => ({
        name: "ipapi.is",
        ok: true,
        ip: j.ip,
        country: j.country,
        region: j.region,
        city: j.city,
        isp: j.company,
        asn: String(j.asn ?? "").replace(/^AS/, "").split(" ")[0] || undefined,
        timezone: j.timezone,
        lat: j.lat,
        lon: j.lon,
      }))
      .catch((e) => ({ name: "ipapi.is", ok: false, error: e.message })),
    fetchJson(`https://ipinfo.io/${query}/json`)
      .then((j) => {
        const [lat, lon] = String(j.loc ?? "").split(",").map(Number);
        return {
          name: "ipinfo.io",
          ok: true,
          ip: j.ip,
          country: j.country ? regionName(j.country) : undefined,
          countryCode: j.country,
          region: j.region,
          city: j.city,
          org: j.org,
          asn: String(j.org ?? "").match(/^AS(\d+)/)?.[1],
          timezone: j.timezone,
          lat: Number.isFinite(lat) ? lat : undefined,
          lon: Number.isFinite(lon) ? lon : undefined,
        };
      })
      .catch((e) => ({ name: "ipinfo.io", ok: false, error: e.message })),
  ]);
  return { ip, primary: results.find((r) => r.ok) ?? null, sources: results };
}

// Static build: no server, so each view talks to CORS-enabled public endpoints.
const ECHO_STATIC = [
  { name: "ipify.org", url: "https://api.ipify.org?format=json", pattern: /"ip":"([^"]+)"/ },
  { name: "Amazon", url: "https://checkip.amazonaws.com", pattern: /^([0-9a-fA-F:.]+)/ },
  { name: "ipinfo.io", url: "https://ipinfo.io/json", pattern: /"ip":\s*"([^"]+)"/ },
  { name: "ipwho.is", url: "https://ipwho.is/", pattern: /"ip":\s*"([^"]+)"/ },
  { name: "ipapi.is", url: "https://api.ipapi.is/", pattern: /"ip":"([^"]+)"/ },
  { name: "ipapi.co", url: "https://ipapi.co/json/", pattern: /"ip":\s*"([^"]+)"/ },
  { name: "icanhazip", url: "https://ipv4.icanhazip.com", pattern: /^([0-9.]+)/ },
  { name: "Cloudflare", url: "https://www.cloudflare.com/cdn-cgi/trace", pattern: /^ip=(.+)$/m },
];

// Resolvers that publish a CORS-enabled JSON DoH endpoint.
const DNS_STATIC = [
  { name: "Cloudflare", url: "https://cloudflare-dns.com/dns-query?name=whoami.akamai.net&type=A" },
  { name: "Google", url: "https://dns.google/resolve?name=whoami.akamai.net&type=A" },
  { name: "Quad9", url: "https://dns.quad9.net:5053/dns-query?name=whoami.akamai.net&type=A" },
  { name: "OpenDNS", url: "https://doh.opendns.com/dns-query?name=whoami.akamai.net&type=A" },
  { name: "AdGuard", url: "https://dns.adguard-dns.com/resolve?name=whoami.akamai.net&type=A" },
  { name: "AliDNS", url: "https://dns.alidns.com/resolve?name=whoami.akamai.net&type=A" },
];

// Only edges that expose the node to a cross-origin page: Cloudflare's trace
// body and any host with access-control-expose-headers.
const CDN_STATIC = [
  { name: "Cloudflare", url: "https://www.cloudflare.com/cdn-cgi/trace", trace: true },
  { name: "jsDelivr", url: "https://cdn.jsdelivr.net/npm/jquery@3/dist/jquery.min.js" },
];

async function geoStatic(ip) {
  try {
    const j = await (await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { cache: "no-store" })).json();
    return j.success ? { country: j.country, countryCode: j.country_code, city: j.city } : null;
  } catch {
    return null;
  }
}

async function runMultiStatic() {
  const probes = await Promise.all(
    ECHO_STATIC.map(async ({ name, url, pattern }) => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        const ip = pattern.exec(await res.text())?.[1]?.trim() ?? null;
        return { name, ok: ip !== null, ip };
      } catch {
        return { name, ok: false, ip: null };
      }
    }),
  );
  const geo = await Promise.all(probes.map((p) => (p.ip ? geoStatic(p.ip) : null)));
  state.multi = {
    rows: probes.map((p, i) => ({
      name: p.name,
      ok: p.ok,
      ip: p.ip,
      country: geo[i]?.country ?? null,
      countryCode: geo[i]?.countryCode ?? null,
      city: geo[i]?.city ?? null,
    })),
  };
  renderFound(state.multi, $("#multi-filter").value);
}

async function runDnsStatic() {
  const body = $("#dns-body");
  body.innerHTML = cells(["…"]);
  const rows = await Promise.all(
    DNS_STATIC.map(async ({ name, url }) => {
      const started = performance.now();
      try {
        const res = await fetch(url, { cache: "no-store", headers: { accept: "application/dns-json" } });
        const j = await res.json();
        const exitIp = (j.Answer ?? []).find((a) => a.type === 1)?.data ?? null;
        return { name, ok: exitIp !== null, exitIp, ms: Math.round(performance.now() - started) };
      } catch {
        return { name, ok: false, exitIp: null, ms: null };
      }
    }),
  );
  const geo = await Promise.all(rows.map((r) => (r.exitIp ? geoStatic(r.exitIp) : null)));
  body.innerHTML = rows
    .map((r, i) =>
      r.ok
        ? cells([r.name, r.exitIp, geo[i]?.country ?? "", geo[i]?.city ?? "", `${r.ms} ms`])
        : cells([r.name, t(lang, "failed"), "", "", ""], "text-bad"),
    )
    .join("");
}

async function runCdnStatic() {
  const body = $("#cdn-body");
  body.innerHTML = cells(["…"]);
  const rows = await Promise.all(
    CDN_STATIC.map(async ({ name, url, trace }) => {
      const started = performance.now();
      try {
        const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(8000) });
        const ms = Math.round(performance.now() - started);
        const node = trace
          ? (/^colo=(.+)$/m.exec(await res.text())?.[1]?.trim() ?? null)
          : (res.headers.get("x-served-by")?.split(",")[0].trim().split("-").pop() ?? null);
        return { name, ok: true, status: res.status, ms, node };
      } catch {
        return { name, ok: false, status: null, ms: null, node: null };
      }
    }),
  );
  body.innerHTML = rows
    .map((r) =>
      r.ok
        ? cells([r.name, r.node ?? "—", String(r.status), `${r.ms} ms`])
        : cells([r.name, t(lang, "failed"), "", ""], "text-bad"),
    )
    .join("");
}

async function lookup(ip) {
  state.ip = ip;
  $("#ip").textContent = t(lang, "loading");
  if (!HAS_API) {
    state.data = await staticLookup(ip);
    render(state.data);
    return;
  }
  const res = await fetch(`/api/lookup?ip=${encodeURIComponent(ip)}`);
  state.data = res.ok ? await res.json() : { ip, primary: null, sources: [] };
  render(state.data);
}

const RUNS = 12;

const displayName = (name) => name.replace(/^(www|web)\./, "");

const SITE_ICONS = {
  "oxu.az": "news",
  "apa.az": "news",
  "trend.az": "news",
  "azercell.com": "device-mobile",
  "bakcell.com": "device-mobile",
  "nar.az": "device-mobile",
  "google.com": "brand-google",
  "youtube.com": "brand-youtube",
  "cloudflare.com": "brand-cloudflare",
  "github.com": "brand-github",
  "telegram.org": "brand-telegram",
  "whatsapp.com": "brand-whatsapp",
  "instagram.com": "brand-instagram",
  "facebook.com": "brand-facebook",
  "tiktok.com": "brand-tiktok",
  "linkedin.com": "brand-linkedin",
  "reddit.com": "brand-reddit",
  "snapchat.com": "brand-snapchat",
  "pinterest.com": "brand-pinterest",
  "gemini.google.com": "brand-google",
  "deepseek.com": "brain",
  "steampowered.com": "brand-steam",
  "steamcommunity.com": "brand-steam",
  "epicgames.com": "device-gamepad-2",
  "ea.com": "device-gamepad-2",
  "battle.net": "swords",
  "riotgames.com": "device-gamepad-2",
  "gog.com": "device-gamepad-2",
  "playstation.com": "brand-playstation",
  "alibaba.com": "shopping-bag",
  "163.com (NetEase)": "news",
  "bytedance.com": "world",
  "tencent.com": "world",
  "qualcomm.cn": "cpu",
  "discord.com": "brand-discord",
  "visa.com": "brand-visa",
  "x.com": "brand-x",
  "medium.com": "brand-medium",
  "chatgpt.com": "brand-openai",
  "sora.com": "sparkles",
  "openai.com": "brand-openai",
  "claude.ai": "sparkles",
  "grok.com": "sparkles",
  "anthropic.com": "sparkles",
  "perplexity.ai": "sparkles",
  "coinbase.com": "brand-coinbase",
  "binance.com": "brand-binance",
  "okx.com": "currency-bitcoin",
  "cdn.jsdelivr.net": "package",
  "cdnjs.cloudflare.com": "package",
  "cloudflaremirrors.com": "cloud",
  "registry.npmjs.org": "brand-npm",
  "kali.download": "terminal-2",
  "unpkg.com": "package",
  "crunchyroll.com": "device-tv",
  "nodejs.org": "brand-nodejs",
  "gitlab.com": "brand-gitlab",
  "temu.com": "shopping-bag",
  "playstation.com": "simple-icons:playstation",
};

const iconBodies = new Map();

async function loadIcons() {
  const byPrefix = new Map();
  for (const ref of [...Object.values(SITE_ICONS), "world"]) {
    const [prefix, icon] = ref.includes(":") ? ref.split(":") : ["tabler", ref];
    byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), icon]);
  }
  await Promise.all(
    [...byPrefix].map(async ([prefix, icons]) => {
      try {
        const res = await fetch(`https://api.iconify.design/${prefix}.json?icons=${[...new Set(icons)].join(",")}`);
        const data = await res.json();
        for (const [name, icon] of Object.entries(data.icons ?? {})) {
          iconBodies.set(`${prefix}:${name}`, icon.body);
        }
      } catch {
        /* icons are decorative; rows stay readable without them */
      }
    }),
  );
}

const iconSvg = (name, extra = "") => {
  const ref = SITE_ICONS[displayName(name)] ?? "world";
  const key = ref.includes(":") ? ref : `tabler:${ref}`;
  const body = iconBodies.get(key) ?? iconBodies.get("tabler:world");
  if (!body) return "";
  const paint = key.startsWith("simple-icons:")
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
  return `<span class="inline-flex size-[15px] shrink-0 items-center text-muted ${extra}"><svg viewBox="0 0 24 24" width="15" height="15" ${paint}>${body}</svg></span>`;
};

const latencyState = (ms) =>
  ms === null ? "fail" : ms < 90 ? "l90" : ms < 150 ? "l150" : ms < 250 ? "l250" : "lomg";

const dots = (samples, count = RUNS) =>
  `<span class="dots flex shrink-0 gap-1" aria-hidden="true">${Array.from({ length: count }, (_, i) => {
    const ms = samples[i];
    return `<i class="block size-[7px] rounded-full bg-line data-[state=l90]:bg-lat90 data-[state=l150]:bg-lat150 data-[state=l250]:bg-lat250 data-[state=lomg]:bg-latomg data-[state=fail]:bg-line data-[state=pending]:bg-line data-[state=pending]:opacity-40" data-state="${ms === undefined || ms === null ? "pending" : latencyState(ms)}"></i>`;
  }).join("")}</span>`;

// Timing runs in the browser: the number must describe the visitor's own route.
async function probeOnce(url) {
  const started = performance.now();
  try {
    // No cache-buster: YouTube and others answer `?_=` with a consent redirect chain.
    await fetch(url, {
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(6000),
    });
    return Math.round(performance.now() - started);
  } catch {
    return null;
  }
}

async function measureTarget(target, item) {
  const cell = item.querySelector(".ms");
  const dotsEl = item.querySelector(".dots");
  const measured = [];

  const sample = async (index) => {
    let ms = await probeOnce(target.url);
    if (ms === null) ms = await probeOnce(target.url);
    if (ms !== null) measured.push(ms);
    const dot = dotsEl?.children[index];
    if (dot) dot.dataset.state = ms === null ? "fail" : latencyState(ms);
    if (measured.length) {
      const avg = Math.round(measured.reduce((sum, value) => sum + value, 0) / measured.length);
      cell.textContent = `${avg} ms`;
      cell.dataset.state = latencyState(avg);
    }
  };

  for (let i = 0; i < RUNS; i++) {
    await sample(i);
    if (i < RUNS - 1) await new Promise((resolve) => setTimeout(resolve, 150));
  }

  // One quiet retry: a row of twelve failures is usually a transient block.
  if (!measured.length) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    for (let i = 0; i < 3; i++) await sample(i);
  }

  if (!measured.length) {
    cell.textContent = "—";
    cell.dataset.state = "fail";
  }
}

const statusBadge = (ok) =>
  ok === null
    ? '<svg class="ml-auto block" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor" opacity=".45"/><text x="12" y="16.5" text-anchor="middle" font-size="12" font-weight="700" fill="var(--color-card)">?</text></svg>'
    : '<svg class="ml-auto block" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.8 12.4l2.7 2.7 5.7-6.1" fill="none" stroke="var(--color-card)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const imageProbe = (url, timeout = 6000) =>
  new Promise((resolve) => {
    const started = performance.now();
    const img = new Image();
    const finish = (ok) => resolve({ ok, ms: Math.round(performance.now() - started) });
    const timer = setTimeout(() => finish(false), timeout);
    img.onload = () => {
      clearTimeout(timer);
      finish(true);
    };
    img.onerror = () => {
      clearTimeout(timer);
      finish(false);
    };
    img.src = `${new URL(url).origin}/favicon.ico?_=${Date.now()}${Math.random()}`;
  });

let blockedSignals = 0;

function noteBlocking() {
  blockedSignals += 1;
  if (blockedSignals < 3) return;
  const note = document.getElementById("blocked-note");
  if (note) note.hidden = false;
}

async function checkTarget(target, item) {
  const cell = item.querySelector(".ms");
  // An instant rejection means the request never left the browser: a content blocker.
  const icon = await imageProbe(target.check ?? target.url);
  let reachable = icon.ok;
  let instant = !icon.ok && icon.ms < 60;
  if (!reachable) {
    const started = performance.now();
    for (let i = 0; i < 3 && !reachable; i++) reachable = (await probeOnce(target.url)) !== null;
    if (!reachable && performance.now() - started < 90) instant = true;
  }
  // Never ask the server: its route is not the visitor's. Unknown stays unknown.
  cell.innerHTML = statusBadge(reachable ? true : null);
  cell.dataset.state = reachable ? "l90" : "fail";
  cell.title = reachable ? "" : t(lang, "checkUnknown");
  if (!reachable && instant) noteBlocking();
}

async function measureAll() {
  let targets;
  try {
    targets = HAS_API ? await (await fetch("/api/targets", { cache: "no-store" })).json() : TARGETS;
  } catch {
    return;
  }
  await loadIcons();
  for (const group of ["az", "world", "social", "ai", "games"]) {
    const list = document.getElementById(`latency-${group}`);
    const items = targets.filter((x) => x.group === group);
    const availabilityOnly = group === "social" || group === "games" || group === "ai";
    list.innerHTML = items
      .map(
        ({ name }) =>
          `<li class="flex items-center gap-2.5 border-b border-dashed border-line py-[3px]">${iconSvg(name, "-mr-1")}<span class="min-w-0 flex-1 truncate text-muted">${esc(displayName(name))}</span><span class="ms min-w-[52px] text-right font-mono text-[13px] font-medium tabular-nums data-[state=l90]:text-lat90 data-[state=l150]:text-lat150 data-[state=l250]:text-lat250 data-[state=lomg]:text-latomg data-[state=fail]:text-muted data-[state=down]:text-bad" data-host="${esc(name)}">…</span>${
            availabilityOnly ? "" : dots([])
          }</li>`,
      )
      .join("");
    for (const target of items) {
      const item = list.querySelector(`[data-host="${esc(target.name)}"]`)?.closest("li");
      if (!item) continue;
      if (availabilityOnly) checkTarget(target, item);
      else measureTarget(target, item);
    }
  }
}

async function geoOf(ip) {
  try {
    const j = await (await fetch(`/api/lookup?ip=${encodeURIComponent(ip)}`)).json();
    return j.primary ?? null;
  } catch {
    return null;
  }
}

function renderSplit(rows) {
  const body = $("#split-body");
  body.innerHTML = SPLIT_GROUPS.map((group) => {
    const items = rows.filter((row) => row.group === group);
    if (!items.length) return "";
    const head = `<tr class="[&:first-child>th]:border-t-0 [&:first-child>th]:pt-0"><th colspan="4" class="border-t border-line pb-1.5 pr-3 pt-3.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">${t(lang, `group_${group}`)}</th></tr>`;
    const lines = items
      .map((row) => {
        const status = row.reachable
          ? `<td class="${CELL} text-accent">${t(lang, "statusOk")}</td>`
          : `<td class="${CELL} text-bad">${t(lang, "statusDown")}</td>`;
        const ip = row.exitIp
          ? esc(row.exitIp)
          : `<span class="text-muted" title="${t(lang, "noEchoHint")}">—</span>`;
        const geo = row.exitIp ? [row.country, row.city].filter(Boolean).join(" · ") : "";
        return `<tr${row.reachable ? "" : ` class="text-bad"`}><td class="${CELL}">${iconSvg(row.name, "mr-[7px] align-[-2px]")}${esc(displayName(row.name))}</td><td class="${CELL} font-mono text-[13px] tabular-nums">${ip}</td><td class="${CELL} text-muted">${esc(
          geo,
        )}</td>${status}</tr>`;
      })
      .join("");
    return head + lines;
  }).join("");
}

async function runSplitStatic() {
  const body = $("#split-body");
  body.innerHTML = `<tr><td colspan="4" class="${CELL}">${t(lang, "loading")}</td></tr>`;

  const probe = async ({ group, name, url }) => {
    try {
      const res = await fetch(new URL("/cdn-cgi/trace", url), {
        cache: "no-store",
        signal: AbortSignal.timeout(5000),
      });
      const exitIp = /^ip=(.+)$/m.exec(await res.text())?.[1]?.trim() ?? null;
      if (exitIp) return { group, name, exitIp, reachable: true };
    } catch {
      /* no CORS on the trace endpoint; fall through to a plain check */
    }
    try {
      await fetch(url, {
        mode: "no-cors",
        cache: "no-store",
        credentials: "omit",
        signal: AbortSignal.timeout(4000),
      });
      return { group, name, exitIp: null, reachable: true };
    } catch {
      return { group, name, exitIp: null, reachable: false };
    }
  };

  const probes = await Promise.all(SPLIT_SITES.map(probe));
  const geo = await Promise.all(probes.map((p) => (p.exitIp ? geoStatic(p.exitIp) : null)));
  state.split = probes.map((p, i) => ({
    ...p,
    country: geo[i]?.country ?? null,
    countryCode: geo[i]?.countryCode ?? null,
    city: geo[i]?.city ?? null,
  }));
  await loadIcons();
  renderSplit(state.split);
}

async function runSplit() {
  if (!HAS_API) return runSplitStatic();
  $("#split-body").innerHTML = `<tr><td colspan="4" class="${CELL}">${t(lang, "loading")}</td></tr>`;
  try {
    const [rows] = await Promise.all([(await fetch("/api/split")).json(), loadIcons()]);
    state.split = rows;
    renderSplit(state.split);
  } catch {
    $("#split-body").innerHTML = `<tr class="bad"><td colspan="4">${t(lang, "failed")}</td></tr>`;
  }
}

// Chromium ships no Azerbaijani region names and silently returns the system
// locale, so AZ falls back to English — the same choice the original site makes.
const REGION_LOCALE = { ru: "ru", az: "en", en: "en" };

const regionName = (cc) => {
  try {
    const names = new Intl.DisplayNames([REGION_LOCALE[lang] ?? "en"], {
      type: "region",
      fallback: "code",
    });
    return names.of(cc) ?? cc;
  } catch {
    return cc;
  }
};

const flagImg = (cc) =>
  /^[A-Za-z]{2}$/.test(cc ?? "")
    ? `<img class="flag" src="https://flagcdn.com/24x18/${cc.toLowerCase()}.png" alt="" loading="lazy">`
    : "";

function nodeHtml({ cc = "", title, sub = "", summary = "", rawSummary = "", children = "", open = false, attrs = "" }) {
  return `<li class="border-t border-line first:border-t-0" ${attrs}>
    <button type="button" class="group flex w-full items-center gap-2.5 border-0 bg-none py-[9px] text-left text-inherit" aria-expanded="${open}">
      <span class="flex w-6 shrink-0 justify-center">${flagImg(cc)}</span>
      <span class="flex min-w-0 flex-1 flex-col gap-px"><span class="font-semibold tabular-nums group-hover:text-accent">${esc(title)}</span>${sub ? `<span class="truncate text-xs text-muted">${esc(sub)}</span>` : ""}</span>
      <span class="flex max-w-[46%] shrink-0 items-baseline gap-2 truncate text-xs text-muted">${rawSummary || esc(summary)}</span>
      <span class="size-[7px] shrink-0 rotate-45 border-b-[1.5px] border-r-[1.5px] border-muted transition-transform duration-150 group-aria-expanded:-rotate-[135deg]" aria-hidden="true"></span>
    </button>
    <div class="flex flex-wrap gap-1.5 px-0 pt-0.5 pb-3 pl-[34px]"${open ? "" : " hidden"}>${children}</div>
  </li>`;
}

const chip = (label, failed = false) =>
  `<span class="${failed ? "border-bad text-bad" : "border-line bg-bg"} rounded-[5px] border px-2 py-[3px] text-xs">${esc(label)}</span>`;

const chips = (labels) => labels.map((label) => chip(label)).join("");

const chipsWithFailures = (ok, failed) => [...ok.map((label) => chip(label)), ...failed.map((label) => chip(label, true))].join("");

const preview = (labels) =>
  labels.length > 6 ? `${labels.slice(0, 6).join(", ")}, +${labels.length - 6}` : labels.join(", ");

function renderFound(data, query = "") {
  const groups = new Map();
  for (const row of data.rows) {
    if (!row.ip) continue;
    const group = groups.get(row.ip) ?? {
      ip: row.ip,
      country: row.country,
      countryCode: row.countryCode,
      city: row.city,
      services: [],
    };
    group.services.push(row.name);
    groups.set(row.ip, group);
  }
  const q = query.trim().toLowerCase();
  state.found = [...groups.values()]
    .sort((a, b) => b.services.length - a.services.length)
    .filter((g) => !q || [g.ip, g.country, g.city, ...g.services].join(" ").toLowerCase().includes(q));
  $("#multi-export").hidden = state.found.length === 0;
  $("#found-count").textContent = `(${state.found.length})`;
  $("#found-list").innerHTML = state.found
    .map((g) =>
      nodeHtml({
        cc: g.countryCode ?? "",
        title: g.ip,
        sub: [g.country, g.city].filter(Boolean).join(" "),
        summary: preview(g.services),
        children: chips(g.services),
      }),
    )
    .join("");
}

async function runMulti() {
  try {
    state.multi = await (await fetch("/api/multi")).json();
    renderFound(state.multi);
  } catch {
    $("#found-list").innerHTML = `<li class="node">${t(lang, "failed")}</li>`;
  }
}

const countryLabels = new Map();
const openCountries = new Set();

function renderProbeTree(snapshot, query = "") {
  const q = query.trim().toLowerCase();
  const rows = snapshot.countries.filter(
    (c) => !q || regionName(c.cc).toLowerCase().includes(q) || c.cc.toLowerCase().includes(q),
  );
  $("#probe-count").textContent = `(${rows.length})`;
  $("#probe-tree").innerHTML = rows
    .map((c) =>
      nodeHtml({
        cc: c.cc,
        title: regionName(c.cc),
        rawSummary:
          c.fail > 0
            ? `<span class="text-fg tabular-nums">${c.ok}</span><span class="text-bad tabular-nums">${c.fail}</span>`
            : `<span class="text-fg tabular-nums">${c.ok}</span>`,
        children: countryLabels.has(c.cc)
          ? chipsWithFailures(countryLabels.get(c.cc).ok, countryLabels.get(c.cc).failed)
          : "",
        open: openCountries.has(c.cc),
        attrs: `data-cc="${c.cc}"`,
      }),
    )
    .join("");
}

async function loadCountryLabels(node) {
  const cc = node.dataset.cc;
  if (!cc || countryLabels.has(cc)) return;
  const { labels, failed } = await (await fetch(`/api/sweep/country?cc=${encodeURIComponent(cc)}`)).json();
  countryLabels.set(cc, { ok: labels, failed });
  node.querySelector("div").innerHTML = chipsWithFailures(labels, failed);
}

function renderSweep(snapshot) {
  const total = snapshot.total || 1665;
  $("#sweep-progress").textContent = `${snapshot.done} / ${total}`;
  const bar = $("#sweep-bar");
  bar.max = total;
  bar.value = snapshot.done;
  $("#sweep-state").textContent = snapshot.running
    ? t(lang, "sweepRunning")
    : snapshot.done
      ? t(lang, "sweepDone")
      : "";
  $("#sweep-counts").innerHTML = `${t(lang, "sweepOk")}: ${snapshot.ok} · ${t(lang, "sweepFail")}: <span class="text-bad tabular-nums">${snapshot.fail}</span>`;
  $("#sweep-export").hidden = snapshot.done === 0;
  renderProbeTree(snapshot, $("#multi-filter").value);
}

let sweepTimer = null;
let sweepWasRunning = false;

function notifySweepDone() {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(t(lang, "sweepDone"), {
      body: `${t(lang, "sweepOk")}: ${state.sweep.ok} · ${t(lang, "sweepFail")}: ${state.sweep.fail}`,
    });
  } catch {
    /* notifications blocked by the page or the platform */
  }
}

async function pollSweep() {
  const snapshot = await (await fetch("/api/sweep/status")).json();
  if (sweepWasRunning && !snapshot.running && snapshot.done) {
    state.sweep = snapshot;
    notifySweepDone();
  }
  state.sweep = snapshot;
  sweepWasRunning = snapshot.running;
  renderSweep(snapshot);
  clearTimeout(sweepTimer);
  if (snapshot.running) sweepTimer = setTimeout(pollSweep, 1200);
}

async function startSweep() {
  const snapshot = await (await fetch("/api/sweep/start?limit=1665")).json();
  state.sweep = snapshot;
  renderSweep(snapshot);
  clearTimeout(sweepTimer);
  sweepTimer = setTimeout(pollSweep, 800);
}

async function resumeSweep() {
  const snapshot = await (await fetch("/api/sweep/status")).json();
  state.sweep = snapshot;
  renderSweep(snapshot);
  if (snapshot.running) {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(pollSweep, 1200);
  } else if (!snapshot.done) {
    startSweep();
  }
}

async function runMultiView() {
  if (!HAS_API) return runMultiStatic();
  runMulti();
  resumeSweep();
}

async function runCdn() {
  if (!HAS_API) return runCdnStatic();
  const body = $("#cdn-body");
  body.innerHTML = cells(["…"]);
  try {
    const rows = await (await fetch("/api/cdn")).json();
    body.innerHTML = rows
      .map((r) =>
        r.ok
          ? cells([r.name, r.node, String(r.status), `${r.ms} ms`])
          : cells([r.name, t(lang, "failed"), "", ""], "bad"),
      )
      .join("");
  } catch {
    body.innerHTML = cells([t(lang, "failed")], "bad");
  }
}

async function runDns() {
  if (!HAS_API) return runDnsStatic();
  const body = $("#dns-body");
  body.innerHTML = cells(["…"]);
  try {
    const rows = await (await fetch("/api/dns")).json();
    body.innerHTML = rows
      .map((r) =>
        r.ok
          ? cells([r.name, r.exitIp, r.country ?? "", r.city ?? "", `${r.ms} ms`])
          : cells([r.name, t(lang, "failed"), "", "", ""], "bad"),
      )
      .join("");
  } catch {
    body.innerHTML = cells([t(lang, "failed")], "bad");
  }
}

function stunProbe(server, timeout = 8000) {
  return new Promise((resolve) => {
    let settled = false;
    const pc = new RTCPeerConnection({ iceServers: [{ urls: `stun:${server}` }] });
    const done = (ip) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch {
        /* already closed */
      }
      resolve(ip);
    };
    const timer = setTimeout(() => done(null), timeout);
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return done(null);
      const m = /\s([\d.]+|\[?[0-9a-fA-F:]+\]?)\s+\d+\s+typ\s+srflx/.exec(candidate.candidate);
      if (m) done(m[1].replace(/^\[|\]$/g, ""));
    };
    pc.createDataChannel("probe");
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => done(null));
  });
}

async function runStun() {
  const body = $("#stun-body");
  body.innerHTML = STUN_SERVERS.map((s) => cells([s, "…", "", ""])).join("");
  await Promise.all(
    STUN_SERVERS.map(async (server, index) => {
      const ip = await stunProbe(server);
      const geo = ip ? await geoOf(ip) : null;
      body.children[index].outerHTML = cells(
        [server, ip ?? t(lang, "failed"), geo?.country ?? "", geo?.city ?? ""],
        ip ? "" : "text-bad",
      );
    }),
  );
}

async function initHome() {
  if (state.homeReady) return;
  state.homeReady = true;
  measureAll();
  const ip = await detectIp();
  if (!ip) {
    $("#ip").textContent = t(lang, "failed");
    return;
  }
  const preset = new URLSearchParams(location.search).get("ip");
  $("#q").value = preset ?? "";
  await lookup(preset ?? ip);
}

const VIEW_LOADERS = { split: runSplit, multi: runMultiView, cdn: runCdn, dns: runDns, stun: runStun };

async function detectApi() {
  try {
    HAS_API = (await fetch("/api/targets", { cache: "no-store" })).ok;
  } catch {
    HAS_API = false;
  }
  if (!HAS_API) {
    for (const el of $$("[data-server]")) el.hidden = true;
  }
}

const currentPath = () => {
  if (HAS_API) return location.pathname;
  const hash = location.hash.replace(/^#\/?/, "");
  return hash ? `/${hash}` : "/";
};

function route() {
  const path = currentPath();
  const view = VIEW_OF_PATH[path] ?? "home";
  state.view = view;
  document.title = `${t(lang, TITLE_OF_VIEW[view])} · ipcheck`;
  for (const section of $$("[data-view]")) section.hidden = section.dataset.view !== view;
  for (const link of $$(".tabs a")) {
    if (new URL(link.href).pathname === path) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
  if (view === "home") initHome();
  else if (!started[view]) {
    started[view] = true;
    VIEW_LOADERS[view]();
  }
  window.scrollTo(0, 0);
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-route]");
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute("href");
  if (HAS_API) {
    history.pushState({}, "", href);
    route();
  } else {
    location.hash = `#${href}`;
  }
});

document.addEventListener("click", (event) => {
  const row = event.target.closest("button[aria-expanded]");
  if (!row || !row.closest("#found-list, #probe-tree")) return;
  const node = row.parentElement;
  const open = row.getAttribute("aria-expanded") === "true";
  row.setAttribute("aria-expanded", String(!open));
  node.querySelector("div").hidden = open;
  const cc = node.dataset.cc;
  if (!cc) return;
  if (open) openCountries.delete(cc);
  else {
    openCountries.add(cc);
    loadCountryLabels(node);
  }
});

window.addEventListener("popstate", route);
window.addEventListener("hashchange", route);

$("#copy").addEventListener("click", async () => {
  if (!state.ip) return;
  try {
    await navigator.clipboard.writeText(state.ip);
    const btn = $("#copy");
    btn.textContent = t(lang, "copied");
    setTimeout(() => (btn.textContent = t(lang, "copy")), 1200);
  } catch {
    /* clipboard blocked; the address stays selectable */
  }
});

$("#lookup").addEventListener("submit", (event) => {
  event.preventDefault();
  const ip = $("#q").value.trim();
  if (ip) lookup(ip);
});

$("#reset").addEventListener("click", async () => {
  $("#q").value = "";
  const ip = await detectIp();
  if (ip) lookup(ip);
});

$("#split-run").addEventListener("click", runSplit);
$("#sweep-run").addEventListener("click", () => {
  if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
  startSweep();
});

$("#multi-filter").addEventListener("input", () => {
  const q = $("#multi-filter").value;
  if (state.multi) renderFound(state.multi, q);
  if (state.sweep) renderProbeTree(state.sweep, q);
});

$("#multi-export").addEventListener("click", () => {
  const rows = state.multi?.rows ?? [];
  const cell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const csv = ["source,ip,country,city", ...rows.map((r) => [r.name, r.ip, r.country ?? "", r.city ?? ""].map(cell).join(","))];
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv.join("\n")], { type: "text/csv" }));
  a.download = "multi.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#sweep-export").addEventListener("click", async () => {
  const res = await fetch("/api/sweep/export");
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "sweep.csv";
  a.click();
  URL.revokeObjectURL(a.href);
});

$("#theme").addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark", true);
});

darkMedia.addEventListener("change", (event) => {
  if (!localStorage.getItem(STORE_THEME)) setTheme(event.matches ? "dark" : "light", false);
});

for (const btn of $$("[data-lang]")) {
  btn.addEventListener("click", () => {
    lang = btn.dataset.lang;
    localStorage.setItem(STORE_LANG, lang);
    applyLanguage();
  });
}

applyLanguage();
detectApi().then(route);
