import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const targetOrg = process.argv[2] ?? 'gtm-control-tower-salesforce';
const root = process.cwd();
const envPath = resolve(root, '.env.local');
const temporaryPath = resolve(root, '.env.local.salesforce.tmp');

const tokenPayload = runSf([
  'org', 'auth', 'show-access-token', '--target-org', targetOrg, '--json',
]);
const orgPayload = runSf([
  'org', 'display', '--target-org', targetOrg, '--json',
]);

const accessToken = tokenPayload.result?.accessToken;
const instanceUrl = orgPayload.result?.instanceUrl;
const apiVersion = orgPayload.result?.apiVersion;
if (!accessToken || !instanceUrl || !apiVersion) {
  throw new Error(`Salesforce CLI did not return a complete session for ${targetOrg}.`);
}

const existing = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
const next = upsertEnv(existing, {
  SALESFORCE_INSTANCE_URL: instanceUrl,
  SALESFORCE_ACCESS_TOKEN: accessToken,
  SALESFORCE_API_VERSION: apiVersion,
});
writeFileSync(temporaryPath, next, { encoding: 'utf8', mode: 0o600 });
chmodSync(temporaryPath, 0o600);
renameSync(temporaryPath, envPath);
chmodSync(envPath, 0o600);

console.log(`Configured ignored .env.local for ${instanceUrl} (API v${apiVersion}).`);

function runSf(args) {
  const output = execFileSync('sf', args, { cwd: root, encoding: 'utf8' });
  const payload = JSON.parse(output);
  if (payload.status !== 0) throw new Error(`Salesforce CLI command failed for ${targetOrg}.`);
  return payload;
}

function upsertEnv(source, values) {
  const lines = source ? source.replace(/\n+$/u, '').split('\n') : [];
  const remaining = new Map(Object.entries(values));
  const next = lines.map((line) => {
    const match = /^([A-Z][A-Z0-9_]*)=/u.exec(line);
    if (!match || !remaining.has(match[1])) return line;
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${value}`;
  });
  if (next.length && remaining.size) next.push('');
  for (const [key, value] of remaining) next.push(`${key}=${value}`);
  return `${next.join('\n')}\n`;
}
