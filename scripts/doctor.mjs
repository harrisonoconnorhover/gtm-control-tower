import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const failures = [];
const warnings = [];
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) failures.push(`Node ${process.versions.node} is too old; use Node 22.13 or newer.`);

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

const browserFallback = 'Clean CSVs without Docker at https://gtm-control-tower.pages.dev/#clean-csv.';
function dockerCheck(args) {
  try {
    execFileSync('docker', args, { stdio: 'ignore', timeout: 3000, killSignal: 'SIGKILL' });
    return true;
  } catch {
    return false;
  }
}

if (!dockerCheck(['--version'])) {
  warnings.push(`Docker CLI is unavailable or did not respond within 3 seconds. Check your Docker installation and PATH before starting the self-hosted app or optional n8n. ${browserFallback}`);
} else {
  if (!dockerCheck(['info', '--format', '{{.ServerVersion}}'])) {
    const engineGuidance = ['darwin', 'win32'].includes(process.platform)
      ? 'Open Docker Desktop and wait for its engine to be ready.'
      : 'Check that your Docker engine or service is running.';
    warnings.push(`Docker engine is unreachable or did not respond within 3 seconds. ${engineGuidance} If it is already running, check your Docker context, DOCKER_HOST, and socket permissions with docker context show and docker info. ${browserFallback}`);
  }
  if (!dockerCheck(['compose', 'version'])) {
    warnings.push(`Docker Compose is unavailable or did not respond within 3 seconds. The self-host instructions require the Compose plugin; check that docker compose version succeeds (Docker Desktop includes it). ${browserFallback}`);
  }
}

if (failures.length) {
  console.error(`Doctor found ${failures.length} blocking problem(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Doctor passed on Node ${process.versions.node}.`);
for (const warning of warnings) console.warn(`Warning: ${warning}`);
