# ipcheck

A small, browser-only network check page in Russian and Azerbaijani: your public
IP, geolocation from three providers, latency to Azerbaijani and world sites,
availability of social, AI and gaming services, and your IP as STUN servers see
it.

Every check runs in the visitor's browser. There is no backend, no build step and
no dependency at runtime.

## Run

```sh
bun start          # static preview on http://localhost:3000
```

Any static file server works: the site is the `public/` folder.

## What it shows

- **My IP** — detected through `api.ipify.org`; country, city, provider and ASN
  come from `ipwho.is`, `ipapi.is` and `ipinfo.io` in parallel, so differences
  between the databases stay visible. Any other address can be checked in the
  form.
- **Latency** — twelve `no-cors` requests per site with a dot per sample and a
  live average. Bands: under 90, 150, 250 ms and slower.
- **Availability** — social, AI and gaming sites get three attempts and a round
  badge. These groups show no timings: the question there is reachable or not.
- **STUN** — one WebRTC data channel per server; the table shows the address the
  server sees, which is the UDP path and can differ from HTTP.

## Structure

```
public/index.html   markup for both views
public/app.js       probing, rendering, language and theme
public/targets.js   the site list shared by every group
public/i18n.js      RU and AZ strings
public/style.css    light and dark themes, latency scale
serve.ts            local static preview
```

## Limits

- A page cannot read a cross-origin response without CORS, and cannot see
  `Cross-Origin-Resource-Policy`-protected ones at all. Hosts such as
  `instagram.com`, `x.com` or `claude.ai` send `CORP: same-origin`, so their
  availability is shown as a grey dash — honest "cannot tell" instead of a false
  green mark.
- Some hosts hide behind redirect loops or block the request (`apa.az` sends
  `CORP: same-site`), which is why the latency list holds `turbo.az`.
- Latency here is the browser's round trip, not ICMP ping: DNS, TLS and HTTP
  layers are included.
- A vendor without a Tabler icon uses `simple-icons` (playStation) or a generic
  glyph.

## Deploy

`.github/workflows/pages.yml` publishes `public/` to GitHub Pages on every push
to `main`. Locally `bun start` serves the same files.
