// The IceBase server's storage layer (phase 3): the document engine on SQLite and, when
// ICEBASE_PG_URL names one, on Postgres; `icebase migrate` both ways; vm mode in the SDK.
// `npm test` runs the SQLite half (and migrates SQLite → SQLite); `npm run test:pg` runs it all.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, onTestFinished } from 'vitest';
import { deleteApp, initializeApp } from '@panth977/icebase/app';
import { defineConfig } from '@panth977/icebase/config';
import { collection as col, doc, getDoc, getFirestore, setDoc } from '@panth977/icebase/firestore';
import { collection, defineSchema, f, index } from '@panth977/icebase/schema';
import { dropPostgresSchemas, migrate, openStores, postgresStores, sqliteStores, startEmulator, storesAt, type Stores } from '@panth977/icebase-cli/emulator';
import { FirestoreEngine } from '@panth977/icebase-cli/internal';

const PG = process.env.ICEBASE_PG_URL;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'icebase-pg-'));
  dirs.push(d);
  return d;
};
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const people = collection('people', { fields: { name: f.string(), age: f.number(), n: f.number({ int: true }) }, indexes: [index('name'), index('age'), index('n')] });
const schema = defineSchema({ people });
const config = (mode: 'emulator' | 'vm', url = 'http://127.0.0.1:1') =>
  defineConfig({ name: 'pg-suite', schema, firebase: { projectId: 'demo-icebase' }, vm: { url, databaseUrlEnv: 'ICEBASE_TEST_DATABASE_URL' }, environments: { test: { mode } } });

const dialects: [string, () => Stores][] = [['sqlite', () => sqliteStores(':memory:')]];
if (PG) dialects.push(['postgres', () => postgresStores({ url: PG, ephemeral: true })]);

for (const [dialect, make] of dialects) {
  describe(`document engine · ${dialect}`, () => {
    it('orders strings by code point and numbers numerically, as Firestore does', async () => {
      const stores = make();
      try {
        const e = await FirestoreEngine.open({ store: await stores.open('firestore'), schema });
        const names = ['b', 'B', 'aa', 'é', 'Z', 'a', '😀', 'a b'];
        await e.commit(names.map((name, i) => ({ op: 'set', path: `people/p${i}`, data: { name, age: [10, 9, 100, -1, 2.5, 0, 1e9, 33][i]!, n: i } })));
        const byName = await e.query({ path: 'people', collectionId: 'people', filters: [], orders: [{ field: ['name'], dir: 'asc' }] });
        expect(byName.map((d) => d.data.name)).toEqual([...names].sort());
        const byAge = await e.query({ path: 'people', collectionId: 'people', filters: [{ kind: 'field', field: ['age'], op: '>=', value: 0 }], orders: [{ field: ['age'], dir: 'desc' }], limit: { n: 3, last: false } });
        expect(byAge.map((d) => d.data.age)).toEqual([1e9, 100, 33]);
        const eq = await e.query({ path: 'people', collectionId: 'people', filters: [{ kind: 'field', field: ['name'], op: 'in', value: ['é', 'Z'] }], orders: [] });
        expect(eq.map((d) => d.data.name).sort()).toEqual(['Z', 'é']);
        expect(await e.count()).toBe(names.length);
      } finally {
        await stores.close();
      }
    });

    it('concurrent transactions: one winner per version, the rest abort and retry; versions and times follow commit order', async () => {
      const stores = make();
      try {
        const e = await FirestoreEngine.open({ store: await stores.open('firestore'), schema });
        await e.commit([{ op: 'set', path: 'people/counter', data: { name: 'c', age: 0, n: 0 } }]);
        const bump = async () => {
          for (;;) {
            const cur = (await e.get('people/counter'))!;
            try {
              await e.commit([{ op: 'update', path: 'people/counter', fields: [{ path: ['n'], value: (cur.data.n as number) + 1 }] }], [{ path: 'people/counter', version: cur.version }]);
              return;
            } catch (err) {
              // Lost the race: read again and retry, as runTransaction does.
              if ((err as { code?: string }).code !== 'aborted') throw err;
            }
          }
        };
        const seen: { version: number; t: number }[] = [];
        e.onChanges((cs) => cs.forEach((c) => c.after && seen.push({ version: c.after.version, t: c.after.updateTime.s * 1e9 + c.after.updateTime.n })));
        await Promise.all(Array.from({ length: 12 }, bump));
        expect((await e.get('people/counter'))!.data.n).toBe(12);
        expect(seen).toHaveLength(12);
        const byVersion = [...seen].sort((a, b) => a.version - b.version);
        for (let i = 1; i < byVersion.length; i++) expect(byVersion[i]!.t).toBeGreaterThan(byVersion[i - 1]!.t);
      } finally {
        await stores.close();
      }
    });
  });
}

/** Data written through the server's own APIs, then read back after a migration. */
async function seed(url: string): Promise<void> {
  const post = (path: string, body: unknown, token = 'owner') => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
  expect((await post('/v1/fs/commit', { writes: [{ op: 'set', path: 'people/ada', data: { name: 'Ada', age: 36, n: 1 } }, { op: 'set', path: 'people/alan', data: { name: 'Alan', age: 41, n: 2 } }] })).status).toBe(200);
  expect((await post('/__/icebase/admin/manage/firestore/createDb', { id: 'archive' })).status).toBe(200);
  expect((await post('/v1/fs/commit', { database: 'archive', writes: [{ op: 'set', path: 'people/old', data: { name: 'Old', age: 99, n: 3 } }] })).status).toBe(200);
  expect((await post('/identitytoolkit.googleapis.com/v1/accounts:signUp?key=x', { email: 'ada@example.com', password: 'secret-123' })).status).toBe(200);
  expect((await post('/v1/db/set', { path: 'rooms/r1', value: { title: 'hello', n: 2 } })).status).toBe(200);
  const up = await fetch(`${url}/v0/b/demo-icebase.appspot.com/o?name=${encodeURIComponent('docs/a.txt')}`, { method: 'POST', headers: { authorization: 'Bearer owner', 'content-type': 'text/plain' }, body: 'file body' });
  expect(up.status).toBe(200);
  // The RTDB writes its tree 50 ms after a change.
  await new Promise((r) => setTimeout(r, 120));
}

async function check(url: string): Promise<void> {
  const post = (path: string, body: unknown, token = 'owner') => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, unknown> }));
  const got = (await post('/v1/fs/query', { spec: { path: 'people', collectionId: 'people', filters: [], orders: [{ field: ['age'], dir: 'desc' }] } })).body.docs as { data: { name: string } }[];
  // (Grace: written on the target after the first migration.)
  expect(got.map((d) => d.data.name).filter((n) => n !== 'Grace')).toEqual(['Alan', 'Ada']);
  const old = (await post('/v1/fs/get', { database: 'archive', paths: ['people/old'] })).body.docs as { data: { name: string } }[];
  expect(old[0]!.data.name).toBe('Old');
  const signIn = await post('/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=x', { email: 'ada@example.com', password: 'secret-123', returnSecureToken: true });
  expect(signIn.status).toBe(200);
  expect(typeof signIn.body.idToken).toBe('string');
  const room = await post('/v1/db/get', { path: 'rooms/r1' });
  expect(JSON.stringify(room.body)).toContain('hello');
  const file = await fetch(`${url}/v0/b/demo-icebase.appspot.com/o/${encodeURIComponent('docs/a.txt')}?alt=media`, { headers: { authorization: 'Bearer owner' } });
  expect(file.status).toBe(200);
  expect(await file.text()).toBe('file body');
}

const dump = async (stores: Stores) => {
  try {
    const e = await FirestoreEngine.open({ store: await stores.open('firestore'), schema });
    const out = [];
    for await (const d of e.scan()) out.push(d);
    return out;
  } finally {
    await stores.close();
  }
};

describe('icebase migrate', () => {
  it(`SQLite → ${PG ? 'Postgres → SQLite' : 'SQLite'}: every store, documents with their versions and times, users who still sign in`, async () => {
    const a = tmp();
    const s1 = await startEmulator({ config: config('emulator'), port: 0, dataDir: a, databaseUrl: null, without: ['functions'], log: () => {} });
    await seed(s1.url);
    await s1.close();
    const before = await dump(sqliteStores(a));

    // Into the target: Postgres (a prefix of this test's own) or another SQLite directory.
    const prefix = `ibm_${Math.random().toString(36).slice(2, 8)}_`;
    if (PG) onTestFinished(() => dropPostgresSchemas(PG, prefix).then(() => {}));
    const target = () => (PG ? postgresStores({ url: PG, prefix }) : sqliteStores(join(a, '..', `${a.split('/').pop()}-b`)));
    let src = sqliteStores(a);
    let dst = target();
    const r = await migrate(src, dst);
    await src.close();
    await dst.close();
    expect(r.stores.map((x) => x.name)).toEqual(['appcheck', 'auth', 'database', 'firestore', 'firestore-archive', 'messaging', 'remoteconfig', 'storage']);
    expect(r.stores.find((x) => x.name === 'firestore')!.rows.docs).toBe(2);

    // A second run into data is refused unless replace.
    src = sqliteStores(a);
    dst = target();
    await expect(migrate(src, dst)).rejects.toThrow(/already has data/);
    await migrate(src, dst, { replace: true });
    await src.close();
    await dst.close();

    // The server on the target, in a new data directory (the stored files stay where they were).
    const b = tmp();
    const s2 = await startEmulator({
      config: config('emulator'),
      port: 0,
      dataDir: PG ? b : join(a, '..', `${a.split('/').pop()}-b`),
      ...(PG ? { databaseUrl: PG, databasePrefix: prefix } : { databaseUrl: null }),
      blobsDir: join(a, 'storage'),
      without: ['functions'],
      log: () => {},
    });
    try {
      await check(s2.url);
      // Writing goes on from the migrated version.
      const v = (await s2.context.firestore.commit([{ op: 'set', path: 'people/grace', data: { name: 'Grace', age: 50, n: 4 } }])).changes[0]!.after!.version;
      expect(v).toBeGreaterThan(Math.max(...before.map((d) => d.version)));
    } finally {
      await s2.close();
    }

    if (PG) {
      // And back: Postgres → SQLite gives the same documents (plus the one written since).
      const c = tmp();
      src = postgresStores({ url: PG, prefix });
      dst = sqliteStores(c);
      await migrate(src, dst);
      await src.close();
      await dst.close();
      const after = await dump(sqliteStores(c));
      expect(after.filter((d) => d.path !== 'people/grace')).toEqual(before);
      const s3 = await startEmulator({ config: config('emulator'), port: 0, dataDir: c, databaseUrl: null, blobsDir: join(a, 'storage'), without: ['functions'], log: () => {} });
      try {
        await check(s3.url);
      } finally {
        await s3.close();
      }
    }
  });

  it('storesAt: sqlite:DIR, a bare directory, postgres://…, env:NAME', () => {
    expect(storesAt('sqlite:/tmp/x').dialect).toBe('sqlite');
    expect(storesAt('/tmp/x').dialect).toBe('sqlite');
    expect(storesAt('postgres://u:p@h:5432/d').dialect).toBe('postgres');
    expect(storesAt('env:DB', { env: { DB: 'postgresql://u@h/d' } }).dialect).toBe('postgres');
    expect(() => storesAt('env:NOPE', { env: {} })).toThrow(/not set/);
  });
});

describe('vm mode', () => {
  it('the SDK talks to the IceBase server at vm.url, as in emulator mode', async () => {
    const s = await startEmulator({ config: config('emulator'), port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
    try {
      const app = initializeApp(config('vm', s.url), 'test', { name: 'vm-mode' });
      expect(app.declaredModes.firestore).toBe('vm');
      expect(app.modes.firestore).toBe('emulator');
      const db = getFirestore(app);
      await setDoc(doc(col(db, people), 'vm1'), { name: 'Vm', age: 1, n: 1 });
      expect((await getDoc(doc(col(db, people), 'vm1'))).data()?.name).toBe('Vm');
      expect((await s.context.firestore.get('people/vm1'))?.data.name).toBe('Vm');
      await deleteApp(app);
    } finally {
      await s.close();
    }
  });

  it('serve --env with vm mode needs the Postgres URL from vm.databaseUrlEnv', async () => {
    const { serve } = await import('@panth977/icebase-cli/emulator');
    const adminToken = process.env.ICEBASE_ADMIN_TOKEN;
    afterAll(() => {
      if (adminToken === undefined) delete process.env.ICEBASE_ADMIN_TOKEN;
      else process.env.ICEBASE_ADMIN_TOKEN = adminToken;
    });
    delete process.env.ICEBASE_TEST_DATABASE_URL;
    await expect(serve({ config: config('vm'), env: 'test', port: 0, host: '127.0.0.1', dataDir: ':memory:', adminToken: 'vm-admin', without: ['functions'], log: () => {} })).rejects.toThrow(/ICEBASE_TEST_DATABASE_URL/);
    if (!PG) return;
    process.env.ICEBASE_TEST_DATABASE_URL = PG;
    const s = await serve({ config: config('vm'), env: 'test', port: 0, host: '127.0.0.1', dataDir: ':memory:', adminToken: 'vm-admin', without: ['functions'], log: () => {} });
    try {
      expect(s.context.stores.dialect).toBe('postgres');
    } finally {
      await s.close();
      delete process.env.ICEBASE_TEST_DATABASE_URL;
    }
  });
});

// openStores: the server's choice.
it('openStores: Postgres with a connection string, else SQLite', () => {
  expect(openStores({ dataDir: ':memory:' }).dialect).toBe('sqlite');
  expect(openStores({ dataDir: ':memory:', databaseUrl: 'postgres://u@h/d' }).dialect).toBe('postgres');
});
