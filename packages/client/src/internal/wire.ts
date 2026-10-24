// How IceBase values travel to the IceBase server and sit in its database: JSON with tagged
// objects for the types JSON lacks. The `k` of a timestamp sorts as text in time order, so
// the SQL engine can index and compare it directly.

import { FieldValue, GeoPoint, Timestamp, isPlainObject } from '../values.ts';

export type Tagged =
  | { __ib: 'ts'; s: number; n: number; k: string }
  | { __ib: 'geo'; lat: number; lng: number }
  | { __ib: 'ref'; p: string }
  | { __ib: 'bytes'; b: string }
  | { __ib: 'fv'; op: FieldValue['op']; v?: unknown };

export const tsKey = (s: number, n: number): string => `${String(s + 62135596800).padStart(12, '0')}.${String(n).padStart(9, '0')}`;

const b64 = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function encode(v: unknown): unknown {
  if (v === null || v === undefined || typeof v !== 'object') return v;
  if (v instanceof Timestamp) return { __ib: 'ts', s: v.seconds, n: v.nanoseconds, k: tsKey(v.seconds, v.nanoseconds) };
  // A Date is stored as a timestamp, as Firestore does.
  if (v instanceof Date && !Number.isNaN(v.getTime())) return encode(Timestamp.fromDate(v));
  if (v instanceof GeoPoint) return { __ib: 'geo', lat: v.latitude, lng: v.longitude };
  if (v instanceof FieldValue) return { __ib: 'fv', op: v.op, ...(v.operand !== undefined ? { v: encode(v.operand) } : {}) };
  if (v instanceof Uint8Array) return { __ib: 'bytes', b: b64(v) };
  if ((v as { type?: unknown }).type === 'document' && typeof (v as { path?: unknown }).path === 'string') return { __ib: 'ref', p: (v as { path: string }).path };
  if (Array.isArray(v)) return v.map(encode);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, encode(x)]));
  return v;
}

export function decode(v: unknown, toRef: (path: string) => unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => decode(x, toRef));
  const t = v as Tagged;
  switch (t.__ib) {
    case 'ts':
      return new Timestamp(t.s, t.n);
    case 'geo':
      return new GeoPoint(t.lat, t.lng);
    case 'ref':
      return toRef(t.p);
    case 'bytes':
      return unb64(t.b);
    case 'fv':
      return new FieldValue(t.op, t.v === undefined ? undefined : decode(t.v, toRef));
  }
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x, toRef)]));
}

export const isTagged = (v: unknown): v is Tagged => !!v && typeof v === 'object' && typeof (v as { __ib?: unknown }).__ib === 'string';
