// Functions in emulator mode: the fixture's functions source runs inside the IceBase server.
// Same fixture and assertions as functions.emu.test.ts (Firebase's Functions emulator).
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '@panth977/icebase/app';
import { defineConfig } from '@panth977/icebase/config';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';
import { addDoc, collection, doc, getDoc, getFirestore, setDoc, updateDoc } from '@panth977/icebase/firestore';
import { getFunctions, httpsCallable } from '@panth977/icebase/functions';
import { collection as coll, defineSchema, f } from '@panth977/icebase/schema';

import fixture, { api, orders, products, rooms, seen } from './fixtures/functions-app/functions/config.js';
const make = (port?: number) => defineConfig({ name: 'fn-emu', schema: fixture.schema, functions: { source: 'functions' }, firebase: { projectId: 'demo-icebase', storageBucket: 'demo-icebase.appspot.com' }, ...(port ? { emulator: { port } } : {}), environments: { local: { mode: 'emulator' } } });
void coll;
void f;
void defineSchema;

describe('functions · emulator mode', () => {
  let emu: RunningEmulator;
  let app: IceBaseApp;
  beforeAll(async () => {
    emu = await startEmulator({ config: make(), env: 'local', root: resolve(import.meta.dirname, 'fixtures/functions-app'), port: 0, dataDir: ':memory:', log: (l) => /failed|threw|gave up/.test(l) && console.log(l) });
    app = initializeApp(make(emu.port), 'local', { name: 'fn-emu', firebase: { apiKey: 'demo', projectId: 'demo-icebase', storageBucket: 'demo-icebase.appspot.com' } });
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

  const until = async (check: () => Promise<boolean>, what = 'the function') => {
    for (let i = 0; i < 100; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`${what} did not run`);
  };
  const seenDoc = (id: string) => getDoc(doc(collection(getFirestore(app), seen), id));

  it('storage: onObjectFinalized gets the stored object', async () => {
    const { getStorage, ref, uploadBytes } = await import('@panth977/icebase/storage');
    await uploadBytes(ref(getStorage(app), 'in/a.txt'), new TextEncoder().encode('hello'), { contentType: 'text/plain' });
    await until(async () => (await seenDoc('upload-in_a.txt')).exists());
    expect((await seenDoc('upload-in_a.txt')).data()?.detail).toEqual({ name: 'in/a.txt', size: '5', contentType: 'text/plain' });
  });

  it('realtime database: onValueCreated with params, also for a write above the pattern', async () => {
    const { getDatabase, ref, set } = await import('@panth977/icebase/database');
    const rdb = getDatabase(app);
    await set(ref(rdb, rooms, 'r1', 'm1'), { text: 'one' });
    await until(async () => (await seenDoc('msg-r1-m1')).exists());
    expect((await seenDoc('msg-r1-m1')).data()?.detail).toEqual({ text: 'one', params: { roomId: 'r1', msgId: 'm1' } });
    await set(ref(rdb, rooms, 'r2'), { a: { text: 'x' }, b: { text: 'y' } });
    await until(async () => (await seenDoc('msg-r2-a')).exists() && (await seenDoc('msg-r2-b')).exists());
  });

  it('task queues: enqueue, retry with backoff, delay', async () => {
    const enqueue = httpsCallable<Record<string, unknown>, { ok: boolean }>(getFunctions(app), 'enqueueWork');
    await enqueue({ key: 'k1' });
    await enqueue({ key: 'k2', failOnce: true });
    await until(async () => (await seenDoc('task-k1')).exists());
    await until(async () => (await seenDoc('task-k2')).exists(), 'the retried task');
    expect((await seenDoc('task-k2')).data()?.attempt).toBe(1);
    const t0 = Date.now();
    await enqueue({ key: 'k3', delay: 1 });
    await until(async () => (await seenDoc('task-k3')).exists(), 'the delayed task');
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  });

  it('auth: beforeUserCreated can refuse or change the user; onUserCreated fires', async () => {
    const { createUserWithEmailAndPassword, getAuth } = await import('@panth977/icebase/auth');
    const auth = getAuth(app);
    await expect(createUserWithEmailAndPassword(auth, 'eve@blocked.test', 'secret1')).rejects.toThrow(/blocked domain/);
    const c = await createUserWithEmailAndPassword(auth, 'ann@ok.test', 'secret1');
    expect(c.user.displayName).toBe('Gated');
    expect((await c.user.getIdTokenResult(true)).claims.tier).toBe('free');
    await until(async () => (await seenDoc(`user-${c.user.uid}`)).exists());
  });

  it('messaging: admin send lands in the outbox', async () => {
    const notify = httpsCallable<{ token: string }, { id: string }>(getFunctions(app), 'notify');
    const r = await notify({ token: 'device-1' });
    expect(r.data.id).toMatch(/^projects\/demo-icebase\/messages\//);
    const out = (await (await fetch(`${emu.url}/__/icebase/messaging/outbox`, { headers: { authorization: 'Bearer owner' } })).json()) as { messages: { message: { token: string } }[] };
    expect(out.messages.at(-1)?.message.token).toBe('device-1');
  });

  it('declared endpoints: callable and HTTP, input and output checked on both sides', async () => {
    const { callable, request } = await import('@panth977/icebase/functions');
    const fns = getFunctions(app);
    expect(await callable(fns, api.addOne)({ n: 41 })).toEqual({ n: 42 });
    // Refused before it leaves (client-side check)…
    await expect(callable(fns, api.addOne)({ n: 'x' } as never)).rejects.toThrow(/n: expected number/);
    // …and by the server when a caller skips the client.
    await expect(httpsCallable(fns, 'addOne')({ n: 'x' })).rejects.toMatchObject({ code: 'functions/invalid-argument' });
    // A handler returning what its declaration does not allow is a server error.
    await expect(callable(fns, api.badOutput)({})).rejects.toMatchObject({ code: 'functions/internal' });
    // auth: 'signed-in' by default.
    const { getAuth, signOut } = await import('@panth977/icebase/auth');
    await signOut(getAuth(app));
    await expect(callable(fns, api.whoAmI)({})).rejects.toMatchObject({ code: 'functions/unauthenticated' });
    // HTTP: path params + query, JSON out, declared errors.
    const db = getFirestore(app);
    await setDoc(doc(collection(db, products), 'px'), { name: 'Hat', stock: 4 });
    expect(await request(fns, api.productInfo, { id: 'px', upper: true })).toEqual({ name: 'HAT', stock: 4 });
    await expect(request(fns, api.productInfo, { id: 'nope' })).rejects.toMatchObject({ code: 'not-found' });
    const raw = await fetch(`${emu.url}/demo-icebase/us-central1/productInfo/products/px?upper=nope-not-bool`);
    expect(raw.status).toBe(200); // 'upper' is read as a boolean (anything but "true" is false)
    const bad = await fetch(`${emu.url}/demo-icebase/us-central1/productInfo/products/px`, { method: 'POST' });
    expect(bad.status).toBe(400);
  });
});
