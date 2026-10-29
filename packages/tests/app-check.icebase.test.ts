// App Check, emulator mode: the IceBase server issues tokens for debug tokens and enforces
// config.appCheck.enforce per service (admins exempt); callables get request.app.
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '@panth977/icebase/app';
import { DebugProvider, getToken as getAppCheckToken, initializeAppCheck } from '@panth977/icebase/app-check';
import { defineConfig, param } from '@panth977/icebase/config';
import { collection as coll, defineSchema, f, filePath } from '@panth977/icebase/schema';
import { collection, doc, getDoc, getFirestore, onSnapshot, setDoc } from '@panth977/icebase/firestore';
import { fetchAndActivate, getRemoteConfig } from '@panth977/icebase/remote-config';
import { getMessaging, getToken } from '@panth977/icebase/messaging';
import { getStorage, ref, uploadString } from '@panth977/icebase/storage';
import { getFunctions, httpsCallable } from '@panth977/icebase/functions';
import { getAdminAppCheck, getAdminFirestore, initializeAdminApp } from '@panth977/icebase-server/admin';
import { manageAppCheck } from '@panth977/icebase-cli/manage';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';
import fixture from './fixtures/functions-app/functions/config.js';

const notes = coll('notes', { fields: { text: f.string() }, indexes: [] });
const BUCKET = 'demo-icebase.appspot.com';
const make = (port?: number) =>
  defineConfig({
    name: 'ac-emu',
    schema: defineSchema({ notes }, { files: { any: filePath('up/{file}') } }),
    firebase: { projectId: 'demo-icebase', storageBucket: BUCKET },
    remoteConfig: { parameters: { flag: param.boolean(true) } },
    appCheck: { enforce: ['firestore', 'storage', 'remoteConfig', 'messaging'] },
    ...(port ? { emulator: { port } } : {}),
    environments: { local: { mode: 'emulator' } },
  });
const web = { apiKey: 'demo', projectId: 'demo-icebase', storageBucket: BUCKET, appId: '1:1:web:1' };

describe('app check · emulator mode', () => {
  let emu: RunningEmulator;
  let plain: IceBaseApp;
  let checked: IceBaseApp;
  let admin: IceBaseApp;
  beforeAll(async () => {
    emu = await startEmulator({ config: make(), port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
    plain = initializeApp(make(emu.port), 'local', { name: 'ac-plain', firebase: web });
    checked = initializeApp(make(emu.port), 'local', { name: 'ac-checked', firebase: web });
    initializeAppCheck(checked, { provider: new DebugProvider('dev-debug-token'), isTokenAutoRefreshEnabled: false });
    admin = initializeAdminApp(make(emu.port), 'local', { name: 'ac-admin' });
  });
  afterAll(async () => {
    for (const x of [plain, checked, admin]) await deleteApp(x);
    await emu.close();
  });

  it('enforced services refuse a client without App Check', async () => {
    await expect(setDoc(doc(collection(getFirestore(plain), notes), 'n1'), { text: 'x' })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(fetchAndActivate(getRemoteConfig(plain))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(getToken(getMessaging(plain))).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(uploadString(ref(getStorage(plain), 'up/a.txt'), 'hi')).rejects.toThrow(/unauthenticated|401|App Check/i);
    const listened = await new Promise<Error>((res) => onSnapshot(doc(collection(getFirestore(plain), notes), 'n1'), () => {}, res));
    expect(listened).toMatchObject({ code: 'unauthenticated' });
    // A forged token is no token.
    const r = await fetch(`${emu.url}/v1/rc/fetch`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-firebase-appcheck': 'a.b.c' }, body: '{}' });
    expect(r.status).toBe(401);
  });

  it('…and serve the one that initialized App Check (HTTP, the socket, the Firebase SDKs IceBase drives)', async () => {
    const db = getFirestore(checked);
    await setDoc(doc(collection(db, notes), 'n1'), { text: 'hello' });
    expect((await getDoc(doc(collection(db, notes), 'n1'))).data()).toEqual({ text: 'hello' });
    const seen = await new Promise<string>((res, rej) => {
      const un = onSnapshot(doc(collection(db, notes), 'n1'), (s) => (un(), res(s.data()!.text)), rej);
    });
    expect(seen).toBe('hello');
    expect(await fetchAndActivate(getRemoteConfig(checked))).toBe(true);
    expect(await getToken(getMessaging(checked))).toMatch(/^ib-fcm:/);
    await uploadString(ref(getStorage(checked), 'up/a.txt'), 'hi');
  });

  it('admins are exempt', async () => {
    expect((await getDoc(doc(collection(getAdminFirestore(admin), notes), 'n1'))).data()).toEqual({ text: 'hello' });
  });

  it('admin: createToken / verifyToken; the client token verifies too', async () => {
    const ac = getAdminAppCheck(admin);
    const t = await ac.createToken('my-app', { ttlMillis: 3_600_000 });
    expect(t.ttlMillis).toBe(3_600_000);
    expect(await ac.verifyToken(t.token)).toMatchObject({ appId: 'my-app' });
    await expect(ac.verifyToken(t.token.slice(0, -2) + 'xx')).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(ac.createToken('my-app', { ttlMillis: 1000 })).rejects.toThrow(/30 minutes/);
    const client = await getAppCheckToken(initializeAppCheck(initializeApp(make(emu.port), 'local', { name: 'ac-third', firebase: web }), { provider: new DebugProvider('x') }));
    expect((await ac.verifyToken(client.token)).appId).toBe('1:1:web:1');
  });
});

describe('app check · a server that signs its tokens takes registered debug tokens only', () => {
  it('exchange, register, list, delete', async () => {
    const emu = await startEmulator({ config: make(), port: 0, dataDir: ':memory:', signTokens: true, without: ['functions'], log: () => {} });
    const admin = initializeAdminApp(make(emu.port), 'local', { name: 'ac-signed-admin' });
    try {
      const exchange = (debugToken: string) => fetch(`${emu.url}/v1/appcheck/exchangeDebugToken`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ debugToken, appId: 'web' }) });
      expect((await exchange('ci-token')).status).toBe(403);
      const m = manageAppCheck(admin);
      expect(await m.createDebugToken('CI', 'ci-token')).toEqual({ name: 'CI', token: 'ci-token' });
      const made = await m.createDebugToken('laptop');
      expect(made.token).toMatch(/^[0-9a-f-]{36}$/);
      expect((await m.listDebugTokens()).map((t) => t.name)).toEqual(['CI', 'laptop']);
      const ok = (await (await exchange('ci-token')).json()) as { token: string; ttlMillis: number };
      expect(ok.ttlMillis).toBe(3_600_000);
      expect((await getAdminAppCheck(admin).verifyToken(ok.token)).appId).toBe('web');
      await m.deleteDebugToken('ci-token');
      expect((await exchange('ci-token')).status).toBe(403);
      expect(await m.setEnforcement()).toEqual({ enforced: ['firestore', 'storage', 'remoteConfig', 'messaging'], unenforced: [] });
    } finally {
      await deleteApp(admin);
      await emu.close();
    }
  });
});

describe('app check · callables', () => {
  it('config.appCheck.enforce lists functions: callables refuse callers without App Check; request.app is set', async () => {
    const cfg = (port?: number) => defineConfig({ name: 'ac-fn', schema: fixture.schema, functions: { source: 'functions' }, firebase: { projectId: 'demo-icebase', storageBucket: BUCKET }, appCheck: { enforce: ['functions'] }, ...(port ? { emulator: { port } } : {}), environments: { local: { mode: 'emulator' } } });
    const emu = await startEmulator({ config: cfg(), env: 'local', root: resolve(import.meta.dirname, 'fixtures/functions-app'), port: 0, dataDir: ':memory:', log: () => {} });
    const a = initializeApp(cfg(emu.port), 'local', { name: 'ac-fn-plain', firebase: web });
    const b = initializeApp(cfg(emu.port), 'local', { name: 'ac-fn-checked', firebase: web });
    initializeAppCheck(b, { provider: new DebugProvider('dbg') });
    try {
      const add = (x: IceBaseApp) => httpsCallable<{ a: number; b: number }, { sum: number }>(getFunctions(x), 'add');
      await expect(add(a)({ a: 1, b: 2 })).rejects.toMatchObject({ code: 'functions/unauthenticated' });
      expect((await add(b)({ a: 1, b: 2 })).data.sum).toBe(3);
      // onRequest functions are not callables: App Check does not apply (as on Firebase).
      expect((await fetch(`${emu.url}/demo-icebase/us-central1/hello/x`)).status).toBe(200);
    } finally {
      await deleteApp(a);
      await deleteApp(b);
      await emu.close();
    }
  });
});
