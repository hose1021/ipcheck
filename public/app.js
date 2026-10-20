import { LANGS, t } from "./i18n.js";
import { TARGETS } from "./targets.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const STORE_LANG = "ipcheck-lang";
const STORE_THEME = "ipcheck-theme";
const RUNS = 12;
const AVAILABILITY_RUNS = 3;

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

const SITE_ICONS = {
  "oxu.az": "news",
  "apa.az": "news",
  "trend.az": "news",
  "azercell.com": "device-mobile",
  "bakcell.com": "device-mobile",
  "nar.az": "device-mobile",
  "turbo.az": "car",
  "google.com": "brand-google",
  "youtube.com": "brand-youtube",
  "cloudflare.com": "brand-cloudflare",
  "github.com": "brand-github",
  "telegram.org": "brand-telegram",
  "whatsapp.com": "brand-whatsapp",
  "instagram.com": "brand-instagram",
  "facebook.com": "brand-facebook",
  "tiktok.com": "brand-tiktok",
  "x.com": "brand-x",
  "linkedin.com": "brand-linkedin",
  "reddit.com": "brand-reddit",
  "snapchat.com": "brand-snapchat",
  "pinterest.com": "brand-pinterest",
  "steampowered.com": "brand-steam",
  "steamcommunity.com": "brand-steam",
  "epicgames.com": "device-gamepad-2",
  "ea.com": "device-gamepad-2",
  "battle.net": "swords",
  "riotgames.com": "device-gamepad-2",
  "gog.com": "device-gamepad-2",
  "playstation.com": "simple-icons:playstation",
  "chatgpt.com": "brand-openai",
  "claude.ai": "sparkles",
  "gemini.google.com": "brand-google",
  "grok.com": "sparkles",
  "perplexity.ai": "sparkles",
  "deepseek.com": "brain",
};

let lang = localStorage.getItem(STORE_LANG);
if (!LANGS.includes(lang)) lang = "ru";

const state = { ip: null, data: null, view: "home", homeReady: false };
const started = { stun: false };

const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const displayName = (name) => name.replace(/^(www|web)\./, "");

const cells = (values, cls = "") =>
  `<tr${cls ? ` class="${cls}"` : ""}>${values.map((v) => `<td>${v === null || v === undefined || v === "" ? "—" : esc(v)}</td>`).join("")}</tr>`;

/* ---------- theme ---------- */

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

/* ---------- icons ---------- */

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

const iconSvg = (name) => {
  const ref = SITE_ICONS[displayName(name)] ?? "world";
  const key = ref.includes(":") ? ref : `tabler:${ref}`;
  const body = iconBodies.get(key) ?? iconBodies.get("tabler:world");
  if (!body) return "";
  const paint = key.startsWith("simple-icons:")
    ? 'fill="currentColor"'
    : 'fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
  return `<span class="lead"><svg viewBox="0 0 24 24" width="15" height="15" ${paint}>${body}</svg></span>`;
};

/* ---------- language ---------- */

function applyLanguage() {
  document.documentElement.lang = lang;
  for (const el of $$("[data-i18n]")) el.textContent = t(lang, el.dataset.i18n);
  $("#q").placeholder = t(lang, "placeholder");
  for (const b of $$("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
  document.title = `${t(lang, state.view === "stun" ? "stunTitle" : "title")} · ipcheck`;
  setTheme(document.documentElement.dataset.theme === "dark" ? "dark" : "light", false);
  if (state.data) render(state.data);
}

/* ---------- lookup ---------- */

function fact(label, value) {
  if (!value) return "";
  return `<div><dt>${t(lang, label)}</dt><dd>${value}</dd></div>`;
}

const countryCode = (code) => (typeof code === "string" && /^[A-Za-z]{2}$/.test(code) ? code.toUpperCase() : "");

const REGION_LOCALE = { ru: "ru", az: "en" };

const regionName = (cc) => {
  try {
    const names = new Intl.DisplayNames([REGION_LOCALE[lang] ?? "en"], { type: "region", fallback: "code" });
    return names.of(cc) ?? cc;
  } catch {
    return cc;
  }
};

function render(data) {
  const primary = data.primary;
  $("#ip").textContent = data.ip;
  if (!primary) {
    $("#facts").innerHTML = `<div><dd class="err">${t(lang, "failed")}</dd></div>`;
  } else {
    $("#facts").innerHTML = [
      fact(
        "country",
        primary.country
          ? `${primary.countryCode ? `<span class="cc">${countryCode(primary.countryCode)}</span>` : ""}${esc(primary.country)}`
          : "",
      ),
      fact("city", esc(primary.city)),
      fact("isp", esc(primary.isp ?? primary.org)),
      fact("asn", primary.asn ? `AS${esc(primary.asn)}` : ""),
      fact("timezone", esc(primary.timezone)),
      fact("coords", primary.lat !== undefined && primary.lon !== undefined ? `${primary.lat}, ${primary.lon}` : ""),
    ].join("");
  }
  $("#sources").innerHTML = data.sources
    .map((s) =>
      s.ok
        ? cells([s.name, s.country, s.city, s.isp ?? s.org, s.asn ? `AS${s.asn}` : "—"])
        : cells([s.name, `${t(lang, "error")}: ${s.error}`, "", "", ""], "bad"),
    )
    .join("");
}

const fetchJson = async (url) => {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
};

async function lookup(ip) {
  state.ip = ip;
  $("#ip").textContent = t(lang, "loading");
  const query = encodeURIComponent(ip);
  const sources = await Promise.all([
    fetchJson(`https://ipwho.is/${query}`)
      .then((j) =>
        j.success
          ? {
              name: "ipwho.is",
              ok: true,
              ip: j.ip,
              country: j.country,
              countryCode: j.country_code,
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
  state.data = { ip, primary: sources.find((s) => s.ok) ?? null, sources };
  render(state.data);
}

async function detectIp() {
  try {
    const j = await (await fetch("https://api.ipify.org?format=json", { cache: "no-store" })).json();
    if (typeof j?.ip === "string") return j.ip;
  } catch {
    /* fall through to the providers */
  }
  try {
    const j = await fetchJson("https://ipwho.is/");
    if (typeof j?.ip === "string") return j.ip;
  } catch {
    return null;
  }
  return null;
}

/* ---------- latency ---------- */

const latencyState = (ms) =>
  ms === null ? "fail" : ms < 90 ? "l90" : ms < 150 ? "l150" : ms < 250 ? "l250" : "lomg";

const dots = (count = RUNS) =>
  `<span class="dots" aria-hidden="true">${Array.from({ length: count }, () => `<i data-state="pending"></i>`).join("")}</span>`;

const statusBadge = (ok) =>
  `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"${
    ok === null ? ' opacity=".35"' : ""
  }/><path d="${
    ok === null ? "M9 12h6" : ok ? "M7.8 12.4l2.7 2.7 5.7-6.1" : "M9 9l6 6M15 9l-6 6"
  }" fill="none" stroke="var(--card)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

async function probeOnce(url) {
  const started = performance.now();
  try {
    await fetch(url, { mode: "no-cors", cache: "no-store", signal: AbortSignal.timeout(6000) });
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

  if (!measured.length) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    for (let i = 0; i < AVAILABILITY_RUNS; i++) await sample(i);
  }

  if (!measured.length) {
    cell.textContent = "—";
    cell.dataset.state = "fail";
  }
}

async function checkTarget(target, item) {
  const cell = item.querySelector(".ms");
  let reachable = false;
  for (let i = 0; i < AVAILABILITY_RUNS && !reachable; i++) reachable = (await probeOnce(target.url)) !== null;
  // CORP-protected hosts never expose the response, so the result is unknown.
  cell.innerHTML = statusBadge(reachable ? true : null);
  cell.dataset.state = reachable ? "l90" : "fail";
}

async function measureAll() {
  await loadIcons();
  for (const group of ["az", "world", "social", "ai", "games"]) {
    const list = document.getElementById(`latency-${group}`);
    const items = TARGETS.filter((x) => x.group === group);
    const availabilityOnly = group === "social" || group === "ai" || group === "games";
    list.innerHTML = items
      .map(
        ({ name }) =>
          `<li>${iconSvg(name)}<span class="name">${esc(displayName(name))}</span><span class="ms" data-host="${esc(name)}">…</span>${
            availabilityOnly ? "" : dots()
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

/* ---------- STUN ---------- */

const geoOf = async (ip) => {
  try {
    const j = await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}`);
    return j.success ? { country: j.country, city: j.city } : null;
  } catch {
    return null;
  }
};

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
  body.innerHTML = STUN_SERVERS.map((server) => cells([server, "…", "", ""])).join("");
  await Promise.all(
    STUN_SERVERS.map(async (server, index) => {
      const ip = await stunProbe(server);
      const geo = ip ? await geoOf(ip) : null;
      body.children[index].outerHTML = cells(
        [server, ip ?? t(lang, "failed"), geo?.country ?? "", geo?.city ?? ""],
        ip ? "" : "bad",
      );
    }),
  );
}

/* ---------- router ---------- */

const VIEW_OF_PATH = { "/": "home", "/stun": "stun" };

const currentPath = () => {
  const hash = location.hash.replace(/^#\/?/, "");
  return hash ? `/${hash}` : "/";
};

function route() {
  const path = currentPath();
  const view = VIEW_OF_PATH[path] ?? "home";
  state.view = view;
  document.title = `${t(lang, view === "stun" ? "stunTitle" : "title")} · ipcheck`;
  for (const section of $$("[data-view]")) section.hidden = section.dataset.view !== view;
  for (const link of $$(".tabs a")) {
    link.classList.toggle("active", link.getAttribute("href") === `#${path}`);
  }
  if (view === "home") initHome();
  else if (!started.stun) {
    started.stun = true;
    runStun();
  }
  window.scrollTo(0, 0);
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

/* ---------- wiring ---------- */

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

window.addEventListener("hashchange", route);

applyLanguage();
route();
