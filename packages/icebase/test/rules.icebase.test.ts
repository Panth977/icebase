// firestore.rules enforced by the IceBase emulator for signed-in clients (RUL-2), with the
// PRD's example rules; the admin (owner) bypasses them.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAdminAuth, getAdminFirestore, initializeAdminApp } from '../src/admin.js';
import { deleteApp, initializeApp } from '../src/app.js';
import { createUserWithEmailAndPassword, getAuth, signInWithEmailAndPassword, signOut } from '../src/auth.js';
import { defineConfig } from '../src/config.js';
import { startEmulator, type RunningEmulator } from '../src/emulator/server.js';
import { addDoc, collection, collectionGroup, doc, getDoc, getDocs, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where, getFirestore } from '../src/firestore.js';
import { collection as coll, defineSchema, f, index } from '../src/schema.js';

const RULES = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    function isAdmin() { return signedIn() && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin'; }
    match /users/{uid} {
      allow read: if signedIn() && (request.auth.uid == uid || isAdmin());
      allow create: if request.auth.uid == uid && request.resource.data.role == 'member';
      allow update: if request.auth.uid == uid && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['role']);
      match /orders/{orderId} {
        allow read: if request.auth.uid == uid || isAdmin();
        allow create: if request.auth.uid == uid && request.resource.data.status == 'pending';
        allow update, delete: if isAdmin();
      }
    }
    match /products/{id} {
      allow read: if true;
      allow write: if isAdmin();
    }
  }
}`;

const users = coll('users', { fields: { email: f.string(), role: f.enum(['admin', 'member']), createdAt: f.timestamp(), name: f.optional(f.string()) }, indexes: [] });
const products = coll('products', { fields: { name: f.string(), stock: f.number({ int: true }) }, indexes: [] });
const orders = coll('users/{uid}/orders', { fields: { status: f.enum(['pending', 'paid']), total: f.number() }, indexes: [index('status')], group: true });

describe('rules · emulator mode', () => {
  let emu: RunningEmulator;
  let cfg: ReturnType<typeof make>;
  const dir = mkdtempSync(join(tmpdir(), 'icebase-rules-'));
  writeFileSync(join(dir, 'firestore.rules'), RULES);
  const make = (port = 0) =>
    defineConfig({ name: 'rules-test', schema: defineSchema({ users, products, orders }), rules: { firestore: 'firestore.rules' }, auth: { providers: ['password'] }, firebase: { projectId: 'demo-icebase' }, emulator: { port }, environments: { local: { mode: 'emulator' } } });

  beforeAll(async () => {
    emu = await startEmulator({ config: make(), root: dir, port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
    cfg = make(emu.port);
  });
  afterAll(() => emu.close());

  it('applies the rules to clients, not to the admin', async () => {
    const app = initializeApp(cfg, 'local', { name: 'rules-client', firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
    const admin = initializeAdminApp(cfg, 'local', { name: 'rules-admin' });
    const auth = getAuth(app);
    const db = getFirestore(app);
    const adb = getAdminFirestore(admin);

    // Anonymous callers: products are public, users are not.
    await setDoc(doc(collection(adb, products), 'p1'), { name: 'Boot', stock: 3 });
    expect((await getDoc(doc(collection(db, products), 'p1'))).data()?.name).toBe('Boot');
    await expect(getDoc(doc(collection(db, users), 'nobody'))).rejects.toMatchObject({ code: 'permission-denied' });

    // A member creates their own profile as 'member' only.
    const alice = (await createUserWithEmailAndPassword(auth, 'alice@example.com', 'secret12')).user.uid;
    await expect(setDoc(doc(collection(db, users), alice), { email: 'alice@example.com', role: 'admin', createdAt: serverTimestamp() })).rejects.toMatchObject({ code: 'permission-denied' });
    await setDoc(doc(collection(db, users), alice), { email: 'alice@example.com', role: 'member', createdAt: serverTimestamp() });
    expect((await getDoc(doc(collection(db, users), alice))).data()?.role).toBe('member');
    // …can update their name but not their role.
    await updateDoc(doc(collection(db, users), alice), { name: 'Alice' });
    await expect(updateDoc(doc(collection(db, users), alice), { role: 'admin' })).rejects.toMatchObject({ code: 'permission-denied' });
    // …places pending orders only, and cannot write products.
    await addDoc(collection(db, orders, alice), { status: 'pending', total: 10 });
    await expect(addDoc(collection(db, orders, alice), { status: 'paid', total: 10 })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(setDoc(doc(collection(db, products), 'p2'), { name: 'x', stock: 1 })).rejects.toMatchObject({ code: 'permission-denied' });
    // Listeners are checked too.
    await expect(
      new Promise((resolve, reject) => {
        onSnapshot(doc(collection(db, users), 'someone-else'), resolve, reject);
      }),
    ).rejects.toMatchObject({ code: 'permission-denied' });

    // "Rules are not filters": a collection-group read of everyone's orders is refused for a member…
    await expect(getDocs(query(collectionGroup(db, orders), where('status', '==', 'pending')))).rejects.toMatchObject({ code: 'permission-denied' });

    // …and allowed for an admin, whose role lives in Firestore (get() in rules).
    await signOut(auth);
    const bob = (await createUserWithEmailAndPassword(auth, 'bob@example.com', 'secret12')).user.uid;
    await setDoc(doc(collection(adb, users), bob), { email: 'bob@example.com', role: 'admin', createdAt: serverTimestamp() });
    expect((await getDocs(query(collectionGroup(db, orders), where('status', '==', 'pending')))).size).toBe(1);
    expect((await getDoc(doc(collection(db, users), alice))).data()?.name).toBe('Alice');
    await setDoc(doc(collection(db, products), 'p2'), { name: 'Shoe', stock: 1 });

    // The admin SDK sees everything regardless.
    await signInWithEmailAndPassword(auth, 'alice@example.com', 'secret12');
    expect((await getDocs(collection(adb, users))).size).toBe(2);
    expect((await getAdminAuth(admin).getUser(alice)).email).toBe('alice@example.com');
    await deleteApp(app);
    await deleteApp(admin);
  });
});
