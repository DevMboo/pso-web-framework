// Runs INSIDE the Linux container: like apply.mjs, but the shell is served over TLS (certificate and key mounted under /certs).
import { applyProxy, renderStaticConfig, targetFor } from "/app/deploy/dist/agent/nginx.js";
import { activateFei } from "/app/node_modules/@pso/frontend/dist/release.js";

const [release, version] = process.argv.slice(2);
const policy = { nginxPrivilege: "direct", nginxManagedDir: "/etc/nginx/pso.d", nginxLayout: "pso.d" };
const decl = { listen: { http: 8080, https: 8443 }, domains: ["shop.test"], tls: { certificate: "/certs/leaf.pem", key: "/certs/leaf.key" } };
const content = renderStaticConfig({ app: "shop-fei", release, site: "/site", fei: { basePath: "/shop/", routes: ["/catalog/sku/:id"], api: { path: "/api", upstreamPort: 3999 } }, nginx: decl, probePort: 8081 });
const target = targetFor(policy, "shop-fei");
activateFei("/site", version, "publish", "container");
const r = applyProxy("/tmp/agent-home", policy, target, "shop-fei", content, `d-${release}`);
console.log(JSON.stringify({ changed: r.changed, reloaded: r.reloaded, error: r.error ?? null, restored: r.restored ?? false }));
process.exit(r.error ? 1 : 0);
