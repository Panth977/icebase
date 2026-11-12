// The console's Firestore browser on the IceBase server, like the Firebase console: collections
// that are only on the way to a declared one (auth → auth/{section}/emails), documents with no
// fields that hold subcollections, and collections the schema does not declare (read-only).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig } from '@panth977/icebase/config';
import { collection, defineSchema, f } from '@panth977/icebase/schema';
import { deleteApp } from '@panth977/icebase/app';
import { getAdminFirestore, initializeAdminApp } from '@panth977/icebase-server/admin';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';

const emails = collection('auth/{section}/emails', { fields: { uid: f.string() }, indexes: [] });
const orders = collection('payments/{uid}/orders', { fields: { amount: f.number() }, indexes: [] });
const owned = collection('payments/{uid}/owned', { fields: { at: f.number() }, indexes: [] });
const products = collection('products', { fields: { name: f.string() }, indexes: [] });

describe('console · browsing in-between and undeclared collections', () => {
  let s: RunningEmulator;
  const config = defineConfig({ name: 'browse', schema: defineSchema({ emails, orders, owned, products }), firebase: { projectId: 'demo-browse' }, environments: { local: { mode: 'emulator' } } });
  const api = async (op: string, body: Record<string, unknown> = {}) => {
    const r = await fetch(`${s.url}/__/icebase/console/api/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer browse-admin' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const ok = async (op: string, body: Record<string, unknown> = {}) => {
    const r = await api(op, body);
    if (r.status !== 200) throw new Error(`${op}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  /** Data the schema does not declare, written as an admin seeding legacy data would. */
  const seed = async (writes: { path: string; data: Record<string, unknown> }[]) => {
    const r = await fetch(`${s.url}/v1/fs/commit`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer browse-admin' }, body: JSON.stringify({ writes: writes.map((w) => ({ op: 'set', ...w })), unchecked: true }) });
    expect(r.status).toBe(200);
  };

  beforeAll(async () => {
    s = await startEmulator({ config, env: 'local', port: 0, dataDir: ':memory:', adminToken: 'browse-admin', log: () => {} });
    await ok('fs.set', { path: 'auth/generations/emails/a@x.in', data: { uid: 'u1' } });
    await ok('fs.set', { path: 'auth/generations/emails/b@x.in', data: { uid: 'u2' } });
    await ok('fs.set', { path: 'payments/u1/orders/o1', data: { amount: 399 } });
    await ok('fs.set', { path: 'payments/u2/owned/detective', data: { at: 1 } });
    await ok('fs.set', { path: 'products/p1', data: { name: 'Hat' } });
    await seed([
      { path: 'legacy/l2', data: { note: 'second' } },
      { path: 'legacy/l1', data: { note: 'first', n: 1 } },
      { path: 'legacy/l3/history/h1', data: { at: 5 } },
      // Deep only: a/x has nothing directly under it but a/x/b/y/c/z.
      { path: 'deep/x/b/y/c/z', data: { k: 1 } },
    ]);
  });
  afterAll(async () => {
    await s.close();
  });

  it('auth → generations (no fields) → emails → a document', async () => {
    expect((await ok('fs.collections')).ids).toEqual(['auth', 'deep', 'legacy', 'payments', 'products']);
    const auth = await ok('fs.list', { path: 'auth' });
    expect(auth).toMatchObject({ declared: null, undeclared: true, leadsTo: ['auth/{section}/emails'] });
    expect(auth.docs).toEqual([{ id: 'generations', path: 'auth/generations', data: null, missing: true }]);
    const gen = await ok('fs.get', { path: 'auth/generations' });
    expect(gen).toMatchObject({ exists: false, data: null, declared: null, undeclared: true });
    expect((await ok('fs.collections', { path: 'auth/generations' })).ids).toEqual(['emails']);
    const list = await ok('fs.list', { path: 'auth/generations/emails' });
    expect(list.declared).toBe('auth/{section}/emails');
    expect(list.undeclared).toBeUndefined();
    expect(list.docs.map((d: { id: string }) => d.id)).toEqual(['a@x.in', 'b@x.in']);
    expect(await ok('fs.get', { path: 'auth/generations/emails/a@x.in' })).toMatchObject({ exists: true, data: { uid: 'u1' }, declared: 'auth/{section}/emails' });
  });

  it('payments/{uid} documents hold only subcollections; pages by id', async () => {
    const p = await ok('fs.list', { path: 'payments' });
    expect(p.leadsTo).toEqual(['payments/{uid}/orders', 'payments/{uid}/owned']);
    expect(p.docs.map((d: { id: string; missing: boolean }) => [d.id, d.missing])).toEqual([['u1', true], ['u2', true]]);
    expect((await ok('fs.list', { path: 'payments', limit: 1 })).docs.map((d: { id: string }) => d.id)).toEqual(['u1']);
    expect((await ok('fs.list', { path: 'payments', after: 'u1' })).docs.map((d: { id: string }) => d.id)).toEqual(['u2']);
    expect((await ok('fs.collections', { path: 'payments/u2' })).ids).toEqual(['owned']);
  });

  it('an undeclared collection with data is listed read-only; writes are refused', async () => {
    const l = await ok('fs.list', { path: 'legacy' });
    expect(l).toMatchObject({ declared: null, undeclared: true, leadsTo: [] });
    expect(l.docs).toEqual([
      { id: 'l1', path: 'legacy/l1', data: { note: 'first', n: 1 }, missing: false },
      { id: 'l2', path: 'legacy/l2', data: { note: 'second' }, missing: false },
      { id: 'l3', path: 'legacy/l3', data: null, missing: true },
    ]);
    expect(await ok('fs.get', { path: 'legacy/l1' })).toMatchObject({ exists: true, data: { note: 'first', n: 1 }, undeclared: true });
    expect((await ok('fs.list', { path: 'legacy/l3/history' })).docs[0]).toMatchObject({ id: 'h1', data: { at: 5 }, missing: false });
    for (const [op, body] of [['fs.set', { path: 'legacy/l1', data: { note: 'x' } }], ['fs.delete', { path: 'legacy/l1' }], ['fs.set', { path: 'auth/generations', data: {} }]] as const) {
      const r = await api(op, body);
      expect(r.status).toBe(400);
      expect(r.body.error.message).toMatch(/not a collection in the schema, so the console only reads it/);
    }
    expect((await ok('fs.get', { path: 'legacy/l1' })).data.note).toBe('first');
  });

  it('collections that hold documents only deep down are listed at every level', async () => {
    expect((await ok('fs.list', { path: 'deep' })).docs).toEqual([{ id: 'x', path: 'deep/x', data: null, missing: true }]);
    expect((await ok('fs.collections', { path: 'deep/x' })).ids).toEqual(['b']);
    expect((await ok('fs.list', { path: 'deep/x/b' })).docs.map((d: { id: string; missing: boolean }) => [d.id, d.missing])).toEqual([['y', true]]);
    expect((await ok('fs.collections', { path: 'deep/x/b/y' })).ids).toEqual(['c']);
  });

  it('declared collections are as before: listed by query, written through the schema', async () => {
    const p = await ok('fs.list', { path: 'products' });
    expect(p).toEqual({ declared: 'products', docs: [{ id: 'p1', path: 'products/p1', data: { name: 'Hat' } }] });
    expect((await api('fs.set', { path: 'products/p2', data: { name: 3 } })).status).toBe(400);
    await ok('fs.set', { path: 'products/p2', data: { name: 'Cap' } });
    await ok('fs.delete', { path: 'products/p2' });
    expect((await ok('fs.get', { path: 'products/p2' })).exists).toBe(false);
  });

  it('the admin driver lists document ids (missing ones too); others may not', async () => {
    const app = initializeAdminApp(config, 'local', { name: 'browse-admin', emulator: { origin: s.url, adminToken: 'browse-admin' } });
    const d = (getAdminFirestore(app) as unknown as { _driver: { listDocumentIds(p: string, o?: { limit?: number; after?: string }): Promise<{ id: string; exists: boolean }[]> } })._driver;
    expect(await d.listDocumentIds('legacy')).toEqual([{ id: 'l1', exists: true }, { id: 'l2', exists: true }, { id: 'l3', exists: false }]);
    expect(await d.listDocumentIds('legacy', { after: 'l1', limit: 1 })).toEqual([{ id: 'l2', exists: true }]);
    const r = await fetch(`${s.url}/v1/fs/listDocumentIds`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'legacy' }) });
    expect(r.status).toBe(403);
    await deleteApp(app);
  });
});
