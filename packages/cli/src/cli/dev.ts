// `icebase dev` (CLI-2): the IceBase emulator for every service in emulator mode, hosting,
// the seed script on an empty database, and reloads: rules and functions in place, a full
// restart when icebase.config.ts or the schema changes.

import { existsSync, watch, type FSWatcher } from 'node:fs';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveModes, SERVICES, type AnyConfig } from '@panth977/icebase/config';
import { startHosting } from '../emulator/hosting.ts';
import { startEmulator, type RunningEmulator } from '../emulator/server.ts';
import { findConfig, loadConfig } from './load.ts';

type Log = (l: string) => void;

/** The environment `icebase dev` runs: --env, else the first one that uses emulator mode. */
export function devEnv(config: AnyConfig, wanted?: string): string {
  if (wanted) {
    if (!(wanted in config.environments)) throw new Error(`--env ${wanted} is not in icebase.config (${Object.keys(config.environments).join(', ')})`);
    return wanted;
  }
  const env = Object.keys(config.environments).find((e) => Object.values(resolveModes(config, e)).includes('emulator'));
  if (!env) throw new Error('no environment in icebase.config uses mode "emulator" (e.g. environments: { local: { mode: "emulator" } })');
  return env;
}

export async function dev(initial: AnyConfig, root: string, log: Log, opts: { env?: string; once?: boolean } = {}): Promise<{ stop(): Promise<void>; emulator: RunningEmulator }> {
  let config = initial;
  const env = devEnv(config, opts.env);
  const modes = resolveModes(config, env);
  for (const s of SERVICES) if (modes[s] !== 'emulator') log(`note: ${s} is in ${modes[s]} mode in --env ${env}; the emulator only serves emulator-mode services`);

  let emu!: RunningEmulator;
  let hosting: { url: string; close(): Promise<void> } | null = null;
  const port = config.emulator?.port ?? 4400;
  const boot = async () => {
    emu = await startEmulator({ config, root, env, port, log });
    if (config.hosting && modes.hosting === 'emulator') {
      hosting = await startHosting({ config, root, port: config.emulator?.hostingPort ?? 5002, functionsOrigin: emu.url, projectId: emu.context.projectId, log });
    }
    const seed = config.emulator?.seed;
    if (seed && emu.context.firestore.count() === 0) {
      log(`seed: ${seed}`);
      process.env.ICEBASE_ENV = env;
      process.env.ICEBASE_EMULATOR_HOST = emu.url.replace(/^http:\/\//, '');
      const { importTs } = await import('./load.ts');
      await importTs(`${pathToFileURL(resolve(root, seed)).href}?v=${Date.now()}`);
      log(`seed: done, ${emu.context.firestore.count()} documents`);
    }
    log(`\n  IceBase emulator  ${emu.url}\n${hosting ? `  Hosting           ${hosting.url}\n` : ''}  env               ${env}\n  data              ${relative(root, emu.context.dataDir) || emu.context.dataDir}\n`);
  };
  await boot();

  const admin = (path: string) => fetch(`${emu.url}${path}`, { method: 'POST', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: '{}' });
  const watchers: FSWatcher[] = [];
  let restarting = false;
  const restart = async (why: string) => {
    if (restarting) return;
    restarting = true;
    log(`${why}: restarting`);
    try {
      await hosting?.close();
      await emu.close();
      config = (await loadConfig(root)).config;
      await boot();
    } catch (e) {
      log(`restart failed: ${(e as Error).message}`);
    } finally {
      restarting = false;
    }
  };
  const on = (p: string, fn: () => void) => {
    if (!existsSync(p)) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    watchers.push(watch(p, { recursive: true }, () => {
      if (t) clearTimeout(t);
      t = setTimeout(fn, 150);
    }));
  };
  if (!opts.once) {
    const cfgFile = findConfig(root);
    if (cfgFile) on(cfgFile, () => void restart('icebase.config.ts changed'));
    on(resolve(root, '@panth977/icebase/schema'), () => void restart('schema changed'));
    for (const f of [config.rules?.firestore, config.rules?.storage, config.rules?.database].filter(Boolean) as string[]) on(resolve(root, f), () => void restart(`${f} changed`));
    if (config.functions?.source) on(resolve(root, config.functions.source), () => void admin('/__/icebase/functions/reload').then(() => log('functions reloaded')));
  }
  const stop = async () => {
    for (const w of watchers) w.close();
    await hosting?.close();
    await emu.close();
  };
  if (!opts.once) {
    const bye = () => void stop().then(() => process.exit(0));
    process.once('SIGINT', bye);
    process.once('SIGTERM', bye);
  }
  return { stop, emulator: emu };
}
