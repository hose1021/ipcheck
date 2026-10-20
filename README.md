# ipcheck

Small self-hosted IP lookup page with Russian and Azerbaijani UI. Built as a
clean-room take on `ip.skk.moe`: same idea (my IP, geolocation, provider, ASN,
latency to popular sites), own implementation, no framework and no build step.

## Run

```sh
bun install
bun start          # http://localhost:3000
bun test           # provider normalization and client-IP parsing
```

`PORT` overrides the port (default `3000`).

## What it shows

- Your public IP, detected in the browser through `api.ipify.org`; when the app
  runs behind a proxy, `cf-connecting-ip` / `x-real-ip` / `x-forwarded-for` are
  used as a fallback.
- Country, city, provider and ASN from two independent providers, shown side by
  side so disagreements are visible.
- Lookup of any other IP through the form.
- Latency to six Azerbaijani and six global sites.

## Tools

| Page | What it does | Where it runs |
|---|---|---|
| `/` | My IP, geo, provider, ASN; latency for 6 Azerbaijani and 6 world sites, availability for 8 social, 6 AI and 8 gaming sites | browser + server |
| `/split-tunnel` | 46 sites in eight groups (Azerbaijan, China, world, games, AI, crypto, static, other); each Cloudflare-fronted site answers `/cdn-cgi/trace` with the exit IP it sees | server |
| `/multi` | Progress over 1665 Speedtest.net probes, the exit addresses found, and an expandable country → server tree | server |
| `/cdn-node-lookup` | Requests each CDN edge and reads `cf-ray` / `x-amz-cf-pop` / `x-served-by` / `server` | server |
| `/dns-exit-lookup` | Asks `whoami.akamai.net` through eight resolvers; the answer is each resolver's exit IP | server |
| `/stun` | One WebRTC data channel per STUN server; reports the address the server sees | browser |
| `/query?ip=8.8.8.8` | Same as `/`, prefilled with the given address | browser + server |

## API

| Route | Purpose |
|---|---|
| `GET /api/split` | Per-site exit IP from each site's own `/cdn-cgi/trace` |
| `GET /api/lookup?ip=8.8.8.8` | Both providers, merged; `primary` is the first success |
| `GET /api/targets` | Latency list used by the UI |
| `GET /api/cdn` | CDN edge nodes read from response headers |
| `GET /api/dns` | Resolver exit IPs plus their geo |
| `GET /api/multi` | Distinct exit addresses across nine echo services |
| `GET /api/sweep/start?limit=1665` | Starts the Speedtest.net reachability sweep (one at a time) |
| `GET /api/sweep/status` | Live progress, ok/fail counts and per-country totals |
| `GET /api/sweep/country?cc=TR` | Server names behind one country row (loaded on expand) |
| `GET /api/client-ip` | Client address as seen by the server, `null` on loopback |

## Structure

```
server.ts        Bun server: static files, lookup, latency, CDN, DNS
server.test.ts   provider normalization and header parsing
public/index.html  all views; the router shows one at a time
public/app.js      router, rendering, language switch, STUN probes
public/i18n.js     RU and AZ strings
public/style.css
```

## Static build (GitHub Pages)

`public/` is a complete static site. When `/api/targets` is absent the page
switches to static mode on its own:

- lookups go straight to `ipwho.is`, `ipapi.is` and `ipinfo.io` (all CORS-enabled);
- routing uses `#/stun` instead of real paths;
- server-only tabs (split tunnel, multi, CDN nodes, DNS exit) are hidden;
- a host whose `CORP` header hides the response shows a grey `—` badge instead
  of the server-checked mark.

`.github/workflows/pages.yml` publishes the folder on every push to `main`.

## Notes and limits

- Latency is measured in the browser, so the number describes the visitor's own
  route: twelve `no-cors` requests per site, one dot per sample, a failed sample
  retried once. A host that sends `Cross-Origin-Resource-Policy: same-site`
  (apa.az) cannot be timed from a page, which is why the latency list holds
  turbo.az instead. Social, AI and gaming sites only need a yes/no answer: three
  browser attempts, then a favicon load for hosts whose `CORP: same-origin`
  hides the response. The server is never asked — its route is not the
  visitor's — so a host that blocks both stays a grey dash.
- `/split-tunnel` reports two things per site: the exit IP, taken from the
  site's own `/cdn-cgi/trace`, and reachability, from a plain request to the
  origin. Sites without that path (alibaba.com, 163.com, bytedance.com,
  tencent.com, discord.com) answer the plain request, so they are marked
  `доступен` with `—` in the IP column; only a failed origin request marks a row
  `недоступен`.
- Akamai and CDN77 do not publish an edge code in a header; the table shows the
  server banner (`AkamaiNetStorage`, `CDN77-Turbo`) for them.
- `/multi` shows three blocks: progress over the 1665 probes, the exit
  addresses that the echo services reported (each expands to the services that
  saw it), and a country tree where every row expands to the Speedtest server
  names behind it. The original also splits probes by the exit IP they used;
  a browser and a plain HTTP probe cannot observe their own source address, and
  these servers never echo it, so this build keeps exit addresses and probe
  coverage separate instead of inventing that attribution.
- Some STUN servers silently drop requests from certain networks; a failed row
  is normal, not an error in the page.
- `ip-api.com` is queried over plain HTTP (free tier limitation); both providers
  have rate limits, so results are cached for 60 seconds per IP.
- Adding a translation means adding a key to both objects in `public/i18n.js`.
  Adding a latency probe means adding an entry to `TARGETS` in `server.ts`;
  a CDN or resolver is one entry in `CDN_PROBES` or `RESOLVERS`.
