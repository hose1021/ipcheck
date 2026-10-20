// Static preview of the browser-only build; GitHub Pages serves the same files.
const dir = new URL("./public/", import.meta.url);
const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    const file = Bun.file(new URL(path, dir));
    if (await file.exists()) return new Response(file, { headers: { "cache-control": "no-cache" } });
    return new Response("not found", { status: 404 });
  },
});

console.log(`ipcheck on http://localhost:${port}`);
