import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import dynamicImport from 'vite-plugin-dynamic-import';
import compatibility, { globSync } from '../vendor/fast-glob-compat/index.js';

const require = createRequire(import.meta.url);
const { getRootDirs } = require('@next/eslint-plugin-next/dist/utils/get-root-dirs.js') as {
  getRootDirs(context: { cwd: string; settings: { next?: { rootDir?: string | string[] } } }): string[];
};

describe('scoped fast-glob compatibility', () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'control-tower-glob-'));
    for (const path of ['apps/one', 'apps/two', 'views/nested']) {
      mkdirSync(join(cwd, path), { recursive: true });
    }
    for (const path of ['apps/readme.txt', 'views/alpha.ts', 'views/beta.js', 'views/skip.ts', 'views/.hidden.ts', 'views/nested/index.ts']) {
      writeFileSync(join(cwd, path), 'export default 1;\n');
    }
  });

  afterEach(() => rmSync(cwd, { recursive: true, force: true }));

  it('resolves both actual consumers to the local package with CommonJS and ESM APIs', () => {
    const expected = require.resolve('../vendor/fast-glob-compat/index.js');
    for (const name of ['@next/eslint-plugin-next', 'vite-plugin-dynamic-import']) {
      const consumer = createRequire(require.resolve(name));
      expect(consumer.resolve('fast-glob')).toBe(expected);
      expect(consumer('fast-glob/package.json').name).toBe('@gtm-control-tower/fast-glob-compat');
      expect(consumer('fast-glob').globSync('apps/*', { cwd, onlyDirectories: true }).sort())
        .toEqual(['apps/one', 'apps/two']);
    }
    expect(compatibility.sync).toBe(globSync);
  });

  it('handles cwd, glob arrays, brace extensions and exclusions without expanding literal directories', () => {
    expect(compatibility.sync(['views/**/*.{ts,js}', '!views/skip.ts'], { cwd }).sort())
      .toEqual(['views/alpha.ts', 'views/beta.js', 'views/nested/index.ts']);
    expect(globSync('views', { cwd })).toEqual([]);
    expect(globSync('views', { cwd, onlyDirectories: true })).toEqual(['views']);
  });

  it('supports the real Next root-directory helper for string and array settings', () => {
    const one = join(cwd, 'apps/one');
    const two = join(cwd, 'apps/two');
    expect(getRootDirs({ cwd, settings: { next: { rootDir: join(cwd, 'apps/*') } } }).sort())
      .toEqual([one, two]);
    expect(getRootDirs({ cwd, settings: { next: { rootDir: [one, two] } } }).sort())
      .toEqual([one, two]);
    expect(getRootDirs({ cwd, settings: {} })).toEqual([cwd]);
  });

  it('lets the real Vite plugin transform extensionless variable imports into matching files', async () => {
    const plugin = dynamicImport({ loose: false }) as unknown as {
      configResolved(config: object): void;
      transform(code: string, id: string): Promise<{ code: string } | undefined>;
    };
    plugin.configResolved({
      root: cwd,
      resolve: { extensions: ['.ts', '.js'], alias: [] },
      optimizeDeps: {},
      createResolver: () => async () => undefined,
    });
    const result = await plugin.transform('export const load = (name) => import(`./views/${name}`);', join(cwd, 'main.ts'));
    expect(result?.code).toContain("import('./views/alpha.ts')");
    expect(result?.code).toContain("import('./views/beta.js')");
    expect(result?.code).toContain("import('./views/nested/index.ts')");
    expect(result?.code).not.toContain('.hidden.ts');
    expect(result?.code).toContain('__variableDynamicImportRuntime0__(`./views/${name}`)');
  });
});
