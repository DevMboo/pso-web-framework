import { WORKSPACE, FRAMEWORK, HOST, SSH_KEY, SSH_USER } from "./config.mjs";
// Administrator step (PSO does not provision databases or brokers): roles, databases and a broker user with random passwords.
// Passwords travel on stdin only and are never printed.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const key = `${SSH_KEY}`;
const ssh = (script) => spawnSync("ssh", ["-i", key, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${join(homedir(), ".pso-cloud", "known_hosts")}`, `${SSH_USER}@${HOST}`, "bash -s"], { input: script, encoding: "utf8" });
const pw = () => randomBytes(18).toString("hex");
const pws = { customers: pw(), catalog: pw(), orders: pw(), rabbit: pw() };

let script = "set -eu\n";
for (const s of ["customers", "catalog", "orders"]) script += `sudo -u postgres psql -v ON_ERROR_STOP=1 -q <<'SQL'\nCREATE ROLE ${s} LOGIN PASSWORD '${pws[s]}';\nCREATE DATABASE ${s} OWNER ${s};\nSQL\n`;
script += `sudo rabbitmqctl add_user pso '${pws.rabbit}' >/dev/null && sudo rabbitmqctl set_permissions -p / pso '.*' '.*' '.*' >/dev/null && echo rabbit-user-ok\n`;
const r = ssh(script);
console.log("server side:", r.status === 0 ? "roles, databases and broker user created" : `FAILED ${r.status}\n${(r.stderr || "").replace(/'[0-9a-f]{36}'/g, "'***'")}`);
if (r.status !== 0) process.exit(1);

const PSO = [`${FRAMEWORK}/packages/cli/bin/pso.js`];
const secret = (app, name, value) => { const o = spawnSync(process.execPath, [...PSO, "environment:secret", app, name], { input: value, encoding: "utf8", cwd: `${WORKSPACE}` }); console.log(name, o.status === 0 ? "stored on the server" : `FAILED: ${(o.stderr || o.stdout).split("\n")[0]}`); };
console.log("(secrets are stored through `pso environment:secret`, value on stdin)");
for (const s of ["customers", "catalog", "orders"]) secret("shop-customers", `${s}-db-password`, pws[s]);
secret("shop-customers", "rabbitmq-url", `amqp://pso:${pws.rabbit}@127.0.0.1:5672`);
