// Hosting on the IceBase server, as Firebase Hosting serves firebase.json: redirects first, then
// files, cleanUrls, trailingSlash, rewrites, headers, and 404.html.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig } from '@panth977/icebase/config';
import { defineSchema } from '@panth977/icebase/schema';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';

describe('hosting options · emulator mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'icebase-hosting-'));
  const servers: RunningEmulator[] = [];
  const start = async (hosting: Record<string, unknown>) => {
    const config = defineConfig({ name: 'hosting', schema: defineSchema({}), hosting: { public: 'public', ...hosting } as never, firebase: { projectId: 'demo-hosting' }, environments: { local: { mode: 'emulator' } } });
    const s = await startEmulator({ config, env: 'local', root, port: 0, dataDir: ':memory:', without: ['functions'], hosting: true, log: () => {} });
    servers.push(s);
    return (path: string, init: RequestInit = {}) => fetch(`${s.url}${path}`, { redirect: 'manual', ...init });
  };
  beforeAll(() => {
    mkdirSync(join(root, 'public', 'blog'), { recursive: true });
    writeFileSync(join(root, 'public', 'index.html'), 'home');
    writeFileSync(join(root, 'public', 'about.html'), 'about');
    writeFileSync(join(root, 'public', 'blog', 'index.html'), 'blog');
    writeFileSync(join(root, 'public', 'app.js'), 'js');
    writeFileSync(join(root, 'public', '404.html'), 'not here');
  });
  afterAll(async () => {
    for (const s of servers) await s.close();
  });

  it('cleanUrls: /about serves about.html; /about.html redirects to /about', async () => {
    const get = await start({ cleanUrls: true });
    expect(await (await get('/about')).text()).toBe('about');
    const r = await get('/about.html');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/about');
    expect((await get('/blog/index.html')).headers.get('location')).toBe('/blog/');
  });

  it('trailingSlash true adds one (not to files); false serves without it', async () => {
    const add = await start({ trailingSlash: true });
    const r = await add('/blog');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/blog/');
    expect((await add('/app.js')).status).toBe(200);
    const drop = await start({ trailingSlash: false });
    expect(await (await drop('/blog/')).text()).toBe('blog');
  });

  it('redirects come before files; headers match globs; 404.html for the rest', async () => {
    const get = await start({
      redirects: [{ source: '/old/**', destination: '/blog/', type: 302 }, { source: '/index.html', destination: '/about.html' }],
      headers: [{ source: '**/*.js', headers: { 'cache-control': 'max-age=7', 'x-js': '1' } }, { source: '!**/*.js', headers: { 'x-not-js': '1' } }],
    });
    const r = await get('/old/post/1');
    expect(r.status).toBe(302);
    expect(r.headers.get('location')).toBe('/blog/');
    expect((await get('/index.html')).status).toBe(301);
    const js = await get('/app.js');
    expect(js.headers.get('x-js')).toBe('1');
    expect(js.headers.get('cache-control')).toBe('max-age=7');
    expect(js.headers.get('x-not-js')).toBeNull();
    expect((await get('/about.html')).headers.get('x-not-js')).toBe('1');
    const nf = await get('/nope');
    expect(nf.status).toBe(404);
    expect(await nf.text()).toBe('not here');
  });

  it('rewrites to a path; the SPA fallback; a POST is not served a file', async () => {
    const get = await start({ rewrites: [{ source: '/docs/**', destination: '/about.html' }], spa: true });
    expect(await (await get('/docs/x/y')).text()).toBe('about');
    expect(await (await get('/some/route')).text()).toBe('home');
    expect((await get('/about.html', { method: 'POST' })).status).toBe(404);
  });
});
