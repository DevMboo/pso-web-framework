// Runs INSIDE the Linux container: the real managed adapter writes the shell's nginx file (backup, nginx -t, graceful reload) and the real
// release primitives activate the shell, exactly as the runtime agent does.
import { applyProxy, renderStaticConfig, targetFor } from "/app/deploy/dist/agent/nginx.js";
import { activateFei } from "/app/node_modules/@pso/frontend/dist/release.js";

const [release, version] = process.argv.slice(2);
const policy = { nginxPrivilege: "direct", nginxManagedDir: "/etc/nginx/pso.d", nginxLayout: "pso.d" };
const decl = { listen: { http: 8080 } };
const content = renderStaticConfig({ app: "shop-fei", release, site: "/site", fei: { basePath: "/shop/", routes: ["/catalog/sku/:id", "/files/*"], api: { path: "/api", upstreamPort: 3999 } }, nginx: decl });
const target = targetFor(policy, "shop-fei");
activateFei("/site", version, "publish", "container");
const r = applyProxy("/tmp/agent-home", policy, target, "shop-fei", content, `d-${release}`);
console.log(JSON.stringify({ changed: r.changed, reloaded: r.reloaded, error: r.error ?? null, restored: r.restored ?? false }));
process.exit(r.error ? 1 : 0);
