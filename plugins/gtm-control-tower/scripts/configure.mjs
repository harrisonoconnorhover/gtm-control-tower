#!/usr/bin/env node
import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configPath, validateConfig } from './config.mjs';

export async function configure(args, destination = configPath()) {
  if (args.length !== 4 || args[0] !== '--repo' || args[2] !== '--env-file')
    throw new Error('Usage: node scripts/configure.mjs --repo /path/to/gtm-control-tower --env-file /path/to/private.env');
  const config = { repoPath: resolve(args[1]), envFile: resolve(args[3]) };
  await validateConfig(config);
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await chmod(destination, 0o600);
  return destination;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  configure(process.argv.slice(2)).then(path => console.log(`Control Tower plugin configured: ${path}`)).catch(error => {
    console.error(error.message); process.exitCode = 1;
  });
}
