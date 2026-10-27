// The icebase CLI, run as a user runs it (the built `icebase` command in a project directory):
// init, drivers, check, openapi, indexes check, deploy's refusals, dev; and the deploy helpers
// (custom-auth env checks, the functions bundle's .env, Hosting's auth rewrite).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { defineConfig, senders } from '@panth977/icebase/config';
import { defineSchema } from '@panth977/icebase/schema';
import { hostingVersionConfig } from '@panth977/icebase-cli/manage';
import { buildFunctions, customAuthEnv, wiring } from '../cli/src/cli/deploy.ts';

const CLI = resolve(import.meta.dirname, '../cli/dist/cli/index.js');
// Inside the repository, so a project's imports of @panth977/icebase resolve to the workspace packages.
const TMP = resolve(import.meta.dirname, '.tmp-cli');
mkdirSync(TMP, { recursive: true });
const project = (name: string) => mkdtempSync(join(TMP, `${name}-`));
const icebase = (cwd: string, ...args: string[]) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' }, timeout: 120_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

const CONFIG = (extra = '') => `import { defineConfig } from '@panth977/icebase/config';
import { collection, defineSchema, f, index } from '@panth977/icebase/schema';
export const items = collection('items', { fields: { name: f.string(), price: f.number(), shop: f.string() }, indexes: [index('shop'), index('price')] });
export default defineConfig({
  name: 'cli-demo',
  schema: defineSchema({ items }),
  firebase: { projectId: 'demo-cli' },
  ${extra}
  environments: { local: { mode: 'emulator' }, prod: { mode: 'firebase' } },
});
`;

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe('icebase CLI', () => {

  it('help lists every command; an unknown one fails', () => {
    const h = icebase(TMP, 'help');
    expect(h.code).toBe(0);
    for (const c of ['init', 'dev', 'serve', 'deploy', 'indexes check', 'gen dart', 'docs', 'openapi', 'check', 'drivers']) expect(h.out).toContain(c);
    expect(icebase(TMP, 'nope').code).not.toBe(0);
  });

  it('init writes a project that loads: config, schema, rules', () => {
    const dir = project('init');
    const r = icebase(dir, 'init', '--name', 'shop', '--project', 'demo-shop');
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, 'icebase.config.ts'))).toBe(true);
    expect(readFileSync(join(dir, 'icebase.config.ts'), 'utf8')).toContain('demo-shop');
    // The new project loads: drivers reads its config.
    const d = icebase(dir, 'drivers', '--env', Object.keys({ local: 1 })[0]!);
    expect(d.out).toMatch(/firestore\s+(emulator|firebase)/);
  });

  it('drivers prints each service\'s mode; check and openapi read the declarations', () => {
    const dir = project('drivers');
    writeFileSync(join(dir, 'icebase.config.ts'), CONFIG());
    const d = icebase(dir, 'drivers', '--env', 'local');
    expect(d.code).toBe(0);
    expect(d.out).toMatch(/firestore\s+emulator/);
    expect(icebase(dir, 'drivers', '--env', 'prod').out).toMatch(/firestore\s+firebase/);
    const c = icebase(dir, 'check');
    expect(c.code).toBe(0);
    expect(c.out).toMatch(/ok: 1 collections/);
    expect(icebase(dir, 'openapi', '--out', 'api.json').code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, 'api.json'), 'utf8')).openapi).toMatch(/^3\.1/);
  });

  it('indexes check: a query on an undeclared composite index fails the check, with where it is', () => {
    const dir = project('indexes');
    writeFileSync(join(dir, 'icebase.config.ts'), CONFIG());
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, types: [] }, include: ['*.ts'] }),
    );
    const ok = `import { collection, getDocs, getFirestore, query, where, orderBy } from '@panth977/icebase/firestore';
import { initializeApp } from '@panth977/icebase/app';
import config, { items } from './icebase.config.ts';
const db = getFirestore(initializeApp(config, 'local'));
export const a = getDocs(query(collection(db, items), where('shop', '==', 's1')));
`;
    writeFileSync(join(dir, 'page.ts'), ok);
    const good = icebase(dir, 'indexes', 'check');
    expect(good.out).toContain('Every query has the indexes it needs');
    expect(good.code).toBe(0);
    writeFileSync(join(dir, 'page.ts'), `${ok}export const b = getDocs(query(collection(db, items), where('shop', '==', 's1'), orderBy('price')));\n`);
    const bad = icebase(dir, 'indexes', 'check');
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/page\.ts:6:\d+\s+missing index on ('price' \+ 'shop'|'shop' \+ 'price')/);
  }, 120_000);

  it('deploy refuses a custom auth method whose secrets are not in the environment', () => {
    const dir = project('deploy');
    writeFileSync(join(dir, 'icebase.config.ts'), CONFIG(`auth: { providers: ['emailLink'], custom: { email: { sender: { kind: 'smtp', urlEnv: 'CLI_TEST_SMTP_URL', from: 'a@b.c' } } } },`));
    const r = icebase(dir, 'deploy', '--env', 'prod');
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('env var CLI_TEST_SMTP_URL is not set');
    expect(icebase(dir, 'deploy').out).toContain('deploy needs --env');
  });

  it('dev starts the emulator for the emulator-mode services and answers health', async () => {
    const dir = project('dev');
    writeFileSync(join(dir, 'icebase.config.ts'), CONFIG('emulator: { port: 0 },'));
    const p = spawn(process.execPath, [CLI, 'dev', '--env', 'local'], { cwd: dir, env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (out += b));
    try {
      const url = await new Promise<string>((ok, fail) => {
        const t = setTimeout(() => fail(new Error(`dev did not start:\n${out}`)), 60_000);
        const check = setInterval(() => {
          const m = /(http:\/\/[^\s]+:\d+)/.exec(out);
          if (m) {
            clearInterval(check);
            clearTimeout(t);
            ok(m[1]!);
          }
        }, 100);
      });
      const h = (await (await fetch(`${url}/__/icebase/health`)).json()) as { ok: boolean; services: string[] };
      expect(h.ok).toBe(true);
      expect(h.services).toContain('firestore');
    } finally {
      p.kill('SIGINT');
    }
  }, 90_000);
});

describe('deploy helpers', () => {
  const custom = defineConfig({
    name: 'helpers',
    schema: defineSchema({}),
    auth: {
      providers: ['emailLink', 'phone'],
      custom: {
        email: { sender: senders.resend({ apiKeyEnv: 'CLI_RESEND_KEY', from: 'a@b.c' }) },
        phone: { sender: senders.twilio({ accountSidEnv: 'CLI_TW_SID', authTokenEnv: 'CLI_TW_TOKEN', from: '+1' }) },
        google: { clientIdEnv: 'CLI_G_ID', clientSecretEnv: 'CLI_G_SECRET' },
      },
    },
    hosting: { public: 'public', spa: true },
    firebase: { projectId: 'demo-helpers' },
    environments: { prod: { mode: 'firebase' } },
  });

  it('customAuthEnv lists every secret the custom methods name; wiring refuses the missing ones', () => {
    expect(customAuthEnv(custom).sort()).toEqual(['CLI_G_ID', 'CLI_G_SECRET', 'CLI_RESEND_KEY', 'CLI_TW_SID', 'CLI_TW_TOKEN']);
    process.env.CLI_RESEND_KEY = 'x';
    try {
      const w = wiring(custom, 'prod');
      expect(w.problems.filter((p) => p.startsWith('custom auth'))).toHaveLength(4);
      expect(w.problems.join('\n')).not.toContain('CLI_RESEND_KEY');
    } finally {
      delete process.env.CLI_RESEND_KEY;
    }
    // A self-hosted endpoint needs nothing from this deploy.
    expect(wiring({ ...custom, auth: { ...custom.auth!, custom: { ...custom.auth!.custom!, endpoint: 'https://auth.example.com' } } }, 'prod').problems).toEqual([]);
  });

  it('the functions bundle carries the custom-auth secrets in .env (mode 600)', async () => {
    const dir = mkdtempSync(join(TMP, 'bundle-'));
    writeFileSync(join(dir, 'icebase.config.ts'), "import { defineConfig } from '@panth977/icebase/config';\nexport default defineConfig({ name: 'b', schema: { collections: {}, paths: {}, files: {} } as never, environments: { prod: { mode: 'firebase' } } });\n");
    Object.assign(process.env, { CLI_RESEND_KEY: 'k1', CLI_TW_SID: 's', CLI_TW_TOKEN: 't', CLI_G_ID: 'g', CLI_G_SECRET: 'gs' });
    try {
      const out = await buildFunctions(custom, 'prod', dir, () => {});
      const env = readFileSync(join(out!, '.env'), 'utf8');
      expect(env).toContain('CLI_RESEND_KEY="k1"');
      expect(env).toContain('CLI_G_SECRET="gs"');
      expect(statSync(join(out!, '.env')).mode & 0o777).toBe(0o600);
      const index = readFileSync(join(out!, 'index.js'), 'utf8');
      expect(index).toContain('icebaseAuthCleanup');
    } finally {
      for (const k of ['CLI_RESEND_KEY', 'CLI_TW_SID', 'CLI_TW_TOKEN', 'CLI_G_ID', 'CLI_G_SECRET']) delete process.env[k];
    }
  }, 120_000);

  it('Hosting gets the /__/icebase/auth/** rewrite to icebaseAuth before the SPA fallback', () => {
    const v = hostingVersionConfig(custom.hosting!, 'asia-south1', true);
    expect(v.rewrites![0]).toEqual({ glob: '/__/icebase/auth/**', run: { serviceId: 'icebaseauth', region: 'asia-south1' } });
    expect(v.rewrites!.at(-1)).toEqual({ glob: '**', path: '/index.html' });
    expect(hostingVersionConfig(custom.hosting!).rewrites).toEqual([{ glob: '**', path: '/index.html' }]);
  });
});
