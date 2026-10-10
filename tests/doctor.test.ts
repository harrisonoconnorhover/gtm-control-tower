import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: run }));
vi.mock('node:fs/promises', () => ({ readdir: vi.fn(async () => []), readFile: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
  run.mockReset().mockReturnValue('');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('doctor exit'); });
});
afterEach(() => vi.restoreAllMocks());

function dockerCalls() {
  return run.mock.calls.filter(([command]) => command === 'docker');
}

function failDockerCommand(expected: string, code: string) {
  run.mockImplementation((command: string, args: string[]) => {
    if (command === 'docker' && args.join(' ') === expected) throw Object.assign(new Error(code), { code });
    return '';
  });
}

function expectNonblockingWarning(fragment: string) {
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(fragment));
  expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('https://gtm-control-tower.pages.dev/#clean-csv'));
  expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Doctor passed'));
  expect(process.exit).not.toHaveBeenCalled();
}

describe('setup doctor', () => {
  it('explains a missing CLI without probing the engine or Compose', async () => {
    failDockerCommand('--version', 'ENOENT');
    await import('../scripts/doctor.mjs');
    expectNonblockingWarning('Docker CLI is unavailable');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('self-hosted app or optional n8n'));
    expect(dockerCalls().map(([, args]) => args)).toEqual([['--version']]);
  });

  it('warns when the engine cannot be reached, including a timed-out check', async () => {
    failDockerCommand('info --format {{.ServerVersion}}', 'ETIMEDOUT');
    await import('../scripts/doctor.mjs');
    expectNonblockingWarning('Docker engine is unreachable');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Docker context, DOCKER_HOST, and socket permissions'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(
      ['darwin', 'win32'].includes(process.platform) ? 'Open Docker Desktop' : 'Docker engine or service',
    ));
    expect(dockerCalls().map(([, args]) => args)).toContainEqual(['compose', 'version']);
  });

  it('warns when Compose is missing even if the engine is healthy', async () => {
    failDockerCommand('compose version', '1');
    await import('../scripts/doctor.mjs');
    expectNonblockingWarning('Docker Compose is unavailable');
    expect(console.warn).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('docker compose version succeeds'));
  });

  it('runs only bounded read-only checks when Docker is healthy', async () => {
    await import('../scripts/doctor.mjs');
    expect(dockerCalls().map(([, args]) => args)).toEqual([
      ['--version'], ['info', '--format', '{{.ServerVersion}}'], ['compose', 'version'],
    ]);
    for (const [, , options] of dockerCalls()) {
      expect(options).toEqual({ stdio: 'ignore', timeout: 3000, killSignal: 'SIGKILL' });
    }
    expect(console.warn).not.toHaveBeenCalled();
    expect(process.exit).not.toHaveBeenCalled();
  });

  it.each(['22.0.0', '22.12.0'])('rejects Node %s below the documented minimum', async (version) => {
    const original = Object.getOwnPropertyDescriptor(process.versions, 'node')!;
    Object.defineProperty(process.versions, 'node', { ...original, value: version });
    try {
      await expect(import('../scripts/doctor.mjs')).rejects.toThrow('doctor exit');
      expect(console.error).toHaveBeenCalledWith(`- Node ${version} is too old; use Node 22.13 or newer.`);
      expect(process.exit).toHaveBeenCalledWith(1);
    } finally {
      Object.defineProperty(process.versions, 'node', original);
    }
  });
});
