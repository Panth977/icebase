// Functions in firebase mode on the official Functions emulator: callables (typed, validated),
// fetch-style onRequest, typed Firestore triggers. Fixture: test/fixtures/functions-app.
import { afterAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp } from '@panth977/icebase/app';
import { defineConfig } from '@panth977/icebase/config';
import { addDoc, collection, connectFirestoreEmulator, doc, getDoc, getFirestore, setDoc, updateDoc } from '@panth977/icebase/firestore';
import { connectFunctionsEmulator, getFunctions, httpsCallable } from '@panth977/icebase/functions';
import type { onCall } from '@panth977/icebase-server/functions';
import { collection as coll, defineSchema, f } from '@panth977/icebase/schema';

const FS = process.env.FIRESTORE_EMULATOR_HOST;
if (!FS) throw new Error('run under the fixture emulators');
import fixture, { orders, products, rooms, seen } from './fixtures/functions-app/functions/config.js';
void coll;
void defineSchema;
const config = defineConfig({ name: 'fn-client', schema: fixture.schema, firebase: { projectId: 'demo-icebase', storageBucket: 'demo-icebase.appspot.com', databaseURL: 'http://127.0.0.1:9009/?ns=demo-icebase-default-rtdb' }, environments: { test: { mode: 'firebase' } } });

// The type of a server callable, as the client would import it with `import type`.
declare const addFn: ReturnType<typeof onCall<{ a: number; b: number }, { sum: number; uid: string | null }>>;

describe('functions · firebase mode', () => {
  const app = initializeApp(config, 'test', { name: 'fn', firebase: { apiKey: 'demo', projectId: 'demo-icebase', storageBucket: 'demo-icebase.appspot.com', databaseURL: 'http://127.0.0.1:9009/?ns=demo-icebase-default-rtdb' } });
  const fns = getFunctions(app);
  connectFunctionsEmulator(fns, '127.0.0.1', 5011);
  const db = getFirestore(app);
  connectFirestoreEmulator(db, FS.split(':')[0]!, Number(FS.split(':')[1]));
  afterAll(() => deleteApp(app));

  it('typed callable with input validation on the server', async () => {
    const add = httpsCallable<typeof addFn>(fns, 'add');
    const r = await add({ a: 2, b: 3 });
    expect(r.data.sum).toBe(5); // r.data is { sum: number; uid: string | null }
    // @ts-expect-error b must be a number
    await expect(add({ a: 2, b: 'x' })).rejects.toMatchObject({ code: 'functions/invalid-argument' });
  });

  it('client-side input validation before the call', async () => {
    const add = httpsCallable<{ a: number; b: number }, { sum: number }>(fns, 'add', { input: f.map({ a: f.number(), b: f.number() }) });
    await expect(add({ a: 1 } as never)).rejects.toThrow(/b: expected number/);
  });

  it('fetch-style onRequest', async () => {
    const res = await fetch('http://127.0.0.1:5011/demo-icebase/us-central1/hello/some/path', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 1 }) });
    expect(res.headers.get('x-icebase')).toBe('1');
    expect(await res.json()).toEqual({ path: '/some/path', method: 'POST', body: { x: 1 } });
  });

  it('typed Firestore triggers with path params', async () => {
    const p = doc(collection(db, products), 'p1');
    await setDoc(p, { name: 'Boot', stock: 10 });
    const o = await addDoc(collection(db, orders, 'u42'), { product: p, qty: 3 });
    const until = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 60; i++) {
        if (await check()) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('trigger did not run');
    };
    await until(async () => (await getDoc(p)).data()?.stock === 7);
    await until(async () => (await getDoc(o)).data()?.note === `uid=u42 docId=${o.id}`);
    await updateDoc(o, { qty: 1 });
    await until(async () => (await getDoc(p)).data()?.stock === 9);
    const stockOf = httpsCallable<{ id: string }, { stock: number | null }>(fns, 'stockOf');
    expect((await stockOf({ id: 'p1' })).data.stock).toBe(9);
  });

  const until = async (check: () => Promise<boolean>, what = 'the function') => {
    for (let i = 0; i < 120; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`${what} did not run`);
  };
  const seenDoc = (id: string) => getDoc(doc(collection(db, seen), id));

  it('storage: onObjectFinalized gets the stored object', async () => {
    const { connectStorageEmulator, getStorage, ref, uploadBytes } = await import('@panth977/icebase/storage');
    const st = getStorage(app);
    connectStorageEmulator(st, '127.0.0.1', 9199);
    await uploadBytes(ref(st, 'in/a.txt'), new TextEncoder().encode('hello'), { contentType: 'text/plain' });
    await until(async () => (await seenDoc('upload-in_a.txt')).exists());
    expect((await seenDoc('upload-in_a.txt')).data()?.detail).toEqual({ name: 'in/a.txt', size: '5', contentType: 'text/plain' });
  });

  it('realtime database: onValueCreated with params, also for a write above the pattern', async () => {
    const { connectDatabaseEmulator, getDatabase, ref, set } = await import('@panth977/icebase/database');
    const rdb = getDatabase(app);
    connectDatabaseEmulator(rdb, '127.0.0.1', 9009);
    await set(ref(rdb, rooms, 'r1', 'm1'), { text: 'one' });
    await until(async () => (await seenDoc('msg-r1-m1')).exists());
    expect((await seenDoc('msg-r1-m1')).data()?.detail).toEqual({ text: 'one', params: { roomId: 'r1', msgId: 'm1' } });
    await set(ref(rdb, rooms, 'r2'), { a: { text: 'x' }, b: { text: 'y' } });
    await until(async () => (await seenDoc('msg-r2-a')).exists() && (await seenDoc('msg-r2-b')).exists());
  });

  it('task queues: enqueue, retry, delay', async () => {
    const enqueue = httpsCallable<Record<string, unknown>, { ok: boolean }>(fns, 'enqueueWork');
    await enqueue({ key: 'k1' });
    await enqueue({ key: 'k2', failOnce: true });
    await until(async () => (await seenDoc('task-k1')).exists());
    await until(async () => (await seenDoc('task-k2')).exists(), 'the retried task');
    expect((await seenDoc('task-k2')).data()?.attempt).toBe(1);
  });

  it('auth: beforeUserCreated can refuse or change the user; onUserCreated fires', async () => {
    const { connectAuthEmulator, createUserWithEmailAndPassword, getAuth } = await import('@panth977/icebase/auth');
    const auth = getAuth(app);
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    await expect(createUserWithEmailAndPassword(auth, 'eve@blocked.test', 'secret1')).rejects.toThrow(/blocked domain/);
    const c = await createUserWithEmailAndPassword(auth, 'ann@ok.test', 'secret1');
    expect(c.user.displayName).toBe('Gated');
    expect((await c.user.getIdTokenResult(true)).claims.tier).toBe('free');
    await until(async () => (await seenDoc(`user-${c.user.uid}`)).exists());
  });
});
