// Functions in emulator mode: the fixture's functions source runs inside the IceBase server.
// Same fixture and assertions as functions.emu.test.ts (Firebase's Functions emulator).
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '../src/app.js';
import { defineConfig } from '../src/config.js';
import { startEmulator, type RunningEmulator } from '../src/emulator/server.js';
import { addDoc, collection, doc, getDoc, getFirestore, setDoc, updateDoc } from '../src/firestore.js';
import { getFunctions, httpsCallable } from '../src/functions.js';
import { collection as coll, defineSchema, f } from '../src/schema.js';

const products = coll('products', { fields: { name: f.string(), stock: f.number({ int: true }) }, indexes: [] });
const orders = coll('users/{uid}/orders', { fields: { product: f.ref(products), qty: f.number({ int: true, min: 1 }), note: f.optional(f.string()) }, indexes: [] });
const make = (port?: number) => defineConfig({ name: 'fn-emu', schema: defineSchema({ products, orders }), functions: { source: 'functions' }, firebase: { projectId: 'demo-icebase' }, ...(port ? { emulator: { port } } : {}), environments: { local: { mode: 'emulator' } } });

describe('functions · emulator mode', () => {
  let emu: RunningEmulator;
  let app: IceBaseApp;
  beforeAll(async () => {
    emu = await startEmulator({ config: make(), env: 'local', root: resolve(import.meta.dirname, 'fixtures/functions-app'), port: 0, dataDir: ':memory:', log: () => {} });
    app = initializeApp(make(emu.port), 'local', { name: 'fn-emu', firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
  });
  afterAll(async () => {
    await deleteApp(app);
    await emu.close();
  });

  it('callable with server-side input validation', async () => {
    const add = httpsCallable<{ a: number; b: number }, { sum: number }>(getFunctions(app), 'add');
    expect((await add({ a: 2, b: 3 })).data.sum).toBe(5);
    await expect(add({ a: 2, b: 'x' } as never)).rejects.toMatchObject({ code: 'functions/invalid-argument' });
  });

  it('fetch-style onRequest', async () => {
    const res = await fetch(`${emu.url}/demo-icebase/us-central1/hello/some/path`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 1 }) });
    expect(res.headers.get('x-icebase')).toBe('1');
    expect(await res.json()).toEqual({ path: '/some/path', method: 'POST', body: { x: 1 } });
  });

  it('typed Firestore triggers with path params', async () => {
    const db = getFirestore(app);
    const p = doc(collection(db, products), 'p1');
    await setDoc(p, { name: 'Boot', stock: 10 });
    const o = await addDoc(collection(db, orders, 'u42'), { product: p, qty: 3 });
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 80; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('trigger did not run');
    };
    await until(async () => (await getDoc(p)).data()?.stock === 7);
    await until(async () => (await getDoc(o)).data()?.note === `uid=u42 docId=${o.id}`);
    await updateDoc(o, { qty: 1 });
    await until(async () => (await getDoc(p)).data()?.stock === 9);
    const stockOf = httpsCallable<{ id: string }, { stock: number | null }>(getFunctions(app), 'stockOf');
    expect((await stockOf({ id: 'p1' })).data.stock).toBe(9);
  });
});
