import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { run, readFile, stat } = vi.hoisted(() => ({ run: vi.fn(), readFile: vi.fn(), stat: vi.fn() }));
vi.mock('node:child_process', () => ({ execFileSync: run }));
vi.mock('node:fs', () => ({ readFileSync: readFile, statSync: stat }));

beforeEach(() => {
  vi.resetModules();
  run.mockReset();
  readFile.mockReset();
  stat.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('scanner exit'); });
});
afterEach(() => vi.restoreAllMocks());

const sha = (value: number) => value.toString(16).padStart(40, '0');
const privateKeyMarker = '-----BEGIN ' + 'PRIVATE KEY-----';

it('preserves findings, byte framing, size limits, deduplication, and working files across content batches', async () => {
  const markers = [
    privateKeyMarker,
    'AKIA' + 'A'.repeat(16),
    'AIza' + 'B'.repeat(35),
    'ghp_' + 'C'.repeat(36),
    'xoxb-' + 'D'.repeat(20),
    'https://hooks.slack.com/services/' + 'E'.repeat(8) + '/' + 'F'.repeat(8) + '/' + 'G'.repeat(20),
    'pat-' + 'H'.repeat(20),
    '00D' + 'I'.repeat(12) + '!' + 'J'.repeat(20),
  ];
  const prefix = Buffer.concat([Buffer.from('🛠 café\n'), Buffer.from([0, 255, 254]), Buffer.from(`\n${markers.join('\n')}\n`)]);
  const blobs = Array.from({ length: 18 }, (_, index) => ({
    sha: sha(index + 1), path: `file-${index}.csv`, size: index === 1 ? 2_000_000 : 1_900_000,
  }));
  const objects = [
    ...blobs,
    { sha: sha(1), path: 'duplicate.csv', size: 1_900_000 },
    { sha: sha(30), path: 'too-large.csv', size: 2_000_001 },
    { sha: sha(31), path: '(unknown)', size: 100 },
    { sha: sha(32), path: 'scripts/check-secrets.mjs', size: 100 },
  ];
  const contentBatches: string[][] = [];
  run.mockImplementation((_command: string, args: string[], options: { input?: string }) => {
    if (args[0] === 'rev-list') return objects.map((object) => `${object.sha} ${object.path}`).join('\n') + '\n';
    if (args[0] === 'ls-files') return 'scripts/check-secrets.mjs\nworking.txt\ntoo-large.csv\n';
    const requested = options.input!.trim().split('\n');
    if (args[1].startsWith('--batch-check')) {
      return requested.map((id) => {
        const object = objects.find((candidate) => candidate.sha === id)!;
        return `${id} ${id === sha(31) ? 'tree' : 'blob'} ${object.size}\n`;
      }).join('');
    }
    expect(args).toEqual(['cat-file', '--batch']);
    contentBatches.push(requested);
    return Buffer.concat(requested.flatMap((id) => {
      const object = blobs.find((candidate) => candidate.sha === id)!;
      const body = Buffer.alloc(object.size, ' ');
      if (id === sha(1)) prefix.copy(body);
      if (id === sha(2)) body.write(privateKeyMarker);
      return [Buffer.from(`${id} blob ${body.length}\n`), body, Buffer.from('\n')];
    }));
  });
  stat.mockImplementation((path: string) => ({ isFile: () => true, size: path.endsWith('too-large.csv') ? 2_000_001 : 100 }));
  readFile.mockReturnValue(markers[1]);

  await expect(import('../scripts/check-secrets.mjs')).rejects.toThrow('scanner exit');
  expect(contentBatches).toHaveLength(2);
  expect(contentBatches.flat()).toEqual(blobs.map((object) => object.sha));
  const names = ['private key', 'AWS access key', 'Google API key', 'GitHub token', 'Slack token', 'Slack incoming webhook', 'HubSpot private app token', 'Salesforce access token'];
  expect(vi.mocked(console.error).mock.calls.map(([message]) => message)).toEqual([
    'Potential secrets found in Git history (10):',
    ...names.map((name) => `- file-0.csv (${sha(1).slice(0, 10)}): ${name}`),
    `- file-1.csv (${sha(2).slice(0, 10)}): private key`,
    '- working.txt (working tree): AWS access key',
  ]);
  expect(readFile).toHaveBeenCalledTimes(1);
  expect(process.exit).toHaveBeenCalledWith(1);
});

it.each(['missing', 'truncated'])('fails rather than passing an unreadable %s object', async (failure) => {
  run.mockImplementation((_command: string, args: string[]) => {
    if (args[0] === 'rev-list') return `${sha(1)} example.txt\n`;
    if (args[1].startsWith('--batch-check')) return failure === 'missing' ? `${sha(1)} missing\n` : `${sha(1)} blob 4\n`;
    return Buffer.from(`${sha(1)} blob 4\nabc`);
  });
  await expect(import('../scripts/check-secrets.mjs')).rejects.toThrow(failure === 'missing' ? 'Cannot inspect Git object' : 'Incomplete Git object');
  expect(console.log).not.toHaveBeenCalled();
});
