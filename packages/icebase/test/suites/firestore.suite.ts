// The Firestore conformance suite: the same assertions against Firebase (official emulator,
// web SDK and firebase-admin) and the IceBase emulator (client and admin).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, type IceBaseApp } from '../../src/app.js';
import { listCollections, recursiveDelete } from '../../src/admin.js';
import { defineConfig, type Mode } from '../../src/config.js';
import { IceBaseError } from '../../src/errors.js';
import {
  addDoc,
  and,
  arrayRemove,
  arrayUnion,
  average,
  collection,
  collectionGroup,
  count,
  deleteDoc,
  deleteField,
  doc,
  documentId,
  endBefore,
  getAggregateFromServer,
  getCountFromServer,
  getDoc,
  getDocs,
  getSchemaDrift,
  increment,
  limit,
  limitToLast,
  onSnapshot,
  or,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  startAfter,
  startAt,
  sum,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
  type Firestore,
} from '../../src/firestore.js';
import { collection as coll, contains, defineSchema, f, index, type DocOf } from '../../src/schema.js';

const products = coll('products', {
  fields: {
    name: f.string(),
    priceCents: f.number({ int: true, min: 0 }),
    category: f.enum(['shoes', 'shirts', 'bags']),
    tags: f.array(f.string()),
    stock: f.number({ int: true }),
    active: f.boolean(),
    updatedAt: f.optional(f.timestamp()),
    note: f.optional(f.string()),
    dims: f.optional(f.map({ w: f.number(), h: f.number() })),
    // A key with a dot is one key (never a path).
    'rating.avg': f.optional(f.number()),
  },
  indexes: [
    index('category'),
    index('stock'),
    index('active'),
    index('tags'),
    index(['dims', 'w']),
    index('rating.avg'),
    index('category', 'priceCents'),
    index(contains('tags'), 'priceCents'),
  ],
});
const orders = coll('users/{uid}/orders', {
  fields: { product: f.ref(products), qty: f.number({ int: true, min: 1 }), status: f.enum(['pending', 'paid']) },
  indexes: [index('status')],
  group: true,
});
export { products, orders };
export const firestoreConfig = (mode: Mode, port?: number) =>
  defineConfig({
    name: 'fs-suite',
    schema: defineSchema({ products, orders }),
    firebase: { projectId: 'demo-icebase' },
    ...(port ? { emulator: { port } } : {}),
    environments: { test: { mode } },
  });

const run = Math.random().toString(36).slice(2, 8);
const cats = ['shoes', 'shirts', 'bags'] as const;

export interface SuiteSetup {
  app: IceBaseApp;
  db: Firestore;
  /** Write around IceBase (no schema check), to create legacy data. */
  rawSet(path: string, data: Record<string, unknown>): Promise<void>;
  close?(): Promise<void>;
}

export function firestoreSuite(name: string, kind: 'client' | 'admin', setup: (tag: string) => Promise<SuiteSetup>): void {
  describe(`firestore · ${name}`, () => {
    let s: SuiteSetup;
    let app: IceBaseApp;
    let db: Firestore;
    // Each driver writes under its own top-level prefix via a unique product name space.
    const tag = `${name.replace(/\W+/g, '-')}-${run}`;
    const P = () => collection(db, products);

    beforeAll(async () => {
      s = await setup(tag);
      app = s.app;
      db = s.db;
      const batch = writeBatch(db);
      for (let i = 0; i < 12; i++) {
        batch.set(doc(P(), `${tag}-${String(i).padStart(2, '0')}`), {
          name: `${tag} #${i}`,
          priceCents: 100 * (i + 1),
          category: cats[i % 3]!,
          tags: i % 2 ? [tag, 'odd'] : [tag],
          stock: i,
          active: i % 4 !== 0,
        });
      }
      await batch.commit();
    });
    afterAll(async () => {
      await deleteApp(app);
      await s.close?.();
    });

    const mine = where<DocOf<typeof products>, 'tags', 'array-contains'>('tags', 'array-contains', tag);

    it('reads a typed document', async () => {
      const s = await getDoc(doc(P(), `${tag}-03`));
      expect(s.exists()).toBe(true);
      expect(s.data()).toMatchObject({ name: `${tag} #3`, priceCents: 400, category: 'shoes', stock: 3, active: true });
      expect((await getDoc(doc(P(), 'missing'))).exists()).toBe(false);
    });

    it('queries with a declared composite (array-contains + orderBy)', async () => {
      const s = await getDocs(query(P(), mine, orderBy('priceCents', 'desc'), limit(3)));
      expect(s.docs.map((d) => d.data().stock)).toEqual([11, 10, 9]);
    });

    it('paginates with cursors (values and snapshots) and limitToLast', async () => {
      const first = await getDocs(query(P(), mine, orderBy('priceCents'), limit(4)));
      const next = await getDocs(query(P(), mine, orderBy('priceCents'), startAfter(first.docs[3]!), limit(4)));
      expect(next.docs.map((d) => d.data().stock)).toEqual([4, 5, 6, 7]);
      const byValue = await getDocs(query(P(), mine, orderBy('priceCents'), startAt(1100)));
      expect(byValue.docs.map((d) => d.data().stock)).toEqual([10, 11]);
      const last = await getDocs(query(P(), mine, orderBy('priceCents'), endBefore(400), limitToLast(2)));
      expect(last.docs.map((d) => d.data().stock)).toEqual([1, 2]);
    });

    it('supports or() and documentId()', async () => {
      const s = await getDocs(query(P(), and(mine, or(where('stock', '==', 1), where('stock', '==', 5)))));
      expect(s.docs.map((d) => d.data().stock).sort()).toEqual([1, 5]);
      const byId = await getDocs(query(P(), where(documentId(), 'in', [`${tag}-00`, `${tag}-02`])));
      expect(byId.size).toBe(2);
    });

    it('refuses an undeclared composite before the request leaves (IDX-2)', async () => {
      const q = query(P(), where('category', '==', 'shoes'), orderBy('stock')) as never;
      await expect(getDocs(q)).rejects.toMatchObject({ code: 'failed-precondition', details: { reason: 'missing-index', index: "index('category', 'stock')" } });
      await expect(getDocs(query(P(), where('priceCents', '==', 100)) as never)).rejects.toThrow("Add index('priceCents')");
    });

    it('validates writes against the schema (SCH-1)', async () => {
      await expect(setDoc(doc(P(), 'bad'), { name: 'x', priceCents: -1, category: 'socks' } as never)).rejects.toBeInstanceOf(IceBaseError);
      await expect(updateDoc(doc(P(), `${tag}-01`), { stock: 'many' } as never)).rejects.toThrow(/stock: expected integer/);
      expect((await getDoc(doc(P(), 'bad'))).exists()).toBe(false);
    });

    it('applies field values', async () => {
      const r = doc(P(), `${tag}-05`);
      await updateDoc(r, { stock: increment(10), tags: arrayUnion('sale'), updatedAt: serverTimestamp(), note: 'n' });
      let d = (await getDoc(r)).data()!;
      expect(d.stock).toBe(15);
      expect(d.tags).toContain('sale');
      expect(d.updatedAt).toBeInstanceOf(Timestamp);
      await updateDoc(r, { tags: arrayRemove('sale'), note: deleteField() });
      d = (await getDoc(r)).data()!;
      expect(d.tags).not.toContain('sale');
      expect('note' in d).toBe(false);
      await setDoc(r, { active: false }, { merge: true });
      expect((await getDoc(r)).data()).toMatchObject({ active: false, stock: 15 });
    });

    it('adds, references and collection-group queries', async () => {
      const uid = `${tag}-u1`;
      const ref = await addDoc(collection(db, orders, uid), { product: doc(P(), `${tag}-01`), qty: 2, status: 'paid' });
      expect(ref.id).toHaveLength(20);
      const o = (await getDoc(ref)).data()!;
      expect(o.product.path).toBe(`products/${tag}-01`);
      expect((await getDoc(o.product)).data()?.stock).toBe(1); // the stored reference is a typed reference
      const g = await getDocs(query(collectionGroup(db, orders), where('status', '==', 'paid')));
      expect(g.docs.some((d) => d.ref.path === ref.path)).toBe(true);
      await deleteDoc(ref);
      expect((await getDoc(ref)).exists()).toBe(false);
    });

    it('counts and aggregates', async () => {
      const q = query(P(), mine);
      expect((await getCountFromServer(q)).data().count).toBe(12);
      const a = (await getAggregateFromServer(query(P(), mine, where('active', '==', true)), { n: count(), total: sum('priceCents'), avg: average('stock') })).data();
      expect(a.n).toBe(8); // 9 active at seed, minus #5 set inactive above
      expect(typeof a.total).toBe('number');
    });

    it('runs transactions', async () => {
      const r = doc(P(), `${tag}-07`);
      const name = await runTransaction(db, async (tx) => {
        const s = await tx.get(r);
        tx.update(r, { stock: (s.data()?.stock ?? 0) + 1 });
        return s.data()?.name;
      });
      expect(name).toBe(`${tag} #7`);
      expect((await getDoc(r)).data()?.stock).toBe(8);
      await expect(runTransaction(db, async (tx) => void tx.set(r, { name: 'x' } as never))).rejects.toThrow(/does not match the schema/);
    });

    it('listens to a document and a query', async () => {
      const r = doc(P(), `${tag}-09`);
      const seen: number[] = [];
      await new Promise<void>((resolve, reject) => {
        const un = onSnapshot(r, (s) => {
          seen.push(s.data()!.stock);
          if (seen.length === 1) void updateDoc(r, { stock: 99 }).catch(reject);
          if (s.data()!.stock === 99) {
            un();
            resolve();
          }
        }, reject);
      });
      expect(seen[0]).toBe(9);
      const sizes: number[] = [];
      await new Promise<void>((resolve, reject) => {
        const un = onSnapshot(query(P(), mine, where('category', '==', 'bags')), (s) => {
          sizes.push(s.size);
          if (sizes.length === 1) {
            expect(s.docChanges().every((c) => c.type === 'added')).toBe(true);
            void deleteDoc(doc(P(), `${tag}-02`)).catch(reject);
          } else if (s.docChanges().some((c) => c.type === 'removed')) {
            un();
            resolve();
          }
        }, reject);
      });
      expect(sizes[0]! - sizes[sizes.length - 1]!).toBe(1);
    });

    it('refuses listeners on undeclared composites synchronously', () => {
      expect(() => onSnapshot(query(P(), where('active', '==', true), orderBy('stock')) as never, () => {})).toThrow(/needs an index/);
    });

    it('returns legacy documents as is and counts the drift (SCH-2)', async () => {
      await s.rawSet(`products/${tag}-legacy`, { name: 'old', priceCents: 'free', category: 'shoes', tags: [], stock: 1, active: true });
      const legacy = await getDoc(doc(P(), `${tag}-legacy`));
      expect(legacy.data()?.priceCents).toBe('free');
      expect(getSchemaDrift().products?.count).toBeGreaterThan(0);
    });

    it('key-array paths into maps, and a dotted key is one key', async () => {
      const r = doc(P(), `${tag}-dims`);
      await setDoc(r, { name: 'Box', priceCents: 1, category: 'bags', tags: [tag, 'dims'], stock: 1, active: true, dims: { w: 3, h: 4 }, 'rating.avg': 4.5 });
      await updateDoc(r, ['dims', 'w'], 7, 'rating.avg', 4.8);
      const d = (await getDoc(r)).data()!;
      expect(d.dims).toEqual({ w: 7, h: 4 });
      expect(d['rating.avg']).toBe(4.8);
      expect('rating' in d).toBe(false);
      expect((await getDocs(query(P(), where(['dims', 'w'], '==', 7)))).docs.map((x) => x.id)).toEqual([`${tag}-dims`]);
      expect((await getDocs(query(P(), where('rating.avg', '>', 4.6)))).docs.map((x) => x.id)).toContain(`${tag}-dims`);
      await updateDoc(r, { dims: { w: 1, h: 1 } });
      expect((await getDoc(r)).data()!.dims).toEqual({ w: 1, h: 1 });
      await expect(updateDoc(r, ['dims', 'nope'] as never, 1)).rejects.toThrow(/a field in the schema/);
    });

    if (kind === 'admin') {
      it('admin extras: listCollections, recursiveDelete', async () => {
        const uid = `${tag}-u2`;
        await addDoc(collection(db, orders, uid), { product: doc(P(), `${tag}-01`), qty: 1, status: 'pending' });
        expect(await listCollections(db, { path: `users/${uid}` })).toEqual(['orders']);
        await recursiveDelete(db, { path: `users/${uid}/orders` });
        expect(await listCollections(db, { path: `users/${uid}` })).toEqual([]);
      });
    }
  });
}
