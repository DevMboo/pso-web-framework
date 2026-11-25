import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';

const site = resolve(process.argv[2] ?? 'docs-site');
if (!existsSync(join(site, 'index.html'))) throw new Error('missing site/index.html');
const allowed = new Set(['.html', '.md', '.js', '.css', '.json', '.txt', '.png', '.svg', '.ico']);
const files = [];
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`link in publication: ${relative(site, file)}`);
    if (stat.isDirectory()) walk(file);
    else if (stat.isFile()) {
      if (!allowed.has(extname(name))) throw new Error(`unapproved file type: ${relative(site, file)}`);
      files.push(file);
    } else throw new Error(`unapproved entry: ${relative(site, file)}`);
  }
}
walk(site);
const names = new Set(files.map(f => relative(site, f).split(sep).join('/')));
const problems = [];
const forbidden = [
  ['credential', /github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/i],
  ['internal material', /docs[\\/]implementation|release-out[\\/]psd|assessment-blind|publication-work|scripts[\\/]fixtures[\\/]|test[\\/]fixtures[\\/]/i],
  ['developer path', /[A-Za-z]:[\\/]Users[\\/][^\s<"']+/i],
  ['source map', /sourceMappingURL|\.map(?:[?#"']|$)/i],
];
for (const file of files) {
  const rel = relative(site, file).split(sep).join('/');
  if (/(^|\/)(\.git|\.github|node_modules|fixtures|evidence)(\/|$)/i.test(rel)) problems.push(`${rel}: restricted path`);
  if (!/\.(html|md|js|css|json|txt|svg)$/.test(file)) continue;
  const body = readFileSync(file, 'utf8');
  for (const [label, re] of forbidden) if (re.test(body)) problems.push(`${rel}: ${label}`);
  if (!file.endsWith('.html') && !file.endsWith('.css')) continue;
  if (file.endsWith('.html') && [...body.matchAll(/<h1(?:\s|>)/gi)].length > 1) problems.push(`${rel}: multiple h1 headings`);
  const refs = file.endsWith('.html')
    ? [...body.matchAll(/\b(?:href|src)\s*=\s*["']([^"']+)["']/gi)].map(m => m[1])
    : [...body.matchAll(/url\(\s*["']?([^)'"\s]+)["']?\s*\)/gi)].map(m => m[1]);
  for (const raw of refs) {
    const value = raw.replaceAll('&amp;', '&');
    if (/^(?:https?:|mailto:|tel:|data:|javascript:|#)/i.test(value)) continue;
    if (value.startsWith('/')) { problems.push(`${rel}: root-relative asset ${value}`); continue; }
    const [target, fragment] = value.split('#', 2);
    const path = decodeURIComponent((target ?? '').split('?')[0]);
    if (!path) continue;
    const resolved = resolve(dirname(file), path);
    const dest = relative(site, resolved).split(sep).join('/');
    if (dest.startsWith('../') || dest === '..') { problems.push(`${rel}: escaping link ${value}`); continue; }
    const actual = dest.endsWith('/') ? `${dest}index.html` : dest;
    if (!names.has(actual)) { problems.push(`${rel}: missing link ${value}`); continue; }
    if (fragment && actual.endsWith('.html')) {
      const id = decodeURIComponent(fragment);
      if (!readFileSync(resolved, 'utf8').includes(`id="${id}"`)) problems.push(`${rel}: missing anchor ${value}`);
    }
  }
}
if (problems.length) {
  console.error(`FAILED: ${problems.length} publication problems`);
  for (const p of problems.slice(0, 30)) console.error(p);
  process.exit(1);
}
console.log(`PASSED: ${files.length} approved static files; local links and anchors resolve`);
