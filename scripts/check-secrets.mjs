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
  ['Slack incoming webhook', /https:\/\/hooks\.slack(?:-gov)?\.com\/services\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{20,}/u],
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

const uniqueObjects = objects.filter((object) => {
  if (object.path === 'scripts/check-secrets.mjs' || seen.has(object.sha)) return false;
  seen.add(object.sha);
  return true;
});

function batchGit(args, batch, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd: root,
    input: `${batch.map((object) => object.sha).join('\n')}\n`,
    encoding,
    maxBuffer: 64 * 1024 * 1024,
  });
}

const eligible = [];
for (let start = 0; start < uniqueObjects.length; start += 10_000) {
  const batch = uniqueObjects.slice(start, start + 10_000);
  const metadata = batchGit(['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], batch)
    .trim().split('\n');
  if (metadata.length !== batch.length) throw new Error('Incomplete Git object metadata.');
  for (let index = 0; index < batch.length; index += 1) {
    const object = batch[index];
    const [sha, type, length] = metadata[index].split(' ');
    if (sha !== object.sha || type === 'missing' || length === undefined) {
      throw new Error(`Cannot inspect Git object ${object.sha}.`);
    }
    const size = Number(length);
    if (type === 'blob' && Number.isFinite(size) && size <= 2_000_000) eligible.push({ ...object, size });
  }
}

function scanBatch(batch) {
  const content = batchGit(['cat-file', '--batch'], batch, null);
  let offset = 0;
  for (const object of batch) {
    const headerEnd = content.indexOf(10, offset);
    if (headerEnd < 0 || content.subarray(offset, headerEnd).toString('utf8') !== `${object.sha} blob ${object.size}`) {
      throw new Error(`Cannot read Git object ${object.sha}.`);
    }
    offset = headerEnd + 1;
    const end = offset + object.size;
    if (end >= content.length || content[end] !== 10) throw new Error(`Incomplete Git object ${object.sha}.`);
    scan(content.subarray(offset, end).toString('utf8'), `${object.path} (${object.sha.slice(0, 10)})`);
    offset = end + 1;
  }
  if (offset !== content.length) throw new Error('Unexpected Git batch output.');
}

// Bound each Git response without limiting how much history can be scanned.
let batch = [];
let batchBytes = 0;
for (const object of eligible) {
  if (batch.length && batchBytes + object.size + 100 > 32 * 1024 * 1024) {
    scanBatch(batch);
    batch = [];
    batchBytes = 0;
  }
  batch.push(object);
  batchBytes += object.size + 100;
}
if (batch.length) scanBatch(batch);

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
