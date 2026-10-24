// firebase mode, client side: icebase/firestore on top of the Firebase JS SDK (firebase/firestore).

import * as fs from 'firebase/firestore';
import { IceBaseError } from '../errors.ts';
import type { Aggregate, BatchDriver, FirestoreDriver, RawDoc, RawQueryResult, TxDriver } from '../internal/firestore-driver.ts';
import { nativeWebApp } from '../internal/firebase-web-app.ts';
import { isName, type FilterNode, type QuerySpec } from '../internal/plan.ts';
import { FieldValue, GeoPoint, Timestamp, isPlainObject } from '../values.ts';
import type { DriverHelpers, Firestore } from '../firestore.ts';

/** Map the SDK's errors onto IceBaseError with the same code. */
export function wrapError(e: unknown): Error {
  if (e instanceof IceBaseError) return e;
  const err = e as { code?: string; message?: string; name?: string };
  if (err && typeof err.code === 'string' && (err.name === 'FirebaseError' || err.code.length < 40)) {
    const code = err.code.replace(/^firestore\//, '') as IceBaseError['code'];
    const out = new IceBaseError(code, err.message ?? String(e), { cause: e });
    return out;
  }
  return e instanceof Error ? e : new Error(String(e));
}

export function createWebDriver(db: Firestore, h: DriverHelpers): FirestoreDriver {
  const nativeApp = nativeWebApp(db.app);
  const settings = db._settings;
  const ndb: fs.Firestore =
    Object.keys(settings).length > 0
      ? fs.initializeFirestore(nativeApp, settings as fs.FirestoreSettings, db.databaseId)
      : db.databaseId === '(default)'
        ? fs.getFirestore(nativeApp)
        : fs.getFirestore(nativeApp, db.databaseId);

  const toNative = (v: unknown): unknown => {
    if (v === null || v === undefined || typeof v !== 'object') return v;
    if (v instanceof Timestamp) return new fs.Timestamp(v.seconds, v.nanoseconds);
    if (v instanceof GeoPoint) return new fs.GeoPoint(v.latitude, v.longitude);
    if (v instanceof FieldValue) {
      switch (v.op) {
        case 'serverTimestamp':
          return fs.serverTimestamp();
        case 'increment':
          return fs.increment(v.operand as number);
        case 'arrayUnion':
          return fs.arrayUnion(...(v.operand as unknown[]).map(toNative));
        case 'arrayRemove':
          return fs.arrayRemove(...(v.operand as unknown[]).map(toNative));
        case 'delete':
          return fs.deleteField();
        default:
          throw new IceBaseError('invalid-argument', `${v.op}() is a Realtime Database value; use serverTimestamp() from icebase/firestore`);
      }
    }
    if (v instanceof Uint8Array) return fs.Bytes.fromUint8Array(v);
    if ((v as { type?: unknown }).type === 'document' && typeof (v as { path?: unknown }).path === 'string') return fs.doc(ndb, (v as { path: string }).path);
    if (Array.isArray(v)) return v.map(toNative);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toNative(x)]));
    return v;
  };

  const fromNative = (v: unknown): unknown => {
    if (v === null || v === undefined || typeof v !== 'object') return v;
    if (v instanceof fs.Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
    if (v instanceof fs.GeoPoint) return new GeoPoint(v.latitude, v.longitude);
    if (v instanceof fs.DocumentReference) return h.toRef(v.path);
    if (v instanceof fs.Bytes) return v.toUint8Array();
    if (Array.isArray(v)) return v.map(fromNative);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromNative(x)]));
    return v;
  };

  const raw = (s: fs.DocumentSnapshot): RawDoc => ({
    id: s.id,
    path: s.ref.path,
    data: s.exists() ? (fromNative(s.data({ serverTimestamps: 'estimate' })) as Record<string, unknown>) : null,
    fromCache: s.metadata.fromCache,
    hasPendingWrites: s.metadata.hasPendingWrites,
    native: s,
  });

  const fieldPath = (p: string[]) => (isName(p) ? fs.documentId() : new fs.FieldPath(...p));
  const filter = (n: FilterNode): fs.QueryFilterConstraint => {
    if (n.kind === 'field') return fs.where(fieldPath(n.field), n.op, toNative(n.value));
    const parts = n.filters.map(filter);
    return n.kind === 'and' ? fs.and(...(parts as fs.QueryFilterConstraint[])) : fs.or(...(parts as fs.QueryFilterConstraint[]));
  };

  const build = (spec: QuerySpec): fs.Query => {
    const base: fs.Query = spec.path !== null ? fs.collection(ndb, spec.path) : fs.collectionGroup(ndb, spec.collectionId);
    const cs: fs.QueryConstraint[] = [];
    const filters = spec.filters.map(filter);
    const top: (fs.QueryFilterConstraint | fs.QueryCompositeFilterConstraint)[] = filters.length > 1 ? [fs.and(...filters)] : filters;
    for (const o of spec.orders) cs.push(fs.orderBy(fieldPath(o.field), o.dir));
    if (spec.start) cs.push(spec.start.snapshot ? (spec.start.inclusive ? fs.startAt : fs.startAfter)(spec.start.snapshot as fs.DocumentSnapshot) : (spec.start.inclusive ? fs.startAt : fs.startAfter)(...spec.start.values.map(toNative)));
    if (spec.end) cs.push(spec.end.snapshot ? (spec.end.inclusive ? fs.endAt : fs.endBefore)(spec.end.snapshot as fs.DocumentSnapshot) : (spec.end.inclusive ? fs.endAt : fs.endBefore)(...spec.end.values.map(toNative)));
    if (spec.limit) cs.push(spec.limit.last ? fs.limitToLast(spec.limit.n) : fs.limit(spec.limit.n));
    if (top.length === 1) return fs.query(base, top[0] as fs.QueryCompositeFilterConstraint, ...(cs as fs.QueryNonFilterConstraint[]));
    return fs.query(base, ...cs);
  };

  const result = (s: fs.QuerySnapshot, withChanges: boolean): RawQueryResult => ({
    docs: s.docs.map(raw),
    ...(withChanges ? { changes: s.docChanges().map((c) => ({ type: c.type, doc: raw(c.doc), oldIndex: c.oldIndex, newIndex: c.newIndex })) } : {}),
    fromCache: s.metadata.fromCache,
    hasPendingWrites: s.metadata.hasPendingWrites,
  });

  const guard = async <R>(p: Promise<R>): Promise<R> => {
    try {
      return await p;
    } catch (e) {
      throw wrapError(e);
    }
  };
  const ref = (path: string) => fs.doc(ndb, path);
  const data = (d: Record<string, unknown>) => toNative(d) as fs.DocumentData;
  // Firebase's updateDoc(ref, field, value, …more): FieldPaths, so a key with a dot stays one key.
  const pairs = (fields: [string[], unknown][]) => fields.flatMap(([p, v]) => [new fs.FieldPath(...p), toNative(v)]) as [fs.FieldPath, unknown, ...unknown[]];

  return {
    kind: 'web',
    connectEmulator(host: string, port: number) {
      fs.connectFirestoreEmulator(ndb, host, port);
    },
    get: (path) => guard(fs.getDoc(ref(path)).then(raw)),
    query: (spec) => guard(fs.getDocs(build(spec)).then((s) => result(s, false))),
    aggregate: (spec, aggs) =>
      guard(
        fs
          .getAggregateFromServer(
            build(spec),
            Object.fromEntries(Object.entries(aggs).map(([k, a]: [string, Aggregate]) => [k, a.op === 'count' ? fs.count() : a.op === 'sum' ? fs.sum(a.field) : fs.average(a.field)])),
          )
          .then((s) => s.data() as Record<string, number | null>),
      ),
    set: (path, d, merge) => guard(merge ? fs.setDoc(ref(path), data(d), { merge: true }) : fs.setDoc(ref(path), data(d))),
    create: (path, d) =>
      guard(
        fs.runTransaction(ndb, async (tx) => {
          if ((await tx.get(ref(path))).exists()) throw new IceBaseError('already-exists', `Document already exists: ${path}`);
          tx.set(ref(path), data(d));
        }),
      ),
    update: (path, f) => guard(fs.updateDoc(ref(path), ...pairs(f))),
    delete: (path) => guard(fs.deleteDoc(ref(path))),
    listenDoc: (path, next, error) => fs.onSnapshot(ref(path), (s) => next(raw(s)), (e) => error(wrapError(e))),
    listenQuery: (spec, next, error) => fs.onSnapshot(build(spec), (s) => next(result(s, true)), (e) => error(wrapError(e))),
    transaction: (fn, opts) =>
      guard(
        fs.runTransaction(
          ndb,
          (t) => {
            const tx: TxDriver = {
              get: async (path) => raw(await t.get(ref(path))),
              set: (path, d, merge) => void (merge ? t.set(ref(path), data(d), { merge: true }) : t.set(ref(path), data(d))),
              update: (path, f) => void t.update(ref(path), ...pairs(f)),
              delete: (path) => void t.delete(ref(path)),
            };
            return fn(tx);
          },
          opts?.maxAttempts ? { maxAttempts: opts.maxAttempts } : undefined,
        ),
      ),
    batch: (): BatchDriver => {
      const b = fs.writeBatch(ndb);
      return {
        set: (path, d, merge) => void (merge ? b.set(ref(path), data(d), { merge: true }) : b.set(ref(path), data(d))),
        update: (path, f) => void b.update(ref(path), ...pairs(f)),
        delete: (path) => void b.delete(ref(path)),
        commit: () => guard(b.commit()),
      };
    },
    terminate: () => fs.terminate(ndb),
  } as FirestoreDriver;
}
