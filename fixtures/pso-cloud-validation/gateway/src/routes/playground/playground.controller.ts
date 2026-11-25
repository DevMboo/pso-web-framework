import { Controller, RestController, Get, Param, Res } from "@pso/http";
import { ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Serves the static files of the Commerce web playground from <release>/web (copied there by the fixture's packaging step) and
 * `routes.json`, built from the release's own route metadata (<release>/pso-release.json): the page never lists an endpoint the release does not publish.
 * Only the names below are served: there is no path to traverse and no directory listing.
 */
const ASSETS: Record<string, string> = {
  "index.html": "text/html; charset=utf-8", "styles.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8", "http.js": "text/javascript; charset=utf-8", "channels.js": "text/javascript; charset=utf-8", "ui.js": "text/javascript; charset=utf-8", "icons.js": "text/javascript; charset=utf-8",
};
const RELEASE_DIR = resolve(__dirname, "..", "..", "..");
const HEADERS = {
  "cache-control": "no-cache", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "cross-origin-opener-policy": "same-origin", "permissions-policy": "camera=(), microphone=(), geolocation=()",
  // no inline script or style, no third-party origin; the page may talk only to its own origin (HTTPS and WSS)
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' wss:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

interface PublishedRoute { id: string; method: string; path: string; service?: string; services?: string[]; scopes?: string[]; public?: boolean }

@Controller()
@RestController("/playground")
export class PlaygroundController {
  @Get("/")
  index(@Res() res: ServerResponse): void { this.serve(res, "index.html"); }

  @Get("/:asset")
  asset(@Param("asset") name: string, @Res() res: ServerResponse): void {
    if (name === "routes.json") return this.routes(res);
    this.serve(res, name);
  }

  private serve(res: ServerResponse, name: string): void {
    const type = Object.hasOwn(ASSETS, name) ? ASSETS[name] : undefined; const file = join(RELEASE_DIR, "web", name);
    if (!type || !existsSync(file)) { res.writeHead(404, { ...HEADERS, "content-type": "text/plain; charset=utf-8" }); res.end("not found"); return; }
    const body = readFileSync(file); res.writeHead(200, { ...HEADERS, "content-type": type, "content-length": body.length }); res.end(body);
  }

  private routes(res: ServerResponse): void {
    const f = join(RELEASE_DIR, "pso-release.json");
    if (!existsSync(f)) { res.writeHead(503, { ...HEADERS, "content-type": "application/json" }); res.end(JSON.stringify({ error: "this release carries no route metadata (pso-release.json)" })); return; }
    const meta = JSON.parse(readFileSync(f, "utf8")) as { generatedAt?: string; routes?: Array<PublishedRoute & { active?: boolean }> };
    const routes = (meta.routes ?? []).filter((r) => r.active !== false && r.public !== true).map((r) => ({ id: r.id, method: r.method, path: r.path, service: r.service ?? "", services: r.services ?? [], scopes: r.scopes ?? [] }));
    const body = JSON.stringify({ source: "pso-release.json", generatedAt: meta.generatedAt ?? null, routes });
    res.writeHead(200, { ...HEADERS, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) }); res.end(body);
  }
}
