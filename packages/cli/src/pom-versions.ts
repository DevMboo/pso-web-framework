/**
 * The versions of a Spring service that decide whether it may be deployed as a release.
 *
 * A generated pom.xml has three kinds of version: the Spring Boot parent (`<parent><version>`), the service's own `<version>`, and the
 * PSO artifacts it builds against (`<pso.version>`, used by the imported com.pso:pso-bom and so by every com.pso dependency). The
 * release rule is about the last two, and about any dependency pinned to a SNAPSHOT: a SNAPSHOT is a moving build, so two builds of
 * the "same" release can differ. The parent's version says nothing about that (reading it was the defect: a service on
 * pso.version 0.1.0-SNAPSHOT was accepted because Spring Boot 3.5.6 is not a SNAPSHOT).
 *
 * The file is read as text, without running Maven: `${property}` references are resolved from `<properties>` (and `${project.version}`);
 * what cannot be resolved that way is reported as unresolved instead of being assumed to be a release.
 */
export interface PomVersions {
  /** the service's own version (`<project><version>`), undefined when it is inherited from the parent */
  project: string | undefined;
  /** `<pso.version>`: the version of every com.pso artifact of the service */
  pso: string | undefined;
  /** why this build is not a release: one line per SNAPSHOT (or unresolved) version, naming where it comes from */
  snapshots: string[];
}

const strip = (xml: string, ...tags: string[]): string => tags.reduce((s, t) => s.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?</${t}>`, "g"), ""), xml);
const isSnapshot = (v: string): boolean => /-SNAPSHOT$/i.test(v.trim());

export function pomVersions(pomXml: string): PomVersions {
  const xml = pomXml.replace(/<!--[\s\S]*?-->/g, "");
  const properties = new Map<string, string>();
  const props = /<properties>([\s\S]*?)<\/properties>/.exec(strip(xml, "profiles"));
  for (const m of (props?.[1] ?? "").matchAll(/<([A-Za-z0-9_.-]+)>\s*([^<]*?)\s*<\/\1>/g)) properties.set(m[1]!, m[2]!);
  // the project's own coordinates: what is left once the nested sections that have a <version> of their own are removed
  const own = strip(xml, "parent", "dependencyManagement", "dependencies", "build", "profiles", "properties", "reporting", "distributionManagement");
  const projectRaw = /<version>\s*([^<]*?)\s*<\/version>/.exec(own)?.[1];
  const resolve = (v: string, depth = 0): string => (depth > 5 ? v : v.replace(/\$\{([^}]+)\}/g, (whole, name: string) => {
    const value = name === "project.version" || name === "pom.version" ? projectRaw : properties.get(name);
    return value === undefined ? whole : resolve(value, depth + 1);
  }));
  const project = projectRaw === undefined ? undefined : resolve(projectRaw);
  const psoRaw = properties.get("pso.version");
  const pso = psoRaw === undefined ? undefined : resolve(psoRaw);
  const snapshots: string[] = [];
  const unresolved = (v: string): boolean => /\$\{/.test(v);
  if (project !== undefined && isSnapshot(project)) snapshots.push(`the service's own version is ${project} (<version> of the project)`);
  else if (project !== undefined && unresolved(project)) snapshots.push(`the service's own version ${project} cannot be resolved without running Maven`);
  if (pso !== undefined && isSnapshot(pso)) snapshots.push(`the PSO artifacts are ${pso} (<pso.version>): a local development build of com.pso:*`);
  else if (pso !== undefined && unresolved(pso)) snapshots.push(`<pso.version> ${pso} cannot be resolved without running Maven`);
  // dependencies and plugins pinned to a SNAPSHOT (the parent is included: a SNAPSHOT parent is a moving build as well)
  for (const m of strip(xml, "properties").matchAll(/<(dependency|plugin|parent)>([\s\S]*?)<\/\1>/g)) {
    const block = m[2]!;
    const versionRaw = /<version>\s*([^<]*?)\s*<\/version>/.exec(strip(block, "dependencies", "exclusions", "configuration", "executions"))?.[1];
    if (versionRaw === undefined) continue;
    const version = resolve(versionRaw);
    if (!isSnapshot(version)) continue;
    const artifact = /<artifactId>\s*([^<]*?)\s*<\/artifactId>/.exec(block)?.[1] ?? "?";
    const group = /<groupId>\s*([^<]*?)\s*<\/groupId>/.exec(block)?.[1];
    // com.pso artifacts versioned by <pso.version> are already reported once, above
    if (/\$\{pso\.version\}/.test(versionRaw) && pso !== undefined) continue;
    snapshots.push(`${m[1]} ${group ? `${group}:` : ""}${artifact} is ${version}`);
  }
  return { project, pso, snapshots: [...new Set(snapshots)] };
}
