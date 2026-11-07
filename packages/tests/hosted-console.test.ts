// The console hosted on a Firebase project (config.console.hosted): the icebaseConsole function's
// handler, what `icebase deploy` wires for it, and what it refuses. No emulator needed: the
// operations exercised read the config only.
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defineConfig } from '@panth977/icebase/config';
import { collection, defineSchema, f } from '@panth977/icebase/schema';
import { buildFunctions, wiring } from '../cli/src/cli/deploy.ts';
import { hasConsoleToken, hostedConsoleHandler } from '../cli/src/console/hosted.ts';
import { hostingVersionConfig } from '../cli/src/manage.ts';

// Inside the repository, so the bundle's imports of @panth977/icebase resolve to the workspace packages.
const TMP = resolve(import.meta.dirname, '.tmp-hosted-console');
const TOKEN = 'c'.repeat(40);
const cfg = defineConfig({
  name: 'hosted-console',
  schema: defineSchema({ notes: collection('notes', { fields: { text: f.string() }, indexes: [] }) }),
  hosting: { public: 'public', spa: true },
  console: { hosted: true, tokenEnv: 'HC_TEST_CONSOLE_TOKEN' },
  firebase: { projectId: 'demo-hosted-console' },
  environments: { prod: { mode: 'firebase' } },
});
const withToken = async <T>(value: string | undefined, fn: () => Promise<T> | T): Promise<T> => {
  const before = process.env.HC_TEST_CONSOLE_TOKEN;
  if (value === undefined) delete process.env.HC_TEST_CONSOLE_TOKEN;
  else process.env.HC_TEST_CONSOLE_TOKEN = value;
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.HC_TEST_CONSOLE_TOKEN;
    else process.env.HC_TEST_CONSOLE_TOKEN = before;
  }
};

describe('hosted console (firebase mode)', () => {
  const handler = hostedConsoleHandler(cfg, 'prod');
  const api = (op: string, auth?: string, at = '/__/icebase/console') =>
    handler(new Request(`https://demo-hosted-console.web.app${at}/api/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) }, body: '{}' }));

  it('serves the page to anyone, with the console\'s CSP', async () => {
    const res = await handler(new Request('https://demo-hosted-console.web.app/__/icebase/console/'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(res.headers.get('cache-control')).toContain('no-store');
  });

  it('refuses every API call without the token, with a wrong or short one, and when none is set', async () => {
    await withToken(TOKEN, async () => {
      expect((await api('schema.ts')).status).toBe(403);
      expect((await api('schema.ts', `Bearer ${'x'.repeat(40)}`)).status).toBe(403);
      expect((await api('schema.ts', `Bearer ${TOKEN.slice(1)}`)).status).toBe(403);
      expect((await api('schema.ts', `Bearer ${TOKEN}x`)).status).toBe(403);
    });
    await withToken(undefined, async () => expect((await api('schema.ts', `Bearer ${TOKEN}`)).status).toBe(403));
    await withToken('short', async () => expect((await api('schema.ts', 'Bearer short')).status).toBe(403));
  });

  it('answers with the token — at Hosting\'s path and on the function\'s own URL', async () => {
    await withToken(TOKEN, async () => {
      const a = await api('schema.ts', `Bearer ${TOKEN}`);
      expect(a.status).toBe(200);
      expect(JSON.stringify(await a.json())).toContain('notes');
      const b = await api('schema.ts', `Bearer ${TOKEN}`, '');
      expect(b.status).toBe(200);
    });
  });

  it('hasConsoleToken: constant-time match only', () => {
    const req = (a: string) => new Request('https://x.invalid', { headers: { authorization: a } });
    expect(hasConsoleToken(req(`Bearer ${TOKEN}`), TOKEN)).toBe(true);
    expect(hasConsoleToken(req(TOKEN), TOKEN)).toBe(true);
    expect(hasConsoleToken(req(`Bearer ${TOKEN}`), undefined)).toBe(false);
    expect(hasConsoleToken(req('Bearer '), '')).toBe(false);
  });

  it('deploy: refuses without a token (or a short one); bundles icebaseConsole with the token in .env; Hosting rewrites to it', async () => {
    await withToken(undefined, () => expect(wiring(cfg, 'prod').problems.join('\n')).toContain('HC_TEST_CONSOLE_TOKEN is not set'));
    await withToken('short', () => expect(wiring(cfg, 'prod').problems.join('\n')).toContain('shorter than 32'));
    await withToken(TOKEN, () => expect(wiring(cfg, 'prod').problems.filter((p) => p.includes('console'))).toEqual([]));

    const dir = (mkdirSync(TMP, { recursive: true }), mkdtempSync(join(TMP, 'bundle-')));
    writeFileSync(join(dir, 'icebase.config.ts'), "import { defineConfig } from '@panth977/icebase/config';\nexport default defineConfig({ name: 'b', schema: { collections: {}, paths: {}, files: {} } as never, console: { hosted: true }, environments: { prod: { mode: 'firebase' } } });\n");
    const out = await withToken(TOKEN, () => buildFunctions(cfg, 'prod', dir, () => {}));
    expect(readFileSync(join(out!, 'index.js'), 'utf8')).toContain('icebaseConsole');
    const env = readFileSync(join(out!, '.env'), 'utf8');
    expect(env).toContain(`HC_TEST_CONSOLE_TOKEN="${TOKEN}"`);
    expect(statSync(join(out!, '.env')).mode & 0o777).toBe(0o600);

    const v = hostingVersionConfig(cfg.hosting!, 'asia-south1', false, true);
    expect(v.rewrites!.slice(0, 2)).toEqual([
      { glob: '/__/icebase/console', run: { serviceId: 'icebaseconsole', region: 'asia-south1' } },
      { glob: '/__/icebase/console/**', run: { serviceId: 'icebaseconsole', region: 'asia-south1' } },
    ]);
    expect(v.rewrites!.at(-1)).toEqual({ glob: '**', path: '/index.html' });
  }, 120_000);
});
