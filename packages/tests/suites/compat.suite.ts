// firebase-admin-compatible Firestore (icebase-server/compat): the same assertions against
// Firebase (official emulator) and the IceBase emulator.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, type IceBaseApp } from '@panth977/icebase/app';
import { defineConfig, type Mode } from '@panth977/icebase/config';
import { collection, defineSchema, desc, f, index } from '@panth977/icebase/schema';
import { fromZod } from '@panth977/icebase/zod';
import { FieldPath, FieldValue, getFirestore, Timestamp, type Firestore } from '@panth977/icebase-server/compat';
import { z } from 'zod';

const BoardZ = z.object({
  name: z.string().min(1),
  key: z.string(),
  counts: z.object({ open: z.number().int(), done: z.number().int() }),
  members: z.record(z.enum(['admin', 'viewer'])),
  archivedAt: z.number().nullable(),
  meta: z.unknown().optional(),
  tags: z.array(z.string()).default([]),
  kind: z.union([z.literal('kanban'), z.literal('list')]),
});

const boards = collection('boards', {
  fields: fromZod(BoardZ),
  indexes: [index('key'), index(['counts', 'open']), index('archivedAt'), index('kind', desc(['counts', 'open'])), index('tags'), index(['members', '*'])],
});
const data = collection('boards/{b}/data/{path=**}', { fields: {}, rest: f.any(), indexes: [], autoIndex: true });
const tickets = collection('boards/{b}/tickets', {
  fields: { title: f.string(), at: f.timestamp(), board: f.optional(f.ref(boards)), 'a.b': f.optional(f.number()) },
  indexes: [index('at')],
  group: true,
});

export const compatConfig = (mode: Mode, port?: number) =>
  defineConfig({
    name: 'compat-test',
    schema: defineSchema({ boards, tickets, data }),
    firebase: { projectId: 'demo-icebase' },
    ...(port ? { emulator: { port } } : {}),
    environments: { test: { mode } },
  });

const board = (n: number, extra: Record<string, unknown> = {}) => ({ name: `B${n}`, key: `K${n}`, counts: { open: n, done: 0 }, members: { u1: 'admin' }, archivedAt: null, tags: n % 2 ? ['odd'] : [], kind: n % 2 ? 'kanban' : 'list', ...extra });

export function compatSuite(name: string, make: (tag: string) => Promise<IceBaseApp>): void {
  describe(`compat · ${name}`, () => {
    let app: IceBaseApp;
    let db: Firestore;
    const ns = `t${Date.now().toString(36)}`;
    beforeAll(async () => {
      app = await make(`compat-${ns}`);
      db = getFirestore(app);
      const b = db.batch();
      for (let i = 1; i <= 6; i++) b.set(db.collection('boards').doc(`${ns}-${i}`), board(i));
      await b.commit();
    });
    afterAll(() => deleteApp(app));

    it('chained reads and dotted where/orderBy', async () => {
      const s = await db.collection('boards').doc(`${ns}-3`).get();
      expect(s.exists).toBe(true);
      expect(s.get('counts.open')).toBe(3);
      const q = await db.collection('boards').where('counts.open', '>=', 4).orderBy('counts.open', 'desc').limit(2).get();
      expect(q.docs.map((d) => d.data().name).filter((n) => n.startsWith('B'))).toEqual(['B6', 'B5']);
      const k = await db.collection('boards').where('kind', '==', 'kanban').orderBy('counts.open', 'desc').get();
      expect(k.docs.map((d) => d.id).filter((id) => id.startsWith(ns))).toEqual([`${ns}-5`, `${ns}-3`, `${ns}-1`]);
      expect((await db.collection('boards').where('tags', 'array-contains', 'odd').count().get()).data().count).toBeGreaterThanOrEqual(3);
    });

    it('refuses an undeclared index and a bad write', async () => {
      await expect(db.collection('boards').where('name', '==', 'B1').get()).rejects.toMatchObject({ code: 9 });
      await expect(db.collection('boards').doc('x').set({ ...board(1), name: 5 })).rejects.toMatchObject({ code: 3 });
      await expect(db.collection('nope').doc('x').set({})).rejects.toMatchObject({ code: 3 });
      await expect(db.collection('boards').doc(`${ns}-1`).update({ 'counts.open': 'x' })).rejects.toMatchObject({ code: 3 });
    });

    it('update with dotted paths, FieldValue, FieldPath; set merge and mergeFields', async () => {
      const r = db.collection('boards').doc(`${ns}-2`);
      await r.update({ 'counts.open': FieldValue.increment(5), 'members.u2': 'viewer', meta: { any: ['thing'] } });
      await r.update(new FieldPath('counts', 'done'), 7);
      let d = (await r.get()).data()!;
      expect(d.counts).toEqual({ open: 7, done: 7 });
      expect(d.members).toEqual({ u1: 'admin', u2: 'viewer' });
      await r.set({ name: 'Renamed', key: 'ignored' }, { mergeFields: ['name'] });
      await r.set({ archivedAt: 123 }, { merge: true });
      await r.update({ 'members.u2': FieldValue.delete(), tags: FieldValue.arrayUnion('x') });
      d = (await r.get()).data()!;
      expect([d.name, d.key, d.archivedAt, d.members, d.tags]).toEqual(['Renamed', 'K2', 123, { u1: 'admin' }, ['x']]);
    });

    it('create, preconditions, transactions, getAll', async () => {
      const r = db.collection('boards').doc(`${ns}-new`);
      await r.create(board(9));
      await expect(r.create(board(9))).rejects.toMatchObject({ code: 6 });
      await expect(db.collection('boards').doc(`${ns}-missing`).update({ name: 'x' })).rejects.toMatchObject({ code: 5 });
      await expect(db.collection('boards').doc(`${ns}-missing`).delete({ exists: true })).rejects.toMatchObject({ code: 5 });
      const n = await db.runTransaction(async (tx) => {
        const s = await tx.get(r);
        tx.update(r, { 'counts.open': s.get('counts.open') + 1 });
        tx.create(db.collection('boards').doc(`${ns}-tx`), board(1));
        return s.get('counts.open') + 1;
      });
      expect(n).toBe(10);
      const [a, b, c] = await db.getAll(r, db.doc(`boards/${ns}-tx`), db.doc(`boards/${ns}-zz`));
      expect([a!.get('counts.open'), b!.exists, c!.exists]).toEqual([10, true, false]);
    });

    it('subcollections, refs, timestamps, collection groups, cursors, select, recursiveDelete', async () => {
      const t = db.collection(`boards/${ns}-1/tickets`);
      const at = Timestamp.fromMillis(1_700_000_000_000);
      for (let i = 0; i < 4; i++) await t.doc(`k${i}`).set({ title: `T${i}`, at: Timestamp.fromMillis(at.toMillis() + i), board: db.doc(`boards/${ns}-1`), 'a.b': i });
      const one = (await t.doc('k1').get()).data()!;
      expect(one.at).toBeInstanceOf(Timestamp);
      expect(one.board.path).toBe(`boards/${ns}-1`);
      expect((await t.doc('k2').get()).get(new FieldPath('a.b'))).toBe(2);
      const ordered = await t.orderBy('at').get();
      const after = await t.orderBy('at').startAfter(ordered.docs[1]!).get();
      expect(after.docs.map((d) => d.id)).toEqual(['k2', 'k3']);
      const page = await t.orderBy('at').startAt(Timestamp.fromMillis(at.toMillis() + 3)).get();
      expect(page.docs.map((d) => d.id)).toEqual(['k3']);
      const group = await db.collectionGroup('tickets').where('at', '>=', Timestamp.fromMillis(at.toMillis() + 2)).get();
      expect(group.docs.map((d) => d.id).sort()).toEqual(['k2', 'k3']);
      const sel = await t.orderBy('at').select('title').limit(1).get();
      expect(sel.docs[0]!.data()).toEqual({ title: 'T0' });
      await db.recursiveDelete(db.doc(`boards/${ns}-1`));
      expect((await t.get()).size).toBe(0);
      expect((await db.doc(`boards/${ns}-1`).get()).exists).toBe(false);
    });

    it('glob collections with automatic single-field indexes, record wildcard indexes, own errors', async () => {
      const notes = db.collection(`boards/${ns}-5/data/app/notes`);
      await notes.doc('n1').set({ anything: { goes: [1, 2] }, n: 1 });
      await notes.doc('n2').set({ n: 2 });
      expect((await notes.where('n', '>', 1).get()).docs.map((d) => d.id)).toEqual(['n2']);
      await expect(notes.where('n', '>', 0).orderBy('anything').get()).rejects.toMatchObject({ code: 9 });
      expect((await db.collection('boards').where('members.u1', '==', 'admin').count().get()).data().count).toBeGreaterThan(0);
      class Mine extends Error {
        code = 'forbidden';
      }
      await expect(db.runTransaction(async () => { throw new Mine('no'); })).rejects.toBeInstanceOf(Mine);
    });

    it('withConverter, bulkWriter, listDocuments', async () => {
      const conv = { toFirestore: (b: { title: string }) => ({ ...b, at: Timestamp.now() }), fromFirestore: (s: { data(): Record<string, any> }) => ({ title: s.data().title as string }) };
      const t = db.collection(`boards/${ns}-4/tickets`).withConverter(conv);
      await t.doc('c1').set({ title: 'conv' });
      expect((await t.doc('c1').get()).data()).toEqual({ title: 'conv' });
      const bw = db.bulkWriter();
      for (let i = 0; i < 5; i++) void bw.set(db.collection(`boards/${ns}-4/tickets`).doc(`w${i}`), { title: `w${i}`, at: Timestamp.now() });
      await bw.close();
      expect((await db.collection(`boards/${ns}-4/tickets`).listDocuments()).length).toBe(6);
    });
  });
}
