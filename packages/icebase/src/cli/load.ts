// Load icebase.config.ts (TypeScript, extensionless imports) the way the app sees it.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnyConfig } from '../config.js';

export const CONFIG_FILES = ['icebase.config.ts', 'icebase.config.mts', 'icebase.config.js', 'icebase.config.mjs'];

export function findConfig(dir: string): string | null {
  for (const f of CONFIG_FILES) if (existsSync(resolve(dir, f))) return resolve(dir, f);
  return null;
}

export async function loadConfig(dir: string): Promise<{ config: AnyConfig; file: string; root: string }> {
  const file = findConfig(dir);
  if (!file) throw new Error(`No icebase.config.ts in ${dir} (run \`icebase init\` to create one)`);
  const { tsImport } = await import('tsx/esm/api');
  const mod = (await tsImport(pathToFileURL(file).href, import.meta.url)) as { default?: AnyConfig };
  const config = mod.default;
  if (!config || typeof config !== 'object' || !('environments' in config)) throw new Error(`${file} must \`export default defineConfig({ … })\``);
  return { config, file, root: dir };
}
