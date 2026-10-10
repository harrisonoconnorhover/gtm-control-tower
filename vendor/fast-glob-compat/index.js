import { globSync as tinyGlobSync } from 'tinyglobby';
import { isAbsolute } from 'node:path';

// These are the only APIs used by Next's lint root lookup and Vite's dynamic
// import plugin. Literal directories must retain fast-glob's non-expanding behavior.
export function globSync(patterns, options = {}) {
  const all = typeof patterns === 'string' ? [patterns] : patterns;
  const exclusions = all.filter((pattern) => pattern.startsWith('!'));
  const inclusions = all.filter((pattern) => !pattern.startsWith('!'));
  const matches = [false, true].flatMap((absolute) => {
    const group = inclusions.filter((pattern) => isAbsolute(pattern) === absolute);
    return group.length ? tinyGlobSync([...group, ...exclusions], {
      ...options, absolute, expandDirectories: false,
    }) : [];
  });
  return [...new Set(matches.map((path) =>
    path.endsWith('/') && !/^(?:\/|[A-Za-z]:\/)$/.test(path) ? path.slice(0, -1) : path))];
}

export const sync = globSync;
const compatibility = { sync, globSync };
export default compatibility;
