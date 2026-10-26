// firebase mode, server side: the Realtime Database through firebase-admin.

import type { Database as AdminDatabase, Query as AdminQuery, DataSnapshot as AdminSnap } from 'firebase-admin/database';
import { ServerValue } from 'firebase-admin/database';
import type { DatabaseDriver, DbQuery } from '@panth977/icebase/internal';
import { guard, nativeValues, raw, wrap, type AnySnap } from '@panth977/icebase/internal';

export function adminDatabaseDriver(admin: AdminDatabase): DatabaseDriver {
  // firebase-admin wants no argument (not '') for the root.
  const db = { ref: (path?: string) => (path ? admin.ref(path) : admin.ref()) };
  const sv = { ts: () => ServerValue.TIMESTAMP, inc: (n: number) => ServerValue.increment(n) };
  const q = (path: string, spec: DbQuery | null): AdminQuery => {
    let r: AdminQuery = db.ref(path);
    if (!spec) return r;
    if (spec.orderBy?.kind === 'child') r = r.orderByChild(spec.orderBy.child);
    else if (spec.orderBy?.kind === 'key') r = r.orderByKey();
    else if (spec.orderBy?.kind === 'value') r = r.orderByValue();
    const v = (x: unknown) => x as string | number | boolean | null;
    if (spec.startAt) r = r.startAt(v(spec.startAt.value), spec.startAt.key);
    if (spec.endAt) r = r.endAt(v(spec.endAt.value), spec.endAt.key);
    if (spec.equalTo) r = r.equalTo(v(spec.equalTo.value), spec.equalTo.key);
    if (spec.limitToFirst) r = r.limitToFirst(spec.limitToFirst);
    if (spec.limitToLast) r = r.limitToLast(spec.limitToLast);
    return r;
  };
  return {
    get: (path, spec) => guard(q(path, spec).get().then((s) => raw(s as unknown as AnySnap))),
    set: (path, v) => guard(db.ref(path).set(nativeValues(v, sv))),
    update: (path, v) => guard(db.ref(path).update(nativeValues(v, sv) as object)),
    remove: (path) => guard(db.ref(path).remove()),
    newKey: (path) => db.ref(path).push().key!,
    listen(path, spec, event, cb, cancel) {
      const target = q(path, spec);
      const fn = (s: AdminSnap, prev?: string | null) => cb(raw(s as unknown as AnySnap), prev ?? null);
      target.on(event, fn, (e: Error) => cancel(wrap(e)));
      return () => target.off(event, fn);
    },
    transaction: (path, fn, applyLocally) =>
      guard(db.ref(path).transaction((cur) => nativeValues(fn(cur), sv), undefined, applyLocally).then((r) => ({ committed: r.committed, snapshot: raw(r.snapshot as unknown as AnySnap) }))),
    onDisconnect(path) {
      const d = db.ref(path).onDisconnect();
      return { set: (v) => guard(d.set(nativeValues(v, sv))), update: (v) => guard(d.update(nativeValues(v, sv) as object)), remove: () => guard(d.remove()), cancel: () => guard(d.cancel()) };
    },
  };
}
