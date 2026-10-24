// Shared by the firebase-mode Realtime Database drivers (client SDK and firebase-admin).

import { IceBaseError } from '../errors.ts';
import type { RawDbSnapshot } from './database-driver.ts';
import { FieldValue, isPlainObject } from '../values.ts';

export type AnySnap = { key: string | null; val(): unknown; forEach(cb: (c: AnySnap) => boolean | void): boolean | void; hasChildren(): boolean };

export const raw = (s: AnySnap): RawDbSnapshot => {
  const children: { key: string; value: unknown }[] = [];
  if (s.hasChildren()) s.forEach((c) => void children.push({ key: c.key!, value: c.val() }));
  return { key: s.key, value: s.val() ?? null, children: s.hasChildren() ? children : null };
};

export const wrap = (e: unknown): Error => {
  const err = e as { code?: string; message?: string };
  if (err?.code === 'PERMISSION_DENIED' || /permission[_ ]denied/i.test(err?.message ?? '')) return new IceBaseError('permission-denied', err.message ?? 'permission denied', { service: 'database', cause: e });
  return e instanceof Error ? e : new Error(String(e));
};
export const guard = async <R>(p: Promise<R>): Promise<R> => {
  try {
    return await p;
  } catch (e) {
    throw wrap(e);
  }
};

/** IceBase sentinels → the SDK's. */
export function nativeValues(v: unknown, sv: { ts: () => unknown; inc: (n: number) => unknown }): unknown {
  if (v instanceof FieldValue) {
    if (v.op === 'serverTime') return sv.ts();
    if (v.op === 'increment') return sv.inc(v.operand as number);
    throw new IceBaseError('invalid-argument', `${v.op}() is a Firestore value; use serverTimestamp() / increment() from icebase/database`, { service: 'database' });
  }
  if (Array.isArray(v)) return v.map((x) => nativeValues(x, sv));
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, nativeValues(x, sv)]));
  return v;
}

