// icebase/manage in emulator mode: the IceBase server's management API — named Firestore
// databases and RTDB instances, the schema and rules released at run time, buckets, sign-in
// methods, Hosting sites, deploys and custom domains.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '@panth977/icebase/app';
import { defineConfig } from '@panth977/icebase/config';
import { getAuth, signInAnonymously, createUserWithEmailAndPassword, signInWithEmailAndPassword } from '@panth977/icebase/auth';
import { collection as fsCollection, doc, getDoc, getDocs, getFirestore, query, setDoc, where } from '@panth977/icebase/firestore';
import { getDatabase, ref, get as dbGet, set as dbSet } from '@panth977/icebase/database';
import { initializeAdminApp, getAdminFirestore } from '@panth977/icebase-server/admin';
import { serve, type RunningEmulator } from '@panth977/icebase-cli/emulator';
import { manageAuth, manageDatabase, manageFirestore, manageHosting, manageStorage } from '@panth977/icebase-cli/manage';
import { collection, dbPath, defineSchema, f, index, schemaFromJson, schemaToJson } from '@panth977/icebase/schema';

const notes = collection('notes', { fields: { text: f.string(), owner: f.string(), tags: f.array(f.string()) }, indexes: [index('owner')] });
const links = collection('links', { fields: { to: f.ref(notes), weight: f.optional(f.number()) }, indexes: [] });
const chat = dbPath('chat/{id}', f.map({ text: f.string() }));
const schema = defineSchema({ notes, links }, { paths: { chat } });

const OPEN = `rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{d=**} { allow read, write: if true; } } }`;
const CLOSED = `rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{d=**} { allow read, write: if false; } } }`;

describe('icebase/manage · emulator mode', () => {
  let s: RunningEmulator;
  let admin: IceBaseApp;
  let client: IceBaseApp;
  const root = mkdtempSync(join(tmpdir(), 'icebase-manage-'));
  const web = join(root, 'public');
  const make = (port = 0, sch: typeof schema = schema) =>
    defineConfig({
      name: 'manage',
      schema: sch,
      firebase: { projectId: 'demo-manage', storageBucket: 'demo-manage.appspot.com' },
      rules: { firestore: 'firestore.rules', database: 'database.rules.json' },
      hosting: { public: 'public', spa: true },
      emulator: { port },
      environments: { local: { mode: 'emulator' } },
    });

  beforeAll(async () => {
    mkdirSync(web);
    writeFileSync(join(web, 'index.html'), '<title>from the config</title>');
    writeFileSync(join(root, 'firestore.rules'), OPEN);
    writeFileSync(join(root, 'database.rules.json'), JSON.stringify({ rules: { '.read': true, '.write': true } }));
    s = await serve({ config: make(), env: 'local', root, port: 0, host: '127.0.0.1', dataDir: join(root, 'data'), adminToken: 'manage-admin', log: () => {} });
    admin = initializeAdminApp(make(s.port), 'local', { name: 'manage-admin', emulator: { port: s.port, adminToken: 'manage-admin' } });
    client = initializeApp(make(s.port), 'local', { name: 'manage-client', firebase: { apiKey: 'demo', projectId: 'demo-manage' } });
  });
  afterAll(async () => {
    await deleteApp(client);
    await s.close();
  });

  it('the schema survives JSON (refs included)', () => {
    const back = schemaFromJson(JSON.parse(JSON.stringify(schemaToJson(schema))));
    expect(Object.keys(back.collections)).toEqual(['notes', 'links']);
    const to = (back.collections.links!.fields.to!.def as { to: { path: string } }).to;
    expect(to).toBe(back.collections.notes);
    expect(back.paths.chat!.path).toBe('chat/{id}');
  });

  it('Firestore: a named database is created, listed, kept apart from (default), and refuses an unknown id', async () => {
    const fsm = manageFirestore(admin);
    expect((await fsm.createDb()).id).toBe('(default)');
    const made = await fsm.createDb('archive');
    expect(made).toMatchObject({ id: 'archive', type: 'FIRESTORE_NATIVE' });
    await expect(fsm.createDb('archive')).rejects.toMatchObject({ code: 'already-exists' });
    await expect(fsm.createDb('X')).rejects.toMatchObject({ code: 'invalid-argument' });
    expect((await fsm.listDbs()).map((d) => d.id).sort()).toEqual(['(default)', 'archive']);

    const main = getFirestore(client);
    const archive = getFirestore(client, 'archive');
    await setDoc(doc(fsCollection(main, notes), 'n1'), { text: 'main', owner: 'a', tags: [] });
    await setDoc(doc(fsCollection(archive, notes), 'n1'), { text: 'archived', owner: 'a', tags: [] });
    expect((await getDoc(doc(fsCollection(main, notes), 'n1'))).data()?.text).toBe('main');
    expect((await getDoc(doc(fsCollection(archive, notes), 'n1'))).data()?.text).toBe('archived');
    await expect(getDoc(doc(fsCollection(getFirestore(client, 'nope'), notes), 'n1'))).rejects.toMatchObject({ code: 'not-found' });
  });

  it('Firestore: setRules releases a ruleset at once, per database; a syntax error is refused', async () => {
    const fsm = manageFirestore(admin);
    const main = getFirestore(client);
    await fsm.setRules(CLOSED);
    await expect(getDoc(doc(fsCollection(main, notes), 'n1'))).rejects.toMatchObject({ code: 'permission-denied' });
    // The archive database still runs the config's rules.
    expect((await getDoc(doc(fsCollection(getFirestore(client, 'archive'), notes), 'n1'))).exists()).toBe(true);
    await expect(fsm.setRules('service cloud.firestore {')).rejects.toBeTruthy();
    await fsm.setRules({ file: join(root, 'firestore.rules') });
    expect((await getDoc(doc(fsCollection(main, notes), 'n1'))).exists()).toBe(true);
  });

  it('Firestore: setSchema replaces the schema the server checks and plans with; setIndexes refuses undeclared indexes', async () => {
    const fsm = manageFirestore(admin);
    // A client built with the next schema declares an index on 'text'; the server's schema does not
    // yet, so the server refuses the query.
    const notes2 = collection('notes', { fields: { text: f.string(), owner: f.string(), tags: f.array(f.string()) }, indexes: [index('owner'), index('text')] });
    const schema2 = defineSchema({ notes: notes2, links }, { paths: { chat } });
    const next = initializeApp(make(s.port, schema2 as never), 'local', { name: 'manage-next', firebase: { apiKey: 'demo', projectId: 'demo-manage' } });
    const main = getFirestore(next);
    await expect(getDocs(query(fsCollection(main, notes2), where('text', '==', 'main')))).rejects.toMatchObject({ code: 'failed-precondition' });
    const sync = await fsm.setSchema(schema2);
    expect(sync.deleted).toEqual([]); // single-field indexes are automatic in Firestore: no composite changed
    expect(sync.unchanged).toBeGreaterThanOrEqual(0);
    expect((await getDocs(query(fsCollection(main, notes2), where('text', '==', 'main')))).size).toBe(1);
    await expect(fsm.setIndexes({ indexes: [{ collectionGroup: 'notes', queryScope: 'COLLECTION', fields: [{ fieldPath: 'owner', order: 'ASCENDING' }, { fieldPath: 'weight', order: 'DESCENDING' }] }], fieldOverrides: [] })).rejects.toMatchObject({ code: 'failed-precondition' });
    // The admin's own reads see the same data.
    expect((await getDoc(doc(fsCollection(getAdminFirestore(admin), notes), 'n1'))).exists()).toBe(true);
    await deleteApp(next);
  });

  it('Realtime Database: a named instance, and rules released at run time', async () => {
    const dbm = manageDatabase(admin);
    const inst = await dbm.createDb('manage-second');
    expect(inst).toMatchObject({ id: 'manage-second', type: 'USER_DATABASE' });
    expect((await dbm.listDbs()).map((d) => d.id)).toContain('demo-manage-default-rtdb');
    const main = getDatabase(client);
    const second = getDatabase(client, `${s.url}?ns=manage-second`);
    await dbSet(ref(main, chat, 'a'), { text: 'main' });
    await dbSet(ref(second, chat, 'a'), { text: 'second' });
    expect((await dbGet(ref(main, chat, 'a'))).val()).toEqual({ text: 'main' });
    expect((await dbGet(ref(second, chat, 'a'))).val()).toEqual({ text: 'second' });
    const out = await dbm.setRules({ rules: { '.read': false, '.write': false } });
    expect(out.rules['.read']).toBe(false);
    await expect(dbGet(ref(main, chat, 'a'))).rejects.toBeTruthy();
    // Only the default instance got the new rules.
    expect((await dbGet(ref(second, chat, 'a'))).val()).toEqual({ text: 'second' });
  });

  it('Storage: buckets are created and listed; rules are released per bucket', async () => {
    const sm = manageStorage(admin);
    expect((await sm.createBucket()).name).toBe('demo-manage.appspot.com');
    expect(await sm.createBucket('manage-uploads')).toEqual({ name: 'manage-uploads' });
    await expect(sm.createBucket('manage-uploads')).rejects.toMatchObject({ code: 'already-exists' });
    expect((await sm.listBuckets()).sort()).toEqual(['demo-manage.appspot.com', 'manage-uploads']);
    const r = await sm.setRules(`rules_version = '2';\nservice firebase.storage { match /b/{bucket}/o { match /{all=**} { allow read: if true; } } }`, { bucket: 'manage-uploads' });
    expect(r.release).toMatch(/firebase\.storage\/manage-uploads$/);
  });

  it('Auth: a sign-in method turned off is refused; turned on again, it works', async () => {
    const am = manageAuth(admin);
    const auth = getAuth(client);
    await createUserWithEmailAndPassword(auth, 'm@example.com', 'secret1');
    await am.setProviders({ password: false, anonymous: false });
    await expect(signInWithEmailAndPassword(auth, 'm@example.com', 'secret1')).rejects.toBeTruthy();
    await expect(signInAnonymously(auth)).rejects.toBeTruthy();
    expect(await am.getConfig()).toMatchObject({ emulator: true, signIn: { password: false, anonymous: false } });
    await am.setProviders({ password: true, anonymous: true });
    expect((await signInWithEmailAndPassword(auth, 'm@example.com', 'secret1')).user.email).toBe('m@example.com');
    await am.setAuthorizedDomains(['localhost', 'app.example.com']);
    expect(await am.getConfig()).toMatchObject({ authorizedDomains: ['localhost', 'app.example.com'] });
  });

  it('Hosting: a deploy replaces the config\'s public directory; a second site is served on its custom domain', async () => {
    const hm = manageHosting(admin);
    expect((await (await fetch(s.url)).text())).toContain('from the config');
    const v1 = join(root, 'v1');
    mkdirSync(join(v1, 'assets'), { recursive: true });
    writeFileSync(join(v1, 'index.html'), '<title>deployed v1</title>');
    writeFileSync(join(v1, 'assets', 'app.js'), 'console.log(1)');
    const d = await hm.deploy({ dir: v1, message: 'first' });
    expect(d).toMatchObject({ files: 2, uploaded: 2 });
    expect(await (await fetch(s.url)).text()).toContain('deployed v1');
    expect(await (await fetch(`${s.url}/some/route`)).text()).toContain('deployed v1'); // spa
    expect(await (await fetch(`${s.url}/assets/app.js`)).text()).toBe('console.log(1)');

    await hm.createSite('manage-docs');
    await expect(hm.createSite('manage-docs')).rejects.toMatchObject({ code: 'already-exists' });
    expect((await hm.listSites()).map((x) => x.name.split('/').pop()).sort()).toEqual(['demo-manage', 'manage-docs']);
    const dns = await hm.setDNS('docs.example.com', { site: 'manage-docs' });
    expect(dns.records[0]).toMatchObject({ domainName: 'docs.example.com', type: 'A', rdata: '127.0.0.1' });
    // Nothing released on that site yet.
    expect((await fetch(s.url, { headers: { 'x-forwarded-host': 'docs.example.com' } })).status).toBe(404);
    const docs = join(root, 'docs');
    mkdirSync(docs);
    writeFileSync(join(docs, 'index.html'), '<title>the docs</title>');
    await hm.deploy({ site: 'manage-docs', dir: docs });
    expect(await (await fetch(s.url, { headers: { 'x-forwarded-host': 'docs.example.com' } })).text()).toContain('the docs');
    // The default site is unchanged.
    expect(await (await fetch(s.url)).text()).toContain('deployed v1');
  });

  it('the management API is the admin\'s', async () => {
    const r = await fetch(`${s.url}/__/icebase/admin/manage/firestore/listDbs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(403);
  });
});
