// Runs INSIDE the container: the HOST application's managed nginx file (what a gateway deployment writes), with an attach point, through the real adapter.
import { applyProxy, attachDirFor, renderConfig, targetFor } from "/app/deploy/dist/agent/nginx.js";
const policy = { nginxPrivilege: "direct", nginxManagedDir: "/etc/nginx/pso.d", nginxLayout: "pso.d" };
const [release] = process.argv.slice(2);
const content = renderConfig({ app: "shop-gateway", release, services: [{ service: "gateway", ports: [3999], stablePort: 20003, route: { path: "/" } }], nginx: { listen: { http: 8080 }, websocket: true, attachPoint: true }, attachDir: attachDirFor(policy, "shop-gateway") });
const r = applyProxy("/tmp/agent-home", policy, targetFor(policy, "shop-gateway"), "shop-gateway", content, `host-${release}`);
console.log(JSON.stringify({ changed: r.changed, reloaded: r.reloaded, error: r.error ?? null }));
process.exit(r.error ? 1 : 0);
