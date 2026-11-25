import { HOST, SSH_KEY, SSH_USER } from "./config.mjs";
import { spawnSync } from "node:child_process"; import { readFileSync } from "node:fs"; import { homedir } from "node:os"; import { join } from "node:path";
const r = spawnSync("ssh", ["-i", `${SSH_KEY}`, "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", `UserKnownHostsFile=${join(homedir(), ".pso-cloud", "known_hosts")}`, `${SSH_USER}@${HOST}`, "bash -s"], { input: readFileSync(new URL("./pids.sh", import.meta.url), "utf8"), encoding: "utf8" });
if (!r.stdout.trim()) console.error(r.stderr.slice(0, 300)); console.log(JSON.stringify(Object.fromEntries(r.stdout.trim().split("\n").map((l) => l.split(" ")))));
