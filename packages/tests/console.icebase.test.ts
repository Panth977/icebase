// The console on the IceBase server: the page (strict CSP), and every API operation as the admin;
// nothing for anyone else.
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig } from '@panth977/icebase/config';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';
import fixture from './fixtures/functions-app/functions/config.js';

describe('console · IceBase server', () => {
  let s: RunningEmulator;
  const config = defineConfig({ name: 'console', schema: fixture.schema, functions: { source: 'functions' }, console: { openapi: [{ title: 'REST', path: '/demo-icebase/us-central1/hello/openapi.json' }] }, firebase: { projectId: 'demo-icebase', storageBucket: 'demo-icebase.appspot.com' }, environments: { local: { mode: 'emulator' } } });
  const api = async (op: string, body: Record<string, unknown> = {}, token = 'console-admin') => {
    const r = await fetch(`${s.url}/__/icebase/console/api/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const ok = async (op: string, body: Record<string, unknown> = {}) => {
    const r = await api(op, body);
    if (r.status !== 200) throw new Error(`${op}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  beforeAll(async () => {
    s = await startEmulator({ config, env: 'local', root: resolve(import.meta.dirname, 'fixtures/functions-app'), port: 0, dataDir: ':memory:', adminToken: 'console-admin', log: () => {} });
  });
  afterAll(async () => {
    await s.close();
  });

  it('serves the page and its script with a strict CSP; the API is the admin\'s', async () => {
    const page = await fetch(`${s.url}/__/icebase/console/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('src="app.js"');
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'");
    const js = await fetch(`${s.url}/__/icebase/console/app.js`);
    expect(js.headers.get('content-type')).toContain('javascript');
    const css = await fetch(`${s.url}/__/icebase/console/app.css`);
    expect(css.headers.get('content-type')).toContain('text/css');
    expect(await css.text()).toContain('.tmark');
    // The shipped script parses (it is a string in page.ts: an escaping slip would only show in a browser).
    const { SourceTextModule } = await import('node:vm').then((m) => m as unknown as { SourceTextModule?: new (s: string) => unknown });
    const src = await js.text();
    if (SourceTextModule) new SourceTextModule(src);
    else expect(() => new Function(src)).not.toThrow();
    expect((await api('overview', {}, 'not-the-admin')).status).toBe(403);
    const o = await ok('overview');
    expect(o).toMatchObject({ name: 'console', env: 'local', modes: { firestore: 'emulator' } });
    expect(o.health.services).toContain('firestore');
  });

  it('Firestore: write through the schema, list, get, query (index-checked), delete; schema and indexes', async () => {
    await ok('fs.set', { path: 'products/p1', data: { name: 'Hat', stock: 3 } });
    expect((await api('fs.set', { path: 'products/p2', data: { name: 'Bad', stock: 'many' } })).status).toBe(400);
    expect((await ok('fs.collections')).ids).toContain('products');
    expect((await ok('fs.list', { path: 'products' })).docs.map((d: { id: string }) => d.id)).toContain('p1');
    expect((await ok('fs.get', { path: 'products/p1' })).data).toEqual({ name: 'Hat', stock: 3 });
    const refused = await api('fs.query', { path: 'products', filters: [{ field: 'stock', op: '>', value: 1 }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error.message).toMatch(/index/);
    await ok('fs.set', { path: 'seen/s1', data: { kind: 'x', detail: { at: { __ts: '2026-01-02T03:04:05.000Z' } } } });
    const q = await ok('fs.query', { path: 'seen', filters: [{ field: 'kind', op: '==', value: 'x' }] });
    expect(q.docs[0].data.detail).toEqual({ at: { __ts: '2026-01-02T03:04:05.000Z' } });
    await ok('fs.delete', { path: 'products/p1' });
    expect((await ok('fs.get', { path: 'products/p1' })).exists).toBe(false);
    expect((await ok('schema')).collections.map((c: { path: string }) => c.path)).toContain('products');
    expect((await ok('fs.indexes')).built.databases[0].documents).toBeGreaterThan(0);
  });

  it('Realtime Database: shallow tree, set, remove', async () => {
    await ok('db.set', { path: 'rooms/r1/messages/m1', value: { text: 'hi' } });
    expect((await ok('db.get', { path: 'rooms', shallow: true })).children).toEqual([{ key: 'r1', size: 1 }]);
    expect((await ok('db.get', { path: 'rooms/r1/messages/m1' })).value).toEqual({ text: 'hi' });
    await ok('db.set', { path: 'rooms/r1', value: null });
    expect((await ok('db.get', { path: 'rooms' })).value).toBeNull();
  });

  it('Authentication: create, search, claims, disable, revoke, delete', async () => {
    const u = await ok('auth.create', { email: 'c@example.com', password: 'secret1' });
    expect((await ok('auth.list', { q: 'c@example.com' })).users[0].uid).toBe(u.uid);
    expect((await ok('auth.update', { uid: u.uid, claims: { role: 'admin' }, disabled: true, revoke: true })).claims).toEqual({ role: 'admin' });
    expect((await ok('auth.list', {})).users.find((x: { uid: string }) => x.uid === u.uid).disabled).toBe(true);
    await ok('auth.delete', { uid: u.uid });
    expect((await ok('auth.list', { q: u.uid })).users).toEqual([]);
    expect(await ok('auth.config')).toMatchObject({ emulator: true });
  });

  it('Storage: upload, list with folders, read, delete', async () => {
    expect((await ok('st.buckets')).default).toBe('demo-icebase.appspot.com');
    await ok('st.upload', { name: 'docs/a.txt', contentType: 'text/plain', base64: Buffer.from('hello').toString('base64') });
    expect((await ok('st.list', { prefix: '' })).folders).toContain('docs/');
    expect((await ok('st.list', { prefix: 'docs/' })).files[0]).toMatchObject({ name: 'docs/a.txt', size: 5, contentType: 'text/plain' });
    expect(Buffer.from((await ok('st.read', { name: 'docs/a.txt' })).base64, 'base64').toString()).toBe('hello');
    await ok('st.delete', { name: 'docs/a.txt' });
    expect((await ok('st.list', { prefix: 'docs/' })).files).toEqual([]);
  });

  it('APIs: hosted functions and the app\'s OpenAPI documents; the console knows only its own deployment', async () => {
    const r = await ok('apis');
    expect(r.functions.map((f: { name: string }) => f.name)).toContain('hello');
    expect(r.openapi[0]).toMatchObject({ title: 'REST', doc: { path: '/openapi.json', method: 'GET' } });
    // No list of other deployments, and no cross-origin access to its API for anyone.
    expect((await fetch(`${s.url}/__/icebase/console/targets.json`)).status).toBe(404);
    const pre = await fetch(`${s.url}/__/icebase/console/api/overview`, { method: 'OPTIONS', headers: { origin: 'https://console.example.com' } });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
    const page = await fetch(`${s.url}/__/icebase/console/`);
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self';");
  });

  it('ICEBASE_CONSOLE_TOKEN opens the console (not the services); a wrong one does not', async () => {
    process.env.ICEBASE_CONSOLE_TOKEN = 'console-only-token';
    try {
      expect((await api('overview', {}, 'console-only-token')).status).toBe(200);
      expect((await api('overview', {}, 'console-only-tokem')).status).toBe(403);
      const fs = await fetch(`${s.url}/v1/fs/listCollections`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer console-only-token' }, body: '{}' });
      expect(fs.status).toBe(403);
    } finally {
      delete process.env.ICEBASE_CONSOLE_TOKEN;
    }
  });

  it('Schema as TypeScript; the API reference page (Scalar pinned by hash) and its script', async () => {
    const ts = (await ok('schema.ts')).blocks as { kind: string; path: string; code: string }[];
    expect(ts.find((b) => b.path === 'users/{uid}/orders')!.code).toContain('product: DocumentReference<Products>;');
    expect(ts.find((b) => b.path === 'products')!.code).toMatch(/export interface Products \{\n  name: string;\n  stock: number; \/\/ integer\n\}/);
    const page = await fetch(`${s.url}/__/icebase/console/api-reference.html`);
    const html = await page.text();
    expect(html).toMatch(/integrity="sha384-[A-Za-z0-9+/=]+" crossorigin="anonymous"/);
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self' https://cdn.jsdelivr.net");
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'self'");
    const ref = await (await fetch(`${s.url}/__/icebase/console/api-reference.js`)).text();
    expect(() => new Function(ref.replace(/\bawait\b/g, ''))).not.toThrow();
  });

  it('Functions, Hosting and Rules', async () => {
    const fns = (await ok('fn.list')).functions as { name: string; kind: string; trigger: string }[];
    expect(fns.find((f) => f.name === 'nightly')).toMatchObject({ kind: 'schedule', trigger: 'every 24 hours' });
    expect(fns.find((f) => f.name === 'onProductDeleted')?.trigger).toBe('deleted products/{productId}');
    expect((await ok('fn.run', { name: 'nightly' })).ok).toBe(true);
    expect(Array.isArray((await ok('fn.tasks')).tasks)).toBe(true);
    expect((await ok('hosting.sites')).sites[0].name).toMatch(/sites\/demo-icebase$/);
    expect((await ok('rules', { service: 'storage' })).service).toBe('storage');
    expect((await api('nope')).status).toBe(404);
  });
});
