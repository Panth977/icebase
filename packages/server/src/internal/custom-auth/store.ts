// Where custom auth keeps its state: challenges, counters, blocks, OAuth states, identity
// links. A Realtime Database tree (config.auth.custom.security.store), because every value
// here is small, server-written and short-lived, and a counter wants one atomic increment on
// one path (see VardayiniDairy's limits.ts for the long version of that argument).

export interface Store {
  get<T>(path: string): Promise<T | null>;
  set(path: string, value: unknown): Promise<void>;
  update(path: string, value: Record<string, unknown>): Promise<void>;
  remove(path: string): Promise<void>;
  /** Atomic read-modify-write. `fn` may run more than once; return undefined to abort. */
  transaction<T>(path: string, fn: (cur: T | null) => T | null | undefined): Promise<{ committed: boolean; value: T | null }>;
}

/** For tests and the emulator. */
export function memoryStore(): Store & { dump(): Record<string, unknown> } {
  const root: Record<string, unknown> = {};
  const parts = (p: string) => p.split('/').filter(Boolean);
  const read = (p: string): unknown => parts(p).reduce<unknown>((n, k) => (n && typeof n === 'object' ? (n as Record<string, unknown>)[k] : undefined), root);
  const write = (p: string, v: unknown) => {
    const ks = parts(p);
    let n = root;
    for (const k of ks.slice(0, -1)) n = (n[k] && typeof n[k] === 'object' ? n[k] : (n[k] = {})) as Record<string, unknown>;
    const last = ks[ks.length - 1]!;
    if (v === null || v === undefined) delete n[last];
    else n[last] = structuredClone(v);
  };
  return {
    get: async <T>(p: string) => (structuredClone(read(p)) ?? null) as T | null,
    set: async (p, v) => write(p, v),
    update: async (p, v) => {
      for (const [k, x] of Object.entries(v)) write(`${p}/${k}`, x);
    },
    remove: async (p) => write(p, null),
    transaction: async <T>(p: string, fn: (cur: T | null) => T | null | undefined) => {
      const next = fn((structuredClone(read(p)) ?? null) as T | null);
      if (next === undefined) return { committed: false, value: (read(p) ?? null) as T | null };
      write(p, next);
      return { committed: true, value: next };
    },
    dump: () => structuredClone(root),
  };
}

/** firebase-admin's Realtime Database. */
export function rtdbStore(db: import('firebase-admin/database').Database): Store {
  return {
    get: async <T>(p: string) => (await db.ref(p).get()).val() as T | null,
    set: (p, v) => db.ref(p).set(v),
    update: (p, v) => db.ref(p).update(v),
    remove: (p) => db.ref(p).remove(),
    transaction: async <T>(p: string, fn: (cur: T | null) => T | null | undefined) => {
      // The first run sees null when nothing is cached; aborting there would abort for good, so
      // write null instead and let the server re-run fn with the real value if there is one.
      const r = await db.ref(p).transaction((cur: T | null) => {
        const next = fn(cur);
        return next === undefined && cur === null ? null : next;
      }, undefined, false);
      return { committed: r.committed, value: r.snapshot.val() as T | null };
    },
  };
}
