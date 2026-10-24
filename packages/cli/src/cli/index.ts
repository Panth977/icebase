#!/usr/bin/env node
// The icebase CLI.

import { basename } from 'node:path';
import { SERVICES } from '@panth977/icebase/config';
import { deploy, wiring, type Target } from './deploy.ts';
import { checkIndexes } from './indexes.ts';
import { init } from './init.ts';
import { loadConfig } from './load.ts';

const HELP = `icebase <command>

  init [--name N] [--project ID] [--import DIR] [--sample N]
                                Create icebase.config.ts, schema, rules, functions; optionally import a Firebase project
  login [--reauth]              Sign in to Firebase (deploy and the management APIs use this login)
  dev [--env X]                 Start the emulator (SQLite) for every service in emulator mode, hosting, seed, reloads
  deploy --env X [--only a,b]   Deploy rules, indexes, auth providers, functions, hosting for environment X
                                (--only: firestore, database, storage, auth, functions, hosting, rules, indexes)
  indexes check [--project tsconfig.json]
                                Type-check and list queries whose composite index is not declared (exit 1 if any)
  gen dart [--out FILE]         Write the Dart types, schema and config (models, Fields, enums) for the Dart SDK
  drivers --env X               Print the mode of each service, the wiring between them, and warnings
`;

function flags(argv: string[]): { pos: string[]; f: Record<string, string | true> } {
  const pos: string[] = [];
  const f: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2) as [string, string | undefined];
      if (v !== undefined) f[k] = v;
      else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) f[k] = argv[++i]!;
      else f[k] = true;
    } else pos.push(a);
  }
  return { pos, f };
}

const log = (line: string) => console.log(line);
const str = (v: string | true | undefined) => (typeof v === 'string' ? v : undefined);

async function main(argv: string[]): Promise<number> {
  const { pos, f } = flags(argv);
  const cwd = process.cwd();
  switch (pos[0]) {
    case 'init': {
      await init(cwd, { name: str(f.name) ?? basename(cwd), ...(str(f.project) ? { projectId: str(f.project)! } : {}), ...(str(f.import) ? { importDir: str(f.import)! } : {}), ...(str(f.sample) ? { sample: Number(f.sample) } : {}) }, log);
      log('\nNext: fill in icebase/schema, then `icebase dev` (emulator) or `icebase deploy --env prod`.');
      return 0;
    }
    case 'deploy': {
      const env = str(f.env);
      if (!env) throw new Error('deploy needs --env (one of the environments in icebase.config.ts)');
      const { config } = await loadConfig(cwd);
      const only = str(f.only)?.split(',').map((s) => s.trim()) as Target[] | undefined;
      for (const o of only ?? []) if (![...SERVICES, 'rules', 'indexes'].includes(o)) throw new Error(`--only ${o}: not one of ${[...SERVICES, 'rules', 'indexes'].join(', ')}`);
      await deploy(config, env, cwd, only ?? null, log);
      return 0;
    }
    case 'indexes': {
      if (pos[1] !== 'check') throw new Error('usage: icebase indexes check');
      const { missing, otherErrors } = await checkIndexes(cwd, str(f.project));
      for (const m of missing) log(`${m.file}:${m.line}:${m.column}  missing index on ${m.fields.map((x) => `'${x}'`).join(' + ')} — declare it in the collection's indexes`);
      log(missing.length ? `\n${missing.length} quer${missing.length === 1 ? 'y needs' : 'ies need'} an undeclared index.` : 'Every query has the indexes it needs.');
      if (otherErrors) log(`(${otherErrors} other type error(s) in the project; run tsc to see them)`);
      return missing.length ? 1 : 0;
    }
    case 'drivers': {
      const env = str(f.env);
      if (!env) throw new Error('drivers needs --env');
      const { config } = await loadConfig(cwd);
      const w = wiring(config, env);
      for (const s of SERVICES) log(`${s.padEnd(10)} ${w.modes[s]}`);
      for (const p of w.problems) log(`error: ${p}`);
      for (const x of w.warnings) log(`warn:  ${x}`);
      return w.problems.length ? 1 : 0;
    }
    case 'gen': {
      if (pos[1] !== 'dart') throw new Error('usage: icebase gen dart [--out lib/icebase.g.dart] [--package icebase]');
      const { config } = await loadConfig(cwd);
      const { genDart } = await import('./gen-dart.ts');
      const out = str(f.out) ?? 'lib/icebase.g.dart';
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { dirname, resolve } = await import('node:path');
      mkdirSync(dirname(resolve(cwd, out)), { recursive: true });
      writeFileSync(resolve(cwd, out), genDart(config, { ...(str(f.package) ? { package: str(f.package)! } : {}) }));
      log(`wrote ${out}`);
      return 0;
    }
    case 'login': {
      // Firebase login for firebase-mode services; IceBase's admin calls reuse it (CLI-3).
      const { spawnSync } = await import('node:child_process');
      const r = spawnSync('firebase', ['login', ...(f.reauth ? ['--reauth'] : [])], { stdio: 'inherit' });
      return r.status ?? 1;
    }
    case 'dev': {
      const { config } = await loadConfig(cwd);
      const { dev } = await import('./dev.ts');
      await dev(config, cwd, log, { ...(str(f.env) ? { env: str(f.env)! } : {}) });
      // Runs until Ctrl-C.
      await new Promise(() => {});
      return 0;
    }
    case undefined:
    case 'help':
    case '--help':
      log(HELP);
      return 0;
    default:
      log(HELP);
      throw new Error(`unknown command: ${pos[0]}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code) process.exitCode = code;
  },
  (e: Error) => {
    console.error(`icebase: ${e.message}`);
    process.exitCode = 1;
  },
);
