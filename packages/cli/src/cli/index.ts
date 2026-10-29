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
  serve [--env X] [--port N] [--host H] [--data DIR]
                                Production server on one port (PORT, default 8080): every service in emulator or vm
                                mode, the functions and hosting; signed ID tokens; admin token ICEBASE_ADMIN_TOKEN or
                                one kept in DIR/admin-token. Data in SQLite files in DIR, or in Postgres when the
                                environment uses vm mode (vm.databaseUrlEnv) or ICEBASE_DATABASE_URL is set
  migrate --from SRC --to DST [--replace] [--prefix P]
                                Copy the server's data between SQLite and Postgres, either way (server stopped).
                                SRC/DST: sqlite:DIR, postgres://…, or env:NAME (an env var holding either);
                                --prefix: the Postgres schema prefix (default ICEBASE_DATABASE_PREFIX, else icebase_)
  deploy --env X [--only a,b]   Deploy rules, indexes, auth providers, functions, hosting, Remote Config
                                parameters and App Check enforcement for environment X
                                (--only: firestore, database, storage, auth, functions, hosting, remoteConfig,
                                appCheck, rules, indexes)
  indexes check [--project tsconfig.json]
                                Type-check and list queries whose composite index is not declared (exit 1 if any)
  gen dart [--out FILE]         Write the Dart types, schema and config (models, Fields, enums) for the Dart SDK
  docs [--out DIR] [--serve [--port N]]
                                The database and API reference: DIR/index.html (browsable), project.json, openapi.json
  openapi [--out FILE]          The declared endpoints as OpenAPI 3.1 (callables as POST { data })
  check [--strict]              Dry run: the declarations are consistent and every declared endpoint is implemented
                                (--strict: undeclared callables / HTTP functions are errors too)
  drivers --env X               Print the mode of each service, the wiring between them, and warnings
  console --env X [--port N]    The IceBase console on this machine for environment X (on the IceBase server it is
                                also at /__/icebase/console)
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
      for (const s of SERVICES) log(`${s.padEnd(13)} ${w.modes[s]}`);
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
    case 'docs':
    case 'openapi':
    case 'check': {
      const { config } = await loadConfig(cwd);
      const { checkProject } = await import('./check.ts');
      const { openApi } = await import('@panth977/icebase/describe');
      const { mkdirSync, writeFileSync } = await import('node:fs');
      const { dirname, resolve, join } = await import('node:path');
      const r = await checkProject(config, cwd, { strict: !!f.strict });
      for (const p of r.problems) log(`error: ${p}`);
      for (const w of r.warnings) log(`warn:  ${w}`);
      if (pos[0] === 'check') {
        log(r.problems.length ? `${r.problems.length} problem(s)` : `ok: ${r.doc.collections.length} collections, ${r.doc.endpoints.length} endpoints, every declaration consistent`);
        return r.problems.length ? 1 : 0;
      }
      const spec = openApi(config, { ...r.doc, problems: [...r.problems, ...r.doc.problems.filter((p) => !r.problems.includes(p))] });
      if (pos[0] === 'openapi') {
        const out = str(f.out) ?? 'openapi.json';
        mkdirSync(dirname(resolve(cwd, out)), { recursive: true });
        writeFileSync(resolve(cwd, out), JSON.stringify(spec, null, 2));
        log(`wrote ${out}`);
        return 0;
      }
      const { renderDocs } = await import('./docs.ts');
      const dir = resolve(cwd, str(f.out) ?? 'icebase-docs');
      mkdirSync(dir, { recursive: true });
      const doc = { ...r.doc, problems: r.problems };
      writeFileSync(join(dir, 'index.html'), renderDocs(doc));
      writeFileSync(join(dir, 'project.json'), JSON.stringify(doc, null, 2));
      writeFileSync(join(dir, 'openapi.json'), JSON.stringify(spec, null, 2));
      log(`wrote ${dir}/index.html (+ project.json, openapi.json)`);
      if (f.serve) {
        const { createServer } = await import('node:http');
        const { readFileSync } = await import('node:fs');
        const port = Number(str(f.port) ?? 4500);
        createServer((req, res) => {
          const name = (req.url ?? '/').split('?')[0] === '/' ? 'index.html' : (req.url ?? '').split('?')[0]!.slice(1);
          try {
            const body = readFileSync(join(dir, name.replace(/\.\.+/g, '')));
            res.writeHead(200, { 'content-type': name.endsWith('.json') ? 'application/json' : 'text/html; charset=utf-8' }).end(body);
          } catch {
            res.writeHead(404).end('not found');
          }
        }).listen(port, '127.0.0.1', () => log(`serving the reference on http://127.0.0.1:${port}`));
        await new Promise(() => {});
      }
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
    case 'console': {
      const env = str(f.env);
      if (!env) throw new Error('console needs --env');
      const { config } = await loadConfig(cwd);
      const { startConsole } = await import('../console/local.ts');
      const c = await startConsole(config, env, Number(str(f.port) ?? 4600));
      log(`IceBase console for ${config.name} (env ${env}): ${c.url}`);
      await new Promise(() => {});
      return 0;
    }
    case 'serve': {
      const { config } = await loadConfig(cwd);
      const { devEnv } = await import('./dev.ts');
      const { serve } = await import('../emulator/server.ts');
      const env = devEnv(config, str(f.env) ?? process.env.ICEBASE_ENV);
      process.env.ICEBASE_ENV = env;
      const s = await serve({
        config,
        root: cwd,
        env,
        log,
        ...(str(f.port) ? { port: Number(f.port) } : {}),
        ...(str(f.host) ? { host: str(f.host)! } : {}),
        ...(str(f.data) ? { dataDir: str(f.data)! } : {}),
      });
      log(`IceBase serving ${config.name} (env ${env}) on :${s.port}${config.hosting ? ' with hosting' : ''}`);
      const stop = () => void s.close().then(() => process.exit(0));
      process.once('SIGTERM', stop);
      process.once('SIGINT', stop);
      await new Promise(() => {});
      return 0;
    }
    case 'migrate': {
      const from = str(f.from);
      const to = str(f.to);
      if (!from || !to) throw new Error('usage: icebase migrate --from sqlite:DIR|postgres://…|env:NAME --to … [--replace] [--prefix P]');
      const { migrate, storesAt } = await import('../emulator/migrate.ts');
      const { resolve } = await import('node:path');
      const prefix = str(f['from-prefix']) ?? str(f.prefix) ?? process.env.ICEBASE_DATABASE_PREFIX;
      const toPrefix = str(f['to-prefix']) ?? str(f.prefix) ?? process.env.ICEBASE_DATABASE_PREFIX;
      // A directory is relative to here.
      const at = (spec: string) => (/^(postgres(ql)?:\/\/|env:)/.test(spec) ? spec : `sqlite:${resolve(cwd, spec.replace(/^sqlite:/, ''))}`);
      const src = storesAt(at(from), { env: process.env, ...(prefix ? { prefix } : {}) });
      const dst = storesAt(at(to), { env: process.env, ...(toPrefix ? { prefix: toPrefix } : {}) });
      try {
        log(`migrate ${src.where} → ${dst.where}`);
        const r = await migrate(src, dst, { replace: !!f.replace, log });
        log(`done: ${r.stores.length} store(s). Stored files (blobs) stay in the data directory: copy its storage/ along if the server moves.`);
      } finally {
        await src.close();
        await dst.close();
      }
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
