import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configure } from '../plugins/gtm-control-tower/scripts/configure.mjs';
import { readConfig } from '../plugins/gtm-control-tower/scripts/config.mjs';

const plugin = resolve('plugins/gtm-control-tower');
test('plugin launcher uses private configuration and keeps protocol stdout clean', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'control-tower-plugin-'));
  try {
    const repo = join(dir, 'app with spaces');
    await mkdir(join(repo, 'scripts'), { recursive: true });
    await writeFile(join(repo, 'scripts/control-tower-mcp.mjs'),
      `if (process.env.CONTROL_TOWER_SYNC_KEY !== 'test-only-secret') process.exit(7);\nprocess.stdout.write('protocol-only');\n`);
    const env = join(dir, 'private.env');
    await writeFile(env, 'CONTROL_TOWER_SYNC_KEY=test-only-secret\n', { mode: 0o600 });
    const destination = join(dir, 'private', 'config.json');
    await configure(['--repo', repo, '--env-file', env], destination);
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.equal((await readConfig(destination)).repoPath, repo);
    assert.ok(!(await readFile(destination, 'utf8')).includes('test-only-secret'));
    const result = spawnSync(process.execPath, [join(plugin, 'scripts/start.mjs')], {
      encoding: 'utf8', env: { ...process.env, CONTROL_TOWER_PLUGIN_CONFIG: destination, CONTROL_TOWER_SYNC_KEY: 'another-app-key' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, 'protocol-only');
    assert.equal(result.stderr, '');
    const missing = spawnSync(process.execPath, [join(plugin, 'scripts/start.mjs')], {
      encoding: 'utf8', env: { ...process.env, CONTROL_TOWER_PLUGIN_CONFIG: join(dir, 'absent.json') },
    });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
    assert.match(missing.stderr, /needs setup/);
    await assert.rejects(configure(['--repo', join(dir, 'missing'), '--env-file', env], destination));
    assert.equal((await readConfig(destination)).repoPath, repo, 'Invalid setup must preserve working config');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
