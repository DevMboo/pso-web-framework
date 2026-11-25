// Runs INSIDE the linux-tools container: the real Java dependency scan adapter with the real OSV-Scanner binary and the live osv.dev database.
import { mkdirSync, writeFileSync } from "node:fs";
import { scanJava } from "/src/src/agent/javascan.ts";

const pom = (version: string) => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.example</groupId><artifactId>scan-probe</artifactId><version>1.0.0</version>
  <dependencies>
    <dependency><groupId>org.apache.logging.log4j</groupId><artifactId>log4j-core</artifactId><version>${version}</version></dependency>
  </dependencies>
</project>
`;
const dir = (name: string, version: string): string => { const d = `/tmp/scan/${name}`; mkdirSync(d, { recursive: true }); writeFileSync(`${d}/pom.xml`, pom(version)); return d; };
const empty = "/tmp/scan/empty"; mkdirSync(empty, { recursive: true }); writeFileSync(`${empty}/README.txt`, "no Java here");
const summary = (r: ReturnType<typeof scanJava>) => ({ status: r.status, version: r.version, packages: r.packages, counts: r.counts, ids: r.findings.map((f) => f.id), aliases: r.findings.flatMap((f) => [f.id, ...((f as { aliases?: string[] }).aliases ?? [])]), note: r.note, database: r.database?.source });
console.log(JSON.stringify({
  vulnerable: summary(scanJava(dir("vulnerable", "2.14.1"), { blockSeverity: "high", timeoutMs: 180_000 })),
  patched: summary(scanJava(dir("patched", "2.25.3"), { blockSeverity: "high", timeoutMs: 180_000 })),
  reportOnly: summary(scanJava(dir("report-only", "2.14.1"), { blockSeverity: "none", timeoutMs: 180_000 })),
  empty: summary(scanJava(empty, { blockSeverity: "high", timeoutMs: 60_000 })),
}));
