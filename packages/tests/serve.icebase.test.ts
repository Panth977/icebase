// `icebase serve`: one port for the services, the functions and hosting (function rewrites run in
// the same process), production file serving, signed tokens and a secret admin token.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig } from '@panth977/icebase/config';
import { serve, type RunningEmulator } from '@panth977/icebase-cli/emulator';

import fixture from './fixtures/functions-app/functions/config.js';

describe('icebase serve', () => {
  let s: RunningEmulator;
  let url: string;
  const web = mkdtempSync(join(tmpdir(), 'icebase-serve-'));
  const data = mkdtempSync(join(tmpdir(), 'icebase-serve-data-'));
  beforeAll(async () => {
    writeFileSync(join(web, 'index.html'), '<!doctype html><title>app</title>');
    mkdirSync(join(web, 'assets'));
    writeFileSync(join(web, 'assets', 'app.123.js'), `console.log(${JSON.stringify('x'.repeat(4000))});`);
    const config = defineConfig({
      name: 'serve',
      schema: fixture.schema,
      functions: { source: 'functions' },
      firebase: { projectId: 'demo-icebase', storageBucket: 'demo-icebase.appspot.com' },
      hosting: { public: web, spa: true, rewrites: [{ source: '/api/**', function: 'hello' }], headers: [{ source: '**/*.js', headers: { 'x-served': 'yes' } }] },
      environments: { local: { mode: 'emulator' } },
    });
    delete process.env.ICEBASE_ADMIN_TOKEN;
    s = await serve({ config, env: 'local', root: resolve(import.meta.dirname, 'fixtures/functions-app'), port: 0, host: '127.0.0.1', dataDir: data, log: () => {} });
    url = s.url;
  });
  afterAll(async () => {
    await s.close();
    delete process.env.ICEBASE_ADMIN_TOKEN;
  });

  it('hosting: files, the SPA fallback, compression, ETag and long caching of hashed assets', async () => {
    const page = await fetch(`${url}/boards/x`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<title>app</title>');
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const js = await fetch(`${url}/assets/app.123.js`, { headers: { 'accept-encoding': 'gzip' } });
    expect(js.headers.get('cache-control')).toContain('immutable');
    expect(js.headers.get('x-served')).toBe('yes');
    const etag = js.headers.get('etag')!;
    expect(etag).toBeTruthy();
    const again = await fetch(`${url}/assets/app.123.js`, { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    // fetch decodes gzip itself; the raw body is checked through node's http.
    const http = await import('node:http');
    const raw = await new Promise<{ enc: string | undefined; body: Buffer }>((ok) =>
      http.get(`${url}/assets/app.123.js`, { headers: { 'accept-encoding': 'gzip' } }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => ok({ enc: r.headers['content-encoding'], body: Buffer.concat(chunks) }));
      }),
    );
    expect(raw.enc).toBe('gzip');
    expect(gunzipSync(raw.body).toString()).toContain('xxxx');
  });

  it('a function rewrite runs in the same process and sees the original path', async () => {
    const r = await fetch(`${url}/api/things?q=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 1 }) });
    expect(await r.json()).toEqual({ path: '/api/things', method: 'POST', body: { a: 1 } });
  });

  it('the services answer on the same port; the admin token is a secret kept in the data directory', async () => {
    const health = await (await fetch(`${url}/__/icebase/health`)).json();
    expect(health.services).toContain('firestore');
    const { readFileSync } = await import('node:fs');
    const token = readFileSync(join(data, 'admin-token'), 'utf8').trim();
    expect(token.length).toBeGreaterThan(20);
    expect(process.env.ICEBASE_ADMIN_TOKEN).toBe(token);
    expect((await fetch(`${url}/emulator/v1/projects/demo-icebase/oobCodes`, { headers: { authorization: 'Bearer owner' } })).status).toBe(403);
    expect((await fetch(`${url}/emulator/v1/projects/demo-icebase/oobCodes`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });

  it('auth emails: the link is mailed by the sendAuthEmail export and goes straight to the app', async () => {
    const post = (op: string, body: object) =>
      fetch(`${url}/identitytoolkit.googleapis.com/v1/accounts:${op}?key=x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const mailOf = async (id: string) => {
      for (let i = 0; i < 50; i++) {
        const d = s.context.firestore.get(`seen/${id}`) as { data?: { detail?: { link?: string } } } | null;
        if (d?.data?.detail?.link) return d.data.detail.link;
        await new Promise((ok) => setTimeout(ok, 50));
      }
      throw new Error(`no mail ${id}`);
    };
    await post('sendOobCode', { requestType: 'EMAIL_SIGNIN', email: 'Link@X.test', continueUrl: 'https://app.test/finish?next=/b' });
    const link = await mailOf('mail-signIn-link_x_test');
    expect(link.startsWith('https://app.test/finish?next=/b&mode=signIn&')).toBe(true);
    const oobCode = new URL(link).searchParams.get('oobCode');
    const signed = await post('signInWithEmailLink', { email: 'link@x.test', oobCode });
    expect(signed.idToken).toBeTruthy();
    // verifyBeforeUpdateEmail: the code goes to the new address; applying it changes the email.
    await post('sendOobCode', { requestType: 'VERIFY_AND_CHANGE_EMAIL', idToken: signed.idToken, newEmail: 'new@x.test', continueUrl: 'https://app.test/' });
    const change = new URL(await mailOf('mail-verifyAndChangeEmail-new_x_test')).searchParams.get('oobCode');
    expect((await post('update', { oobCode: change })).email).toBe('new@x.test');
    // A reset for an address with no account says nothing.
    expect((await post('sendOobCode', { requestType: 'PASSWORD_RESET', email: 'nobody@x.test' })).error).toBeUndefined();
  });

  it('storage: the GCS API is the admin\'s; a bare /b/… page stays the app\'s', async () => {
    const { initializeAdminApp, getAdminStorage } = await import('@panth977/icebase-server/admin');
    const cfg = defineConfig({ name: 'serve-admin', schema: fixture.schema, firebase: { projectId: 'demo-icebase', storageBucket: 'demo-icebase.appspot.com' }, environments: { local: { mode: 'emulator' } } });
    const admin = initializeAdminApp(cfg, 'local', { name: 'serve-admin', emulator: { origin: url } as never });
    const file = getAdminStorage(admin).bucket().file('docs/a.txt');
    await file.save('hello', { contentType: 'text/plain' });
    const big = getAdminStorage(admin).bucket().file('docs/big.bin');
    await big.save(Buffer.alloc(6 * 1024 * 1024, 7));
    expect(String((await file.download())[0])).toBe('hello');
    expect((await big.getMetadata())[0].size).toBe(String(6 * 1024 * 1024));
    // Without the admin token, the GCS API is refused …
    expect((await fetch(`${url}/storage/v1/b/demo-icebase.appspot.com/o`)).status).toBe(403);
    // … and /b/<board> is the web app.
    expect(await (await fetch(`${url}/b/board-1`)).text()).toContain('<title>app</title>');
  });
});
