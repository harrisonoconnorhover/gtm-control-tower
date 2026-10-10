/** Copy the authorized CLI connection into Cloudflare secrets without printing or persisting it. */
import { execFileSync, spawnSync } from 'node:child_process';
const org = JSON.parse(execFileSync('sf', ['org', 'display', '--target-org', process.argv[2] || 'gtm-control-tower-salesforce', '--verbose', '--json'], { encoding: 'utf8' })).result;
const auth = JSON.parse(execFileSync('sf', ['org', 'auth', 'show-sfdx-auth-url', '--target-org', process.argv[2] || 'gtm-control-tower-salesforce', '--json'], { encoding: 'utf8' })).result;
const parts = auth.sfdxAuthUrl.replace(/^force:\/\//, '').split('@')[0].split(':');
const secrets = {
  SALESFORCE_CLIENT_ID: parts.length === 3 ? parts[0] : org.clientId,
  SALESFORCE_CLIENT_SECRET: parts.length === 3 ? parts[1] : '',
  SALESFORCE_REFRESH_TOKEN: parts.length === 3 ? parts[2] : parts[0],
};
if (!secrets.SALESFORCE_CLIENT_SECRET) delete secrets.SALESFORCE_CLIENT_SECRET;
if (org.instanceUrl !== 'https://orgfarm-a011ff9b54-dev-ed.develop.my.salesforce.com' || !secrets.SALESFORCE_REFRESH_TOKEN || !secrets.SALESFORCE_CLIENT_ID) throw new Error('Expected Salesforce connection is unavailable.');
const result = spawnSync('node_modules/.bin/wrangler', ['secret', 'bulk', '--config', 'hollis/wrangler.jsonc'], {
  input: JSON.stringify(secrets), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
});
// Wrangler reports names and deployment outcomes, never the supplied values.
process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
if (result.status !== 0) process.exit(result.status || 1);
