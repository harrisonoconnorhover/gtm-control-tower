import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];
const warnings = [];
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) failures.push(`Node ${process.versions.node} is too old; use Node 22.13 or newer.`);

try {
  execFileSync('git', ['check-ignore', '-q', '.env.local'], { cwd: root });
} catch {
  failures.push('.env.local is not ignored by Git.');
}

const forbidden = [
  'harrison-gtm-control-tower',
  'gtmBigQuerySA01',
  'gtmHubSpotOAuth01',
];
for (const directory of ['integrations/n8n', 'warehouse/bigquery']) {
  for (const filename of await readdir(resolve(root, directory))) {
    const path = resolve(root, directory, filename);
    const source = await readFile(path, 'utf8');
    for (const value of forbidden) {
      if (source.includes(value)) failures.push(`${directory}/${filename} contains private setup identifier ${value}.`);
    }
    if (filename.endsWith('.json')) {
      const workflow = JSON.parse(source);
      if ((workflow.nodes ?? []).some((node) => node.credentials)) {
        failures.push(`${directory}/${filename} contains an exported n8n credential binding.`);
      }
    }
  }
}

try {
  execFileSync('docker', ['--version'], { stdio: 'ignore' });
} catch {
  warnings.push('Docker is unavailable; CSV-only mode still works, but local n8n will not start.');
}

if (failures.length) {
  console.error(`Doctor found ${failures.length} blocking problem(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Doctor passed on Node ${process.versions.node}.`);
for (const warning of warnings) console.warn(`Warning: ${warning}`);
