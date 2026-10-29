// `icebase deploy --env X [--only a,b]` (CLI-4) and `icebase drivers --env X` (CLI-9).

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeAdminApp } from '@panth977/icebase-server/admin';
import { readEnv, resolveModes, SERVICES, type AnyConfig, type Mode, type Service } from '@panth977/icebase/config';
import { manageAppCheck, manageAuth, manageDatabase, manageFirestore, manageHosting, manageRemoteConfig, manageStorage } from '../manage.ts';

export type Target = Service | 'rules' | 'indexes';
type Log = (line: string) => void;

/** What runs where, and what cannot work (MIX-4). */
export function wiring(config: AnyConfig, env: string): { modes: Record<Service, Mode>; problems: string[]; warnings: string[] } {
  const modes = resolveModes(config, env);
  const problems: string[] = [];
  const warnings: string[] = [];
  // vm services run on your server (`icebase serve --env X` on the VM, Postgres from vm.databaseUrlEnv):
  // icebase deploy ships only the firebase ones.
  const vm = SERVICES.filter((s) => modes[s] === 'vm');
  if (vm.length) warnings.push(`${vm.join(', ')}: vm mode — served by \`icebase serve --env ${env}\` on your server; icebase deploy does not push to a VM`);
  if (vm.length && !config.vm?.databaseUrlEnv) problems.push('vm mode needs vm.databaseUrlEnv (the env var holding the Postgres connection string)');
  const fnRewrite = (config.hosting?.rewrites ?? []).some((r) => 'function' in r);
  if (fnRewrite && modes.hosting === 'firebase' && modes.functions !== 'firebase') problems.push('hosting rewrites to a function, but Firebase Hosting can only rewrite to Cloud Functions (functions are not in firebase mode)');
  if (modes.storage === 'firebase' && modes.firestore !== 'firebase' && config.rules?.storage && /firestore\.(get|exists)\(/.test(safeRead(config.rules.storage))) problems.push('storage.rules read Firestore, but Firestore is not on Firebase: Firebase Storage rules cannot read documents elsewhere');
  if (config.auth?.custom && modes.functions !== modes.auth && !config.auth.custom.endpoint) warnings.push(`custom auth runs as the icebaseAuth function (functions: ${modes.functions}) for auth in ${modes.auth} mode; set auth.custom.endpoint if you host it elsewhere`);
  // The icebaseAuth function reads its senders' and Google client's secrets from env vars: refuse a
  // deploy that would ship a custom method without them (docs/prd/custom-auth.html §2).
  if (config.auth?.custom && modes.functions === 'firebase' && !config.auth.custom.endpoint) {
    for (const name of customAuthEnv(config)) if (!readEnv(name)) problems.push(`custom auth: env var ${name} is not set (config.auth.custom needs it at run time)`);
  }
  if (config.auth?.custom && modes.database !== 'firebase' && modes.auth === 'firebase') warnings.push('custom auth keeps its security store in the Realtime Database, which is not in firebase mode here');
  if (config.appCheck?.enforce?.includes('functions') && modes.functions === 'firebase') warnings.push('appCheck.enforce lists functions: on Firebase, callables enforce App Check with onCall({ enforceAppCheck: true })');
  if (modes.firestore !== modes.auth) warnings.push(`auth is in ${modes.auth} mode and Firestore in ${modes.firestore} mode: rules see the tokens of the auth side only`);
  return { modes, problems, warnings };
}

/** The env vars config.auth.custom names: its senders' secrets and the Google OAuth client. */
export function customAuthEnv(config: AnyConfig): string[] {
  const c = config.auth?.custom;
  if (!c) return [];
  const names = new Set<string>();
  const fromSender = (x: unknown) => {
    if (!x || typeof x !== 'object') return;
    for (const [k, v] of Object.entries(x)) if (k.endsWith('Env') && typeof v === 'string') names.add(v);
  };
  fromSender(c.email?.sender);
  fromSender(c.phone?.sender);
  if (c.google) {
    names.add(c.google.clientIdEnv);
    names.add(c.google.clientSecretEnv);
  }
  return [...names];
}

function safeRead(p: string): string {
  try {
    return readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

const run = (cmd: string, args: string[], cwd: string, log: Log) =>
  new Promise<void>((resolveRun, reject) => {
    log(`$ ${cmd} ${args.join(' ')}`);
    const p = spawn(cmd, args, { cwd, stdio: 'inherit', env: process.env });
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolveRun() : reject(new Error(`${cmd} exited with ${code}`))));
  });

/** Bundle the functions source (+ the icebaseAuth endpoint) into .icebase/functions for firebase-tools. */
export async function buildFunctions(config: AnyConfig, env: string, root: string, log: Log): Promise<string | null> {
  const fnCfg = config.functions;
  const custom = !!config.auth?.custom;
  if (!fnCfg && !custom) return null;
  const out = resolve(root, '.icebase/functions');
  mkdirSync(out, { recursive: true });
  const sourceDir = fnCfg ? resolve(root, fnCfg.source) : null;
  const srcPkg = sourceDir && existsSync(join(sourceDir, 'package.json')) ? (JSON.parse(readFileSync(join(sourceDir, 'package.json'), 'utf8')) as { main?: string; dependencies?: Record<string, string> }) : {};
  const entryFile = sourceDir ? resolve(sourceDir, srcPkg.main ?? 'src/index.ts') : null;
  const configFile = ['icebase.config.ts', 'icebase.config.mts', 'icebase.config.js'].map((f) => resolve(root, f)).find(existsSync)!;
  const lines = [
    ...(entryFile ? [`export * from ${JSON.stringify(entryFile)};`] : []),
    ...(custom
      ? [
          `import { icebaseAuth as __icebaseAuth, icebaseAuthCleanup as __icebaseAuthCleanup } from '@panth977/icebase-server/functions';`,
          `import __config from ${JSON.stringify(configFile)};`,
          ...(entryFile ? [`import * as __user from ${JSON.stringify(entryFile)};`] : []),
          // sendEmail / sendPhoneCode: the senders for `sender: 'handler'`, when the functions source exports them.
          `const __own = ${entryFile ? '__user as Record<string, any>' : '{} as Record<string, any>'};`,
          `export const icebaseAuth = __icebaseAuth(__config, ${JSON.stringify(env)}, { senders: { email: __own['sendEmail'], phone: __own['sendPhoneCode'] } });`,
          // Once a day: expired challenges, counters, blocks and old audit entries leave the store.
          `export const icebaseAuthCleanup = __icebaseAuthCleanup(__config, ${JSON.stringify(env)});`,
        ]
      : []),
  ];
  const entry = join(out, '_entry.ts');
  writeFileSync(entry, lines.join('\n') + '\n');
  // The custom-auth secrets go with the functions (firebase-tools loads .env at deploy).
  const secrets = custom ? customAuthEnv(config).filter((n) => readEnv(n) !== undefined) : [];
  if (secrets.length) writeFileSync(join(out, '.env'), secrets.map((n) => `${n}=${JSON.stringify(readEnv(n))}`).join('\n') + '\n', { mode: 0o600 });
  const ownPkg = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url).href), 'utf8')) as { version: string; peerDependencies: Record<string, string> };
  const deps: Record<string, string> = {
    ...srcPkg.dependencies,
    firebase: ownPkg.peerDependencies['firebase']!,
    'firebase-admin': ownPkg.peerDependencies['firebase-admin']!,
    'firebase-functions': ownPkg.peerDependencies['firebase-functions']!,
  };
  for (const p of ['@panth977/icebase', '@panth977/icebase-server', '@panth977/icebase-cli']) delete deps[p];
  const { build } = await import('esbuild');
  await build({
    entryPoints: [entry],
    outfile: join(out, 'index.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // Everything with a package.json dependency stays external and is installed by Cloud Build;
    // icebase itself (and the user's own modules) are bundled in.
    external: Object.keys(deps).flatMap((d) => [d, `${d}/*`]),
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    logLevel: 'warning',
  });
  writeFileSync(join(out, 'package.json'), JSON.stringify({ name: `${config.name}-functions`, private: true, type: 'module', main: 'index.js', engines: { node: (fnCfg?.runtime ?? 'nodejs22').replace('nodejs', '') }, dependencies: deps }, null, 2) + '\n');
  log(`functions bundled → ${relative(root, out)}/index.js${custom ? ' (+ icebaseAuth, icebaseAuthCleanup)' : ''}`);
  return out;
}

export async function deploy(config: AnyConfig, env: string, root: string, only: Target[] | null, log: Log): Promise<void> {
  const { modes, problems, warnings } = wiring(config, env);
  for (const w of warnings) log(`warn: ${w}`);
  if (problems.length) throw new Error(`refusing to deploy --env ${env}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  const want = (t: Target, svc: Service) => (only === null || only.includes(t) || only.includes(svc)) && modes[svc] === 'firebase';
  const wantRules = (svc: Service) => (only === null || only.includes('rules') || only.includes(svc)) && modes[svc] === 'firebase';
  if (Object.values(modes).every((m) => m === 'emulator')) {
    log(`--env ${env} runs every service in emulator mode: nothing to deploy (use \`icebase dev\`)`);
    return;
  }
  if (Object.values(modes).every((m) => m !== 'firebase')) {
    log(`--env ${env} runs no service on Firebase: nothing to deploy (run \`icebase serve --env ${env}\` on your server)`);
    return;
  }
  const app = initializeAdminApp(config, env, { name: `icebase-deploy-${env}` });
  const at = (p: string) => resolve(root, p);
  const step = async (name: string, fn: () => Promise<unknown>) => {
    log(`→ ${name}`);
    const r = await fn();
    if (r && typeof r === 'object') log(`  ${JSON.stringify(r).slice(0, 400)}`);
  };

  if (want('indexes', 'firestore')) await step('firestore: indexes, exemptions, TTL (from the schema)', () => manageFirestore(app).setSchema());
  if (wantRules('firestore') && config.rules?.firestore) await step('firestore: rules', () => manageFirestore(app).setRules({ file: at(config.rules!.firestore!) }));
  if (wantRules('database') && (config.rules?.database || Object.keys(config.schema.paths ?? {}).length || config.auth?.custom)) {
    await step('database: rules (+ .indexOn, + custom-auth store)', async () => {
      const base = config.rules?.database ? (JSON.parse(readFileSync(at(config.rules.database), 'utf8')) as { rules: Record<string, unknown> }) : undefined;
      return manageDatabase(app).setRules(base);
    });
  }
  if (wantRules('storage') && config.rules?.storage) await step('storage: rules', () => manageStorage(app).setRules({ file: at(config.rules!.storage!) }));
  if (want('auth', 'auth') && config.auth) {
    await step('auth: sign-in providers', () => manageAuth(app).setProviders());
    if (config.auth.authorizedDomains) await step('auth: authorized domains', () => manageAuth(app).setAuthorizedDomains(config.auth!.authorizedDomains!));
  }
  if (want('functions', 'functions')) {
    const dir = await buildFunctions(config, env, root, log);
    if (dir) {
      const fb = join(dirname(dir), 'firebase.json');
      writeFileSync(fb, JSON.stringify({ functions: { source: 'functions', runtime: config.functions?.runtime ?? 'nodejs22' } }, null, 2) + '\n');
      const bin = ['node_modules/.bin/firebase'].map((p) => resolve(root, p)).find(existsSync) ?? 'firebase';
      await run(bin, ['deploy', '--only', 'functions', '--project', config.firebase!.projectId, '--config', fb, '--non-interactive'], dirname(dir), log);
    }
  }
  if (want('remoteConfig', 'remoteConfig') && config.remoteConfig) await step('remote config: template from the declared parameters', () => manageRemoteConfig(app).setParameters());
  if (want('appCheck', 'appCheck') && config.appCheck?.enforce?.length) await step('app check: enforcement (Firestore, Realtime Database, Storage)', () => manageAppCheck(app).setEnforcement());
  if (want('hosting', 'hosting') && config.hosting) await step('hosting: upload + release', () => manageHosting(app).deploy({ dir: at(config.hosting!.public), message: `icebase deploy --env ${env}` }));
  log('done');
}
