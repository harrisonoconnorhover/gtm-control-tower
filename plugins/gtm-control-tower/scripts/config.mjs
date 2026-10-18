import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { readFile, stat } from 'node:fs/promises';

export function configPath(environment = process.env) {
  return environment.CONTROL_TOWER_PLUGIN_CONFIG || join(homedir(), '.config', 'gtm-control-tower', 'codex-plugin.json');
}
export async function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![value.repoPath, value.envFile].every(path => typeof path === 'string' && isAbsolute(path))) {
    throw new Error('Configure an absolute Control Tower repo path and private env-file path.');
  }
  const serverPath = join(value.repoPath, 'scripts', 'control-tower-mcp.mjs');
  if (!(await stat(serverPath)).isFile() || !(await stat(value.envFile)).isFile()) {
    throw new Error('The Control Tower MCP server and private env file must exist.');
  }
  return { repoPath: value.repoPath, envFile: value.envFile, serverPath };
}
export async function readConfig(path = configPath()) {
  try { return await validateConfig(JSON.parse(await readFile(path, 'utf8'))); }
  catch { throw new Error('Control Tower plugin needs setup. Run its scripts/configure.mjs --repo /path/to/gtm-control-tower --env-file /path/to/private.env. Keep the local app running.'); }
}
