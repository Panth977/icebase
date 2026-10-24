// firebase mode, server side: icebase/firestore on top of firebase-admin (bypasses rules).

import * as admin from 'firebase-admin/firestore';
import { IceBaseError } from '@panth977/icebase/errors';
import type { Aggregate, BatchDriver, FirestoreDriver, RawDoc, RawQueryResult, TxDriver } from '@panth977/icebase/internal';
import { nativeAdminApp } from '../internal/firebase-admin-app.ts';
import { isName, type FilterNode, type QuerySpec } from '@panth977/icebase/internal';
import { FieldValue, GeoPoint, Timestamp, isPlainObject } from '@panth977/icebase/internal';
import type { DriverHelpers, Firestore } from '@panth977/icebase/firestore';
import { Buffer } from 'node:buffer';

const GRPC: Record<number, IceBaseError['code']> = {
  1: 'cancelled', 2: 'unknown', 3: 'invalid-argument', 4: 'deadline-exceeded', 5: 'not-found', 6: 'already-exists', 7: 'permission-denied',
  8: 'resource-exhausted', 9: 'failed-precondition', 10: 'aborted', 11: 'out-of-range', 12: 'unimplemented', 13: 'internal', 14: 'unavailable', 15: 'data-loss', 16: 'unauthenticated',
};

export function wrapAdminError(e: unknown): Error {
  if (e instanceof IceBaseError) return e;
  const err = e as { code?: unknown; message?: string; details?: string };
  if (err && typeof err.code === 'number' && GRPC[err.code]) return new IceBaseError(GRPC[err.code]!, err.details || err.message || String(e), { cause: e });
  // Firebase's own string codes only: any other error (thrown by a transaction's function, say) is the caller's.
  if (err && typeof err.code === 'string' && /^(firestore|app)\//.test(err.code)) return new IceBaseError(err.code.replace(/^(firestore|app)\//, '') as IceBaseError['code'], err.message ?? String(e), { cause: e });
  return e instanceof Error ? e : new Error(String(e));
}

export function createAdminDriver(db: Firestore, h: DriverHelpers): FirestoreDriver {
  const nativeApp = nativeAdminApp(db.app);
  const ndb = db.databaseId === '(default)' ? admin.getFirestore(nativeApp) : admin.getFirestore(nativeApp, db.databaseId);
  if (db._settings.ignoreUndefinedProperties) ndb.settings({ ignoreUndefinedProperties: true });

  const toNative = (v: unknown): unknown => {
    if (v === null || v === undefined || typeof v !== 'object') return v;
    if (v instanceof Timestamp) return new admin.Timestamp(v.seconds, v.nanoseconds);
    if (v instanceof GeoPoint) return new admin.GeoPoint(v.latitude, v.longitude);
    if (v instanceof FieldValue) {
      switch (v.op) {
        case 'serverTimestamp':
          return admin.FieldValue.serverTimestamp();
        case 'increment':
          return admin.FieldValue.increment(v.operand as number);
        case 'arrayUnion':
          return admin.FieldValue.arrayUnion(...(v.operand as unknown[]).map(toNative));
        case 'arrayRemove':
          return admin.FieldValue.arrayRemove(...(v.operand as unknown[]).map(toNative));
        case 'delete':
          return admin.FieldValue.delete();
        default:
          throw new IceBaseError('invalid-argument', `${v.op}() is a Realtime Database value; use serverTimestamp() from icebase/firestore`);
      }
    }
    if (v instanceof Uint8Array) return Buffer.from(v);
    if ((v as { type?: unknown }).type === 'document' && typeof (v as { path?: unknown }).path === 'string') return ndb.doc((v as { path: string }).path);
    if (Array.isArray(v)) return v.map(toNative);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, toNative(x)]));
    return v;
  };

  const fromNative = (v: unknown): unknown => {
    if (v === null || v === undefined || typeof v !== 'object') return v;
    if (v instanceof admin.Timestamp) return new Timestamp(v.seconds, v.nanoseconds);
    if (v instanceof admin.GeoPoint) return new GeoPoint(v.latitude, v.longitude);
    if (v instanceof admin.DocumentReference) return h.toRef(v.path);
    if (Buffer.isBuffer(v)) return new Uint8Array(v);
    if (Array.isArray(v)) return v.map(fromNative);
    if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromNative(x)]));
    return v;
  };

  const ts = (t: admin.Timestamp | undefined) => (t ? { seconds: t.seconds, nanoseconds: t.nanoseconds } : undefined);
  const raw = (s: admin.DocumentSnapshot): RawDoc => {
    const out: RawDoc = { id: s.id, path: s.ref.path, data: s.exists ? (fromNative(s.data()) as Record<string, unknown>) : null, native: s };
    const c = ts(s.createTime);
    const u = ts(s.updateTime);
    if (c) out.createTime = c;
    if (u) out.updateTime = u;
    return out;
  };

  const fieldPath = (p: string[]) => (isName(p) ? admin.FieldPath.documentId() : new admin.FieldPath(...p));
  const filter = (n: FilterNode): admin.Filter => {
    if (n.kind === 'field') return admin.Filter.where(fieldPath(n.field), n.op, toNative(n.value));
    const parts = n.filters.map(filter);
    return n.kind === 'and' ? admin.Filter.and(...parts) : admin.Filter.or(...parts);
  };

  const build = (spec: QuerySpec): admin.Query => {
    let q: admin.Query = spec.path !== null ? ndb.collection(spec.path) : ndb.collectionGroup(spec.collectionId);
    if (spec.filters.length === 1) q = q.where(filter(spec.filters[0]!));
    else if (spec.filters.length > 1) q = q.where(admin.Filter.and(...spec.filters.map(filter)));
    for (const o of spec.orders) q = q.orderBy(fieldPath(o.field), o.dir);
    const pos = (p: NonNullable<QuerySpec['start']>) => (p.snapshot ? [p.snapshot as admin.DocumentSnapshot] : p.values.map(toNative));
    if (spec.start) q = spec.start.inclusive ? q.startAt(...pos(spec.start)) : q.startAfter(...pos(spec.start));
    if (spec.end) q = spec.end.inclusive ? q.endAt(...pos(spec.end)) : q.endBefore(...pos(spec.end));
    if (spec.limit) q = spec.limit.last ? q.limitToLast(spec.limit.n) : q.limit(spec.limit.n);
    return q;
  };

  const result = (s: admin.QuerySnapshot, withChanges: boolean): RawQueryResult => ({
    docs: s.docs.map(raw),
    ...(withChanges ? { changes: s.docChanges().map((c) => ({ type: c.type, doc: raw(c.doc), oldIndex: c.oldIndex, newIndex: c.newIndex })) } : {}),
  });

  const guard = async <R>(p: Promise<R>): Promise<R> => {
    try {
      return await p;
    } catch (e) {
      throw wrapAdminError(e);
    }
  };
  const data = (d: Record<string, unknown>) => toNative(d) as admin.DocumentData;
  // update(field, value, …more) with FieldPaths, so a key with a dot stays one key.
  const pairs = (fields: [string[], unknown][]) => fields.flatMap(([p, v]) => [new admin.FieldPath(...p), toNative(v)]) as [admin.FieldPath, unknown, ...unknown[]];

  return {
    kind: 'admin',
    get: (path) => guard(ndb.doc(path).get().then(raw)),
    query: (spec) => guard(build(spec).get().then((s) => result(s, false))),
    aggregate: (spec, aggs) =>
      guard(
        build(spec)
          .aggregate(Object.fromEntries(Object.entries(aggs).map(([k, a]: [string, Aggregate]) => [k, a.op === 'count' ? admin.AggregateField.count() : a.op === 'sum' ? admin.AggregateField.sum(a.field) : admin.AggregateField.average(a.field)])))
          .get()
          .then((s) => s.data() as Record<string, number | null>),
      ),
    set: (path, d, merge) => guard((merge ? ndb.doc(path).set(data(d), { merge: true }) : ndb.doc(path).set(data(d))).then(() => undefined)),
    create: (path, d) => guard(ndb.doc(path).create(data(d)).then(() => undefined)),
    update: (path, f) => guard(ndb.doc(path).update(...pairs(f)).then(() => undefined)),
    delete: (path) => guard(ndb.doc(path).delete().then(() => undefined)),
    listenDoc: (path, next, error) => ndb.doc(path).onSnapshot((s) => next(raw(s)), (e) => error(wrapAdminError(e))),
    listenQuery: (spec, next, error) => build(spec).onSnapshot((s) => next(result(s, true)), (e) => error(wrapAdminError(e))),
    transaction: (fn, opts) =>
      guard(
        ndb.runTransaction(
          (t) => {
            const tx: TxDriver = {
              get: async (path) => raw(await t.get(ndb.doc(path))),
              set: (path, d, merge) => void (merge ? t.set(ndb.doc(path), data(d), { merge: true }) : t.set(ndb.doc(path), data(d))),
              create: (path, d) => void t.create(ndb.doc(path), data(d)),
              update: (path, f) => void t.update(ndb.doc(path), ...pairs(f)),
              delete: (path) => void t.delete(ndb.doc(path)),
            };
            return fn(tx);
          },
          opts?.maxAttempts ? { maxAttempts: opts.maxAttempts } : undefined,
        ),
      ),
    batch: (): BatchDriver => {
      const b = ndb.batch();
      return {
        set: (path, d, merge) => void (merge ? b.set(ndb.doc(path), data(d), { merge: true }) : b.set(ndb.doc(path), data(d))),
        create: (path, d) => void b.create(ndb.doc(path), data(d)),
        update: (path, f) => void b.update(ndb.doc(path), ...pairs(f)),
        delete: (path) => void b.delete(ndb.doc(path)),
        commit: () => guard(b.commit().then(() => undefined)),
      };
    },
    terminate: () => ndb.terminate(),
    getAll: (paths) => guard(paths.length ? ndb.getAll(...paths.map((p) => ndb.doc(p))).then((ss) => ss.map(raw)) : Promise.resolve([])),
    listCollections: (docPath) => guard((docPath ? ndb.doc(docPath).listCollections() : ndb.listCollections()).then((cs) => cs.map((c) => c.id))),
    fromNative: (s) => raw(s as admin.DocumentSnapshot),
    recursiveDelete: (path) => guard(ndb.recursiveDelete(path.split('/').length % 2 ? ndb.collection(path) : ndb.doc(path))),
  };
}
