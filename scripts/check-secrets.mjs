import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const rules = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/u],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/u],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/u],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u],
  ['HubSpot private app token', /\bpat-[A-Za-z0-9-]{20,}\b/u],
  ['Salesforce access token', /\b00D[A-Za-z0-9]{12,15}![A-Za-z0-9._-]{20,}\b/u],
];

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const objects = git('rev-list', '--objects', '--all')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const space = line.indexOf(' ');
    return space < 0 ? { sha: line, path: '(unknown)' } : { sha: line.slice(0, space), path: line.slice(space + 1) };
  });
const seen = new Set();
const findings = [];

function scan(source, label) {
  for (const [name, pattern] of rules) {
    if (pattern.test(source)) findings.push(`${label}: ${name}`);
  }
}

for (const object of objects) {
  if (object.path === 'scripts/check-secrets.mjs') continue;
  if (seen.has(object.sha)) continue;
  seen.add(object.sha);
  if (git('cat-file', '-t', object.sha).trim() !== 'blob') continue;
  const size = Number(git('cat-file', '-s', object.sha).trim());
  if (!Number.isFinite(size) || size > 2_000_000) continue;
  const source = git('cat-file', 'blob', object.sha);
  scan(source, `${object.path} (${object.sha.slice(0, 10)})`);
}

const workingFiles = git('ls-files', '--cached', '--others', '--exclude-standard').trim().split('\n').filter(Boolean);
for (const path of workingFiles) {
  if (path === 'scripts/check-secrets.mjs') continue;
  const absolute = resolve(root, path);
  const stat = statSync(absolute);
  if (!stat.isFile() || stat.size > 2_000_000) continue;
  scan(readFileSync(absolute, 'utf8'), `${path} (working tree)`);
}

if (findings.length) {
  console.error(`Potential secrets found in Git history (${findings.length}):`);
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`Secret scan passed across ${seen.size} Git objects.`);
