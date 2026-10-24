// firebase mode, client side: the Realtime Database through the Firebase JS SDK.

import * as rd from 'firebase/database';
import type { DatabaseDriver, DbQuery } from '../internal/database-driver.js';
import { guard, nativeValues, raw, wrap, type AnySnap } from '../internal/database-shared.js';

export function webDatabaseDriver(db: rd.Database): DatabaseDriver {
  const sv = { ts: () => rd.serverTimestamp(), inc: (n: number) => rd.increment(n) };
  const q = (path: string, spec: DbQuery | null): rd.Query => {
    const r = rd.ref(db, path);
    if (!spec) return r;
    const cs: rd.QueryConstraint[] = [];
    if (spec.orderBy?.kind === 'child') cs.push(rd.orderByChild(spec.orderBy.child));
    else if (spec.orderBy?.kind === 'key') cs.push(rd.orderByKey());
    else if (spec.orderBy?.kind === 'value') cs.push(rd.orderByValue());
    const v = (x: unknown) => x as string | number | boolean | null;
    if (spec.startAt) cs.push(rd.startAt(v(spec.startAt.value), spec.startAt.key));
    if (spec.endAt) cs.push(rd.endAt(v(spec.endAt.value), spec.endAt.key));
    if (spec.equalTo) cs.push(rd.equalTo(v(spec.equalTo.value), spec.equalTo.key));
    if (spec.limitToFirst) cs.push(rd.limitToFirst(spec.limitToFirst));
    if (spec.limitToLast) cs.push(rd.limitToLast(spec.limitToLast));
    return rd.query(r, ...cs);
  };
  return {
    get: (path, spec) => guard(rd.get(q(path, spec)).then((s) => raw(s as unknown as AnySnap))),
    set: (path, v) => guard(rd.set(rd.ref(db, path), nativeValues(v, sv))),
    update: (path, v) => guard(rd.update(rd.ref(db, path), nativeValues(v, sv) as object)),
    remove: (path) => guard(rd.remove(rd.ref(db, path))),
    newKey: (path) => rd.push(rd.ref(db, path)).key!,
    listen(path, spec, event, cb, cancel) {
      const target = q(path, spec);
      const on = { value: rd.onValue, child_added: rd.onChildAdded, child_changed: rd.onChildChanged, child_removed: rd.onChildRemoved }[event];
      return on(target, (s: rd.DataSnapshot, prev?: string | null) => cb(raw(s as unknown as AnySnap), prev ?? null), (e: Error) => cancel(wrap(e)));
    },
    transaction: (path, fn, applyLocally) =>
      guard(rd.runTransaction(rd.ref(db, path), (cur) => nativeValues(fn(cur), sv), { applyLocally }).then((r) => ({ committed: r.committed, snapshot: raw(r.snapshot as unknown as AnySnap) }))),
    onDisconnect(path) {
      const d = rd.onDisconnect(rd.ref(db, path));
      return { set: (v) => guard(d.set(nativeValues(v, sv))), update: (v) => guard(d.update(nativeValues(v, sv) as object)), remove: () => guard(d.remove()), cancel: () => guard(d.cancel()) };
    },
    goOffline: () => rd.goOffline(db),
    goOnline: () => rd.goOnline(db),
  };
}

