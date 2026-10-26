// icebase/compat/firestore and compat/database: the Firebase web SDK's modular API (string paths)
// over the IceBase server. The server keeps the schema, the indexes and the rules.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig } from '@panth977/icebase/config';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';
import { collection as coll, contains, defineSchema, dbPath, f, index } from '@panth977/icebase/schema';
import * as fs from '@panth977/icebase/compat/firestore';
import * as rd from '@panth977/icebase/compat/database';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /boards/{b} {
      allow read: if true;
      allow write: if request.auth != null;
      match /tickets/{t} { allow read, write: if request.auth != null; }
    }
    match /secret/{id} { allow read, write: if false; }
    match /shared/{id} {
      allow get, list: if request.auth != null && request.auth.uid in resource.data.readers;
      allow write: if request.auth != null;
    }
  }
}`;
const DB_RULES = JSON.stringify({ rules: { presence: { $b: { '.read': true, $u: { '.read': true, '.write': 'auth != null && auth.uid == $u' } } }, open: { '.read': true, '.write': true } } });

const secret = coll('secret', { fields: { x: f.string() }, indexes: [] });
const shared = coll('shared', { fields: { readers: f.array(f.string()) }, indexes: [index(contains('readers'))] });
const boards = coll('boards', { fields: { name: f.string(), n: f.number({ int: true }), owner: f.optional(f.ref(secret)), at: f.optional(f.timestamp()), tags: f.optional(f.array(f.string())) }, indexes: [index('n')] });
const tickets = coll('boards/{b}/tickets', { fields: { title: f.string(), stage: f.string(), rank: f.number() }, indexes: [index('stage', 'rank'), index('rank')], group: true });

describe('compat · web modular API on the IceBase server', () => {
  let emu: RunningEmulator;
  let token: string | null = null;
  const dir = mkdtempSync(join(tmpdir(), 'icebase-compat-web-'));
  writeFileSync(join(dir, 'firestore.rules'), RULES);
  writeFileSync(join(dir, 'database.rules.json'), DB_RULES);
  const config = defineConfig({
    name: 'compat-web',
    schema: defineSchema({ boards, tickets, secret, shared }, { paths: { presence: dbPath('presence/{b}/{u}', f.map({ online: f.boolean(), at: f.number() })), open: dbPath('open/{id}', f.map({ hi: f.number() })) } }),
    rules: { firestore: 'firestore.rules', database: 'database.rules.json' },
    auth: { providers: ['password'] },
    firebase: { projectId: 'demo-icebase' },
    emulator: { socketPath: '/live' },
    environments: { local: { mode: 'emulator' } },
  });

  let db: fs.Firestore;
  beforeAll(async () => {
    emu = await startEmulator({ config, root: dir, port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
    fs.configureIceBase({ origin: emu.url, idToken: () => token });
    db = fs.getFirestore({ name: 'web' });
    const r = await fetch(`${emu.url}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@x.test', password: 'secret1', returnSecureToken: true }) });
    token = ((await r.json()) as { idToken: string }).idToken;
  });
  afterAll(() => emu.close());

  it('writes and reads with string paths, server values and references', async () => {
    const b1 = fs.doc(db, 'boards', 'b1');
    await fs.setDoc(b1, { name: 'One', n: 1, at: fs.serverTimestamp(), tags: ['a'] });
    await fs.updateDoc(b1, { n: fs.increment(2), tags: fs.arrayUnion('b') });
    await fs.updateDoc(fs.doc(db, 'boards/b1'), 'name', 'Uno');
    const s = await fs.getDoc(b1);
    expect(s.exists()).toBe(true);
    expect(s.data()).toMatchObject({ name: 'Uno', n: 3, tags: ['a', 'b'] });
    expect(s.get('at')).toBeInstanceOf(fs.Timestamp);
    await fs.setDoc(fs.doc(db, 'boards', 'b2'), { name: 'Two', n: 5, owner: fs.doc(db, 'secret/s0') });
    const owner = (await fs.getDoc(fs.doc(db, 'boards/b2'))).data()!.owner;
    expect(owner).toBeInstanceOf(fs.DocumentReference);
    expect(owner.path).toBe('secret/s0');
    expect((await fs.getDoc(fs.doc(db, 'boards', 'none'))).exists()).toBe(false);
    const added = await fs.addDoc(fs.collection(db, 'boards'), { name: 'Three', n: 9 });
    expect(added.id).toHaveLength(20);
    await fs.deleteDoc(added);
    expect((await fs.getDoc(added)).exists()).toBe(false);
  });

  it('queries: where, orderBy, limit, cursors, documentId, collection groups, count', async () => {
    const q = fs.query(fs.collection(db, 'boards'), fs.where('n', '>=', 1), fs.orderBy('n'), fs.limit(1));
    const first = await fs.getDocs(q);
    expect(first.docs.map((d) => d.id)).toEqual(['b1']);
    const next = await fs.getDocs(fs.query(fs.collection(db, 'boards'), fs.where('n', '>=', 1), fs.orderBy('n'), fs.startAfter(first.docs[0]!), fs.limit(5)));
    expect(next.docs.map((d) => d.id)).toEqual(['b2']);
    const byId = await fs.getDocs(fs.query(fs.collection(db, 'boards'), fs.where(fs.documentId(), 'in', ['b1', 'b2'])));
    expect(byId.size).toBe(2);
    await fs.setDoc(fs.doc(db, 'boards/b1/tickets/t1'), { title: 'a', stage: 'todo', rank: 2 });
    await fs.setDoc(fs.doc(db, 'boards/b2/tickets/t2'), { title: 'b', stage: 'todo', rank: 1 });
    const g = await fs.getDocs(fs.query(fs.collectionGroup(db, 'tickets'), fs.where('stage', '==', 'todo'), fs.orderBy('rank')));
    expect(g.docs.map((d) => d.ref.path)).toEqual(['boards/b2/tickets/t2', 'boards/b1/tickets/t1']);
    expect((await fs.getCountFromServer(fs.collection(db, 'boards'))).data().count).toBe(2);
  });

  it('onSnapshot: documents and queries with docChanges', async () => {
    const seen: string[][] = [];
    const changes: string[] = [];
    const off = fs.onSnapshot(fs.query(fs.collection(db, 'boards', 'b1', 'tickets'), fs.orderBy('rank')), (s) => {
      seen.push(s.docs.map((d) => d.id));
      changes.push(...s.docChanges().map((c) => `${c.type}:${c.doc.id}`));
    }, (e) => console.error('LISTEN ERR', e));
    const wait = async (n: number) => {
      for (let i = 0; i < 100 && seen.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    };
    await wait(1);
    await fs.setDoc(fs.doc(db, 'boards/b1/tickets/t0'), { title: 'z', stage: 'todo', rank: 0 });
    await wait(2);
    await fs.deleteDoc(fs.doc(db, 'boards/b1/tickets/t1'));
    await wait(3);
    off();
    expect(seen).toEqual([['t1'], ['t0', 't1'], ['t0']]);
    expect(changes).toEqual(['added:t1', 'added:t0', 'removed:t1']);
    const docSeen: unknown[] = [];
    const offDoc = fs.onSnapshot(fs.doc(db, 'boards/b2'), { next: (s) => docSeen.push(s.data()?.n) });
    for (let i = 0; i < 100 && !docSeen.length; i++) await new Promise((r) => setTimeout(r, 20));
    offDoc();
    expect(docSeen).toEqual([5]);
  });

  it('batches and transactions', async () => {
    const b = fs.writeBatch(db);
    b.set(fs.doc(db, 'boards/x1'), { name: 'X1', n: 1 });
    b.update(fs.doc(db, 'boards/b2'), { n: 6 });
    await b.commit();
    await fs.runTransaction(db, async (tx) => {
      const s = await tx.get(fs.doc(db, 'boards/b2'));
      tx.update(fs.doc(db, 'boards/b2'), { n: s.data()!.n + 1 });
      tx.delete(fs.doc(db, 'boards/x1'));
    });
    expect((await fs.getDoc(fs.doc(db, 'boards/b2'))).data()!.n).toBe(7);
    expect((await fs.getDoc(fs.doc(db, 'boards/x1'))).exists()).toBe(false);
  });

  it('errors carry Firebase\'s string codes; undefined is refused unless ignoreUndefinedProperties', async () => {
    await expect(fs.getDoc(fs.doc(db, 'secret/s1'))).rejects.toMatchObject({ code: 'permission-denied', name: 'FirebaseError' });
    await expect(fs.setDoc(fs.doc(db, 'boards/b9'), { name: 'B', n: 'not a number' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(fs.setDoc(fs.doc(db, 'boards/b9'), { name: 'B', n: 1, tags: undefined })).rejects.toMatchObject({ code: 'invalid-argument' });
    const loose = fs.initializeFirestore({ name: 'loose' }, { ignoreUndefinedProperties: true });
    await fs.setDoc(fs.doc(loose, 'boards/b9'), { name: 'B', n: 1, tags: undefined });
    await expect(fs.getDocsFromCache(fs.collection(db, 'boards'))).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('the Realtime Database: set, get, onValue, push, server values, .info', async () => {
    const rdb = rd.getDatabase({ name: 'web' });
    const me = JSON.parse(Buffer.from(token!.split('.')[1]!, 'base64url').toString()).user_id as string;
    const p = rd.ref(rdb, `presence/b1/${me}`);
    await rd.set(p, { online: true, at: rd.serverTimestamp() });
    const s = await rd.get(p);
    expect(s.val().online).toBe(true);
    expect(typeof s.val().at).toBe('number');
    await rd.update(p, { at: { '.sv': 'timestamp' } });
    const vals: unknown[] = [];
    const off = rd.onValue(rd.ref(rdb, 'presence/b1'), (x) => vals.push(Object.keys(x.val() ?? {})), (e) => console.error('RTDB ERR', e));
    for (let i = 0; i < 100 && !vals.length; i++) await new Promise((r) => setTimeout(r, 20));
    off();
    expect(vals[0]).toEqual([me]);
    await expect(rd.set(rd.ref(rdb, 'presence/b1/someone-else'), { online: true, at: 1 })).rejects.toMatchObject({ code: 'permission-denied' });
    const pushed = rd.push(rd.ref(rdb, 'open'), { hi: 1 });
    await pushed;
    expect((await rd.get(rd.child(rd.ref(rdb, 'open'), pushed.key!))).val()).toEqual({ hi: 1 });
    expect((await rd.get(rd.ref(rdb, '.info/serverTimeOffset'))).val()).toBe(0);
  });

  it('refreshIceBaseAuth(): open listeners run again as the new caller (signed out → refused)', async () => {
    const events: string[] = [];
    const off = fs.onSnapshot(fs.collection(db, 'boards/b1/tickets'), {
      next: (s) => events.push(`snap:${s.size}`),
      error: (e) => events.push(`error:${e.code}`),
    });
    for (let i = 0; i < 100 && !events.length; i++) await new Promise((r) => setTimeout(r, 20));
    const saved = token;
    token = null;
    fs.refreshIceBaseAuth();
    for (let i = 0; i < 100 && events.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
    off();
    token = saved;
    fs.refreshIceBaseAuth();
    expect(events[0]).toMatch(/^snap:/);
    expect(events[1]).toBe('error:permission-denied');
  });

  it('list rules: array-contains proves `uid in resource.data.readers`; a query without it is refused', async () => {
    const me = JSON.parse(Buffer.from(token!.split('.')[1]!, 'base64url').toString()).user_id as string;
    await fs.setDoc(fs.doc(db, 'shared/s1'), { readers: [me, 'other'] });
    await fs.setDoc(fs.doc(db, 'shared/s2'), { readers: ['other'] });
    const mine = await fs.getDocs(fs.query(fs.collection(db, 'shared'), fs.where('readers', 'array-contains', me)));
    expect(mine.docs.map((d) => d.id)).toEqual(['s1']);
    await expect(fs.getDocs(fs.query(fs.collection(db, 'shared'), fs.where('readers', 'array-contains', 'other')))).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(fs.getDocs(fs.collection(db, 'shared'))).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('socketPath: the realtime socket on another path (one a proxy already upgrades)', async () => {
    fs.configureIceBase({ socketPath: '/live' });
    const live = fs.getFirestore({ name: 'via-live' });
    const seen: number[] = [];
    const off = fs.onSnapshot(fs.doc(live, 'boards/b2'), (s) => seen.push(s.data()?.n));
    for (let i = 0; i < 100 && !seen.length; i++) await new Promise((r) => setTimeout(r, 20));
    off();
    fs.configureIceBase({ socketPath: undefined });
    expect(seen.length).toBe(1);
    // Any other path is refused.
    const bad = await new Promise<string>((ok) => {
      const ws = new WebSocket(`${emu.url.replace('http', 'ws')}/nope`);
      ws.onopen = () => ok('open');
      ws.onerror = () => ok('refused');
    });
    expect(bad).toBe('refused');
  });
});
