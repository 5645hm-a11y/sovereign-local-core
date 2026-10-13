import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".wasm": "application/wasm", ".map": "application/json" };
const port = Number(process.env.LOCAL_CORE_PORT ?? 4173);
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    const route = url.pathname === "/" ? "examples/index.html" : decodeURIComponent(url.pathname).slice(1);
    const fixture = { "examples/index.html": "tests/fixtures/browser/index.html", "examples/p2p.html": "tests/fixtures/browser/p2p.html", "examples/policy.html": "tests/fixtures/browser/policy.html", "tests/fixtures/row-replay-worker.mjs": "tests/fixtures/row-replay-worker.mjs" }[route];
    const pathname = fixture ?? route;
    if (!(fixture || pathname.startsWith("dist/"))) {
      response.writeHead(404).end(); return;
    }
    const file = resolve(root, pathname);
    if (!file.startsWith(root + sep)) { response.writeHead(403).end(); return; }
    const body = await readFile(file);
    response.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch { response.writeHead(404).end(); }
});
server.listen(port, "127.0.0.1", () => console.log(`Core browser test fixtures: http://127.0.0.1:${port}`));
