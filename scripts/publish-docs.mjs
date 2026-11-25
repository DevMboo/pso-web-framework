import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan, summarize } from './psd/scan.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1]; };
const out = resolve(flag('out') ?? join(root, 'publication-work', 'run'));
const repo = flag('repo') ? resolve(flag('repo')) : undefined;
const denyPath = flag('denylist') ? resolve(flag('denylist')) : undefined;
if (repo && !denyPath) throw new Error('publishing to a repository requires --denylist <private indicator file>');
if (existsSync(out) && readdirSync(out).length) throw new Error(`output must be empty: ${out}`);
mkdirSync(out, { recursive: true });
const stage = join(out, 'stage');
const site = join(stage, 'docs-site');
execFileSync(process.execPath, [join(root, 'packages/cli/bin/pso.js'), 'docs', '--build', site], { cwd: root, stdio: 'inherit' });
const exceptions = JSON.parse(readFileSync(join(root, 'scripts/psd/exceptions.json'), 'utf8')).exceptions;
const denylist = denyPath ? readFileSync(denyPath, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')) : [];
const result = scan(stage, { exceptions, denylist });
writeFileSync(join(out, 'security-scan.json'), JSON.stringify(result, null, 2));
if (!result.ok) throw new Error(`PSD security scan failed: ${JSON.stringify(summarize(result))}; see security-scan.json`);
console.log(`PSD scan PASSED: ${result.stats.files} files`);
execFileSync(process.execPath, [join(root, 'scripts/check-public-site.mjs'), site], { cwd: root, stdio: 'inherit' });
if (repo) {
  if (!existsSync(join(repo, '.git'))) throw new Error(`not a git checkout: ${repo}`);
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repo, encoding: 'utf8' }).trim();
  if (!/^https:\/\/github\.com\/DevMboo\/pso-web-docs(?:\.git)?$/i.test(remote)) throw new Error(`unexpected origin: ${remote}`);
  const target = join(repo, 'docs-site');
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  cpSync(site, target, { recursive: true, errorOnExist: true });
  console.log(`prepared ${target}; review, commit and push this public checkout`);
}
