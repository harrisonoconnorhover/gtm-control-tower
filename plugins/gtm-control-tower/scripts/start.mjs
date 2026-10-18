#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readConfig } from './config.mjs';

try {
  const { repoPath, envFile, serverPath } = await readConfig();
  const env = { ...process.env };
  // The selected private file takes precedence over another app's environment.
  delete env.CONTROL_TOWER_API_URL;
  delete env.CONTROL_TOWER_SYNC_KEY;
  const child = spawn(process.execPath, [`--env-file=${envFile}`, serverPath], { cwd: repoPath, env, stdio: 'inherit' });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('error', () => { console.error('Control Tower MCP could not start. Check the local installation.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
