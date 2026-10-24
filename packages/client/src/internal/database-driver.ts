// What a Realtime Database backend must do. icebase/database validates writes against the
// path schema and checks .indexOn; a driver only moves data.

export interface DbQuery {
  orderBy?: { kind: 'child'; child: string } | { kind: 'key' } | { kind: 'value' };
  startAt?: { value: unknown; key?: string };
  endAt?: { value: unknown; key?: string };
  equalTo?: { value: unknown; key?: string };
  limitToFirst?: number;
  limitToLast?: number;
}

export interface RawDbSnapshot {
  key: string | null;
  /** The value as stored (null when absent). */
  value: unknown;
  /** Children in query order (null for a leaf). */
  children: { key: string; value: unknown }[] | null;
}

export type ChildEvent = 'child_added' | 'child_changed' | 'child_removed';
export type DbEvent = 'value' | ChildEvent;

export interface DatabaseDriver {
  get(path: string, q: DbQuery | null): Promise<RawDbSnapshot>;
  set(path: string, value: unknown): Promise<void>;
  update(path: string, values: Record<string, unknown>): Promise<void>;
  remove(path: string): Promise<void>;
  /** A new chronological key under `path` (Firebase's push id), generated locally. */
  newKey(path: string): string;
  listen(path: string, q: DbQuery | null, event: DbEvent, cb: (s: RawDbSnapshot, prevKey: string | null) => void, cancel: (e: Error) => void): () => void;
  transaction(path: string, fn: (cur: unknown) => unknown, applyLocally: boolean): Promise<{ committed: boolean; snapshot: RawDbSnapshot }>;
  onDisconnect(path: string): { set(v: unknown): Promise<void>; update(v: Record<string, unknown>): Promise<void>; remove(): Promise<void>; cancel(): Promise<void> };
  goOffline?(): void;
  goOnline?(): void;
}

// Firebase's push ids: 8 chars of time + 12 random, sortable by creation.
const PUSH = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
let lastTime = 0;
const lastRand: number[] = [];
export function pushId(now: number = Date.now()): string {
  const dup = now === lastTime;
  lastTime = now;
  const time: string[] = [];
  let t = now;
  for (let i = 7; i >= 0; i--) {
    time[i] = PUSH.charAt(t % 64);
    t = Math.floor(t / 64);
  }
  if (!dup) {
    const bytes = new Uint8Array(12);
    globalThis.crypto.getRandomValues(bytes);
    for (let i = 0; i < 12; i++) lastRand[i] = bytes[i]! % 64;
  } else {
    let i = 11;
    for (; i >= 0 && lastRand[i] === 63; i--) lastRand[i] = 0;
    lastRand[i] = (lastRand[i] ?? 0) + 1;
  }
  return time.join('') + lastRand.map((r) => PUSH.charAt(r)).join('');
}
