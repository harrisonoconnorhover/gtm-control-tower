export interface GlobOptions {
  cwd?: string;
  onlyDirectories?: boolean;
}

export function globSync(patterns: string | readonly string[], options?: GlobOptions): string[];
export const sync: typeof globSync;
declare const compatibility: { sync: typeof sync; globSync: typeof globSync };
export default compatibility;
