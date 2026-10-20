# Repository Guidelines

Self-hosted IP lookup page (RU + AZ UI), a clean-room take on `ip.skk.moe`. Shows
public IP, country/city/provider/ASN from two independent providers side-by-side,
arbitrary-IP lookup, and per-site latency. Also: split-tunnel exit-IP view,
multi-egress view with a Speedtest-server reachability sweep, CDN edge-node
lookup, resolver exit-IP lookup, and a browser-STUN view. No auth, no CI test
step, no build step.

## Architecture & Data Flow

Two execution modes share one frontend:

- **Live server** (`bun start`): Bun serves `public/` statically plus `/api/*`.
- **Static build**: `.github/workflows/pages.yml` publishes `public/` verbatim on
  push to `main`. `app.js` self-detects a missing `/api/targets`, switches to
  direct CORS provider calls, hash routing (`#/`), hides the four server-only
  tabs, and renders CORP-blocked hosts as grey `—`.

```
Browser (index.html + app.js ES module)
  boot: applyLanguage(); detectApi() → GET /api/targets → HAS_API; route()
  Home: detectIp() → api.ipify.org (fallback /api/client-ip)
        lookup(ip) → GET /api/lookup?ip=   (or direct ipwho.is/ipapi.is/ipinfo.io in static mode)
        measureAll() → GET /api/targets → browser timing/availability probes
  Views: split|multi+sweep|cdn|dns → respective /api endpoints
         stun → browser RTCPeerConnection, then /api/lookup per discovered IP
Bun server (server.ts, createServer → Bun.serve({port, fetch}))
  fetch: API handlers → APP_ROUTES → static file from public/ → 404
  lookup(ip): 60 s in-memory cache, Promise.all(ipapi.is https ∥ ipwho.is),
              each failure wrapped → {ip, primary, sources:[{name,ok,error}...]}
  probes: probeCdn/echoProbe/splitProbe/dnsExit/startSweep (see Key Modules)
```

- **Provider normalization**: both providers map into one `Lookup` shape
  (`country, countryCode, region, city, isp, org, asn, timezone, lat, lon`).
  zod schemas (`IpApiResponse`, `IpwhoResponse`, `ProbeList`) validate raw API
  responses; field mapping is hand-written after `parseIpApi`/`parseIpwhois`.
- **Geo enrichment**: every discovered IP (CDN, DNS, split, STUN) is passed back
  through `lookup().primary`.
- **Limits**: `/api/lookup` is rate-limited (60/min per client, fixed window,
  socket address via `server.requestIP`, falls back to `clientIp`).
  `rateLimit` is exported with a capacity cap (10k keys, oldest evicted; the
  `hits` Map is injectable for tests). Lookup cache is capped at `CACHE_MAX`
  (5k, oldest evicted on insert). No auth, no method/CORS handling. Sweep is
  one module-level global (one per process). `clientIp` trusts three headers
  verbatim and only filters `::1`/`127.*`.
- **Security headers**: every response gets `SECURITY_HEADERS` (CSP with the
  sha256 of the inline theme script in `public/index.html` — bump both
  together, `x-content-type-options`, `x-frame-options`, `referrer-policy`,
  `permissions-policy`, `cross-origin-opener-policy`). Server-only header set;
  the static Pages build has none.

## Key Directories

- `server.ts` — Bun server entry point: routes, provider normalization, lookup
  cache, all probes. Exports `parseIpapi`, `parseIpwhois`, `clientIp`,
  `edgeNode`, `rateLimit`, `createServer`.
- `server.test.ts` — Bun test for the pure exported helpers; sits next to
  `server.ts`, imports it by relative path.
- `public/` — the whole static site, shipped as-is:
  - `index.html` — single document, all views as `<section data-view="...">`.
  - `app.js` — SPA: router, i18n/theme application, all rendering, all
    client-side probes. No exports.
  - `i18n.js` — `STRINGS {ru, az, en}`, `LANGS`, `t(lang, key)`.
  - `targets.js` — `TARGETS` list, shared by server and static build.
  - `style.css` — GENERATED from `tailwind.css`; do not edit by hand.
- `tailwind.css` — Tailwind v4 input: `@theme` tokens (colors, fonts), dark
  overrides under `[data-theme="dark"]`, `[hidden]` rule, progress pseudo bars.
- `.github/workflows/pages.yml` — static deploy to GitHub Pages.
- `bun.lock`, `package.json`, `README.md`, `.gitignore`.

## Development Commands

```sh
bun install          # install deps (zod 4.6.7 + Tailwind CLI)
bun run build:css    # tailwind.css -> public/style.css
bun run watch:css    # rebuild stylesheet on change
bun start            # = bun run server.ts; http://localhost:3000
PORT=8080 bun start  # override port (default 3000)
bun test             # bun:test, discovers *.test.ts
bun test server.test.ts      # single file
bun test -t "edgeNode"       # filter by describe/test name
```

There is no `test`/`build`/`dev`/`lint` npm script and no tsconfig — `bun run
server.ts` **is** the app pipeline. CSS is the one generated artifact: edit
`tailwind.css` or the utility classes, then run `build:css` (or `watch:css`);
`public/style.css` is generated and must be rebuilt after markup changes.
Runtime is **Bun**, package manager **Bun** (lockfile `bun.lock`).

Because there is no bundler/transpiler: edits to `public/*.js|css|html` take
effect immediately on refresh; only `server.ts` needs a Bun-process restart
(there is no HMR). Test files are run by `bun test` but are **not** wired into
CI — the Pages workflow has no test step.

## Code Conventions & Common Patterns

- **Language**: repo files and comments are English; the RU/AZ/EN strings live
  only inside `public/i18n.js`.
- **Styling**: Tailwind v4 utilities in the markup and in `app.js` template
  strings. Design tokens are `@theme` variables in `tailwind.css`
  (`bg`, `card`, `fg`, `muted`, `line`, `accent`, `bad`, `warn`, `lat90..latomg`);
  dark mode overrides those variables under `[data-theme="dark"]`. Custom
  classes exist only as JS hooks (`tabs`, `ms`, `dots`) or where utilities
  cannot reach (`[hidden]`, progress pseudo-elements). No `@apply`, no BEM.
- **Naming**: flat, lowercase identifiers (`groups`, `sources`, `cells`). No
  interfaces-with-one-impl, no generics; zod is validation-only, never `z.infer`.
- **State**: module-scope mutable `state` object + `started` per-view flags in
  `app.js`; conditional in module/global scope (not React-like re-render).
- **Error handling**: providers throw on `status !== "success"` / `!success`;
  the caller (`lookup`) wraps failure into `{name, ok:false, error}` rather than
  aborting. Probes return `null` fields on failure. Frontend `fetchJson` throws
  on `!res.ok`.
- **Async**: `Promise.all` for independent provider/probe calls; fire-and-forget
  async worker pools for the sweep; browser timing probes use `fetch` with
  `cache:"no-store"`, `mode:"no-cors"`, `credentials:"omit"`.
- **Namespacing**: server and static build share `public/targets.js` by design —
  one list drives both. Keep it plain JS with no types.

## Important Files

- `server.ts` — exports and constants to know before editing:
  - `PORT`, `PUBLIC_DIR`, `CACHE_MS = 60_000`, `APP_ROUTES`
    (`/, /split-tunnel, /cdn-node-lookup, /dns-exit-lookup, /stun, /multi, /query`).
  - `SOURCES = [{name:"ipapi.is", fn: fromIpapi}, {name:"ipwho.is", fn: fromIpwhois}]`.
  - `CDN_PROBES` (7), `ECHO_SERVICES` (9), `SPLIT_SITES` (48), `RESOLVERS` (8).
  - `SPEEDTEST_LIST`, `SWEEP_CONCURRENCY = 40`, `SWEEP_TIMEOUT_MS = 2500`.
- **API routes** (all GET, no method checks, order matters):
  - `/api/client-ip` → `{ip}`; `/api/targets` → `TARGETS` (`no-store`);
    `/api/cdn` → `[{name, ok, status, ms, node, via}]`;
    `/api/dns` → `[{name, server, ok, ms, exitIp, ...geo}]`;
    `/api/multi` → `{unique, rows}`;
    `/api/sweep/status|start?limit=|country?cc=|export` (CSV attachment); guard `start` limit, clamped `[1,1801]`;
    `/api/split` → `[{group, name, exitIp, reachable, status, ms, ...geo}]`;
    `/api/lookup?ip=` → `400` if missing or `!/^[0-9a-fA-F:.]{3,45}$/`, else `lookup()`.
  - App routes → `index.html` (`no-cache`); other paths → `Bun.file` from
    `public/` if it exists, else `404 "not found"`.
- `public/app.js` — `VIEW_OF_PATH`, `TITLE_OF_VIEW`,
  `REGION_LOCALE = {ru:"ru", az:"en", en:"en"}`,
  `latencyState(ms)` → `fail|<90 l90|<150 l150|<250 l250|lomg`, `esc()`,
  `fact()`, `cells()`, `nodeHtml()`, `iconSvg()` via `api.iconify.design`.
  Static-mode loaders: `staticLookup`, `ECHO_STATIC`, `CDN_STATIC`,
  `DNS_STATIC`, `geoStatic`, `runMultiStatic`, `runCdnStatic`, `runDnsStatic`.
- `index.html` — inline pre-paint theme script (no flash), data-URI SVG favicon.
  All translatable text uses `data-i18n`.
- `targets.js` / `i18n.js` — shared/config-adjacent; see conventions below.

## Testing & QA

- Framework: **Bun's built-in `bun:test`** (`import { describe, expect, test }`).
  No dev dependencies.
- Scope: 4 `describe` blocks, 16 tests — only the pure exported helpers from
  `server.ts` (`parseIpapi`, `parseIpwhois`, `clientIp`, `edgeNode`,
  `rateLimit`). No live server, no network, no mocking/fixtures/snapshots.
- Conventions: `describe`/`test` (not `it`); one behavior per test with a
  plain-English sentence name; small local factory helpers (`probe = (headers)
  => edgeNode(new Headers(headers))`); `toMatchObject` for partial shapes,
  `toEqual` for exact objects, `toThrow("message")` for errors.
- Naming: test file mirrors source (`server.ts` → `server.test.ts`), sits in
  the same directory. Add tests for any new pure helper; not wired to CI.

## Runtime / Tooling Preferences

- **Runtime**: Bun only (no Node fallback; `node:dns/promises`, `Bun.serve`,
  `Bun.file`, `import.meta.main` are used).
- **Package manager**: Bun (`bun.lock`). Add deps with `bun add`, not npm.
- **Only CSS is generated** — no JS bundler/transpiler. `public/` is the Pages
  artifact; rebuild `style.css` after changing utility classes.
- **Static-mode discipline**: `/multi`, `/cdn-node-lookup` and
  `/dns-exit-lookup` have CORS-only implementations (`ECHO_STATIC`,
  `CDN_STATIC`, `DNS_STATIC` in `app.js`) and stay visible without an API.
  `/split-tunnel` is server-only (`data-server`). Blocks that need the server
  (sweep card, country tree) carry `data-server` and are hidden when
  `/api/targets` is absent. Keep both paths working when adding a feature.

## When You Change These

- **Add a translation**: add the key to **all three** `ru`, `az`, `en` objects
  in `public/i18n.js` (identical keys; `t()` falls back ru → raw key).
- **Add a latency probe**: add an entry to `TARGETS` in `public/targets.js`
  (`{group, name, url, check?}`); `group` ∈ `az, world, social, games, ai`.
  Server and frontend both consume it.
- **Add a CDN probe / resolver / split site**: extend `CDN_PROBES` /
  `RESOLVERS` / `SPLIT_SITES` in `server.ts`.
- **Change provider output shape**: update the hand-written mapping in
  `parseIpapi`/`parseIpwhois` and the matching `server.test.ts` cases.