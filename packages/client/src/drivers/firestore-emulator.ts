// emulator mode: icebase/firestore talking to the IceBase server (client and admin alike;
// admin sends the owner token, which skips rules).

import { emulatorFetch, emulatorOrigin, service, type IceBaseApp } from '../app.ts';
import { IceBaseError } from '../errors.ts';
import type { FirestoreDriver, RawChange, RawDoc, RawQueryResult, TxDriver } from '../internal/firestore-driver.ts';
import { fullOrder, isName, type QuerySpec } from '../internal/plan.ts';
import { RealtimeClient, nextId } from '../internal/rt-client.ts';
import { decode, encode } from '../internal/wire.ts';
import type { DriverHelpers, Firestore } from '../firestore.ts';

interface WireDoc {
  path: string;
  id: string;
  data: Record<string, unknown> | null;
  createTime?: { s: number; n: number };
  updateTime?: { s: number; n: number };
  version: number;
}

/** The caller's token: 'owner' for admin apps, else the signed-in user's ID token (if auth is in use). */
export async function callerToken(app: IceBaseApp): Promise<string | null> {
  if (app.kind === 'admin') return app.options.emulator?.adminToken ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ICEBASE_ADMIN_TOKEN ?? 'owner';
  const auth = app._services.get('auth') as { currentUser?: { getIdToken(): Promise<string> } | null } | undefined;
  return auth?.currentUser ? auth.currentUser.getIdToken() : null;
}

export function realtimeOf(app: IceBaseApp): RealtimeClient {
  return service(app, 'emulator:rt', () => {
    const rt = new RealtimeClient(`${emulatorOrigin(app).replace(/^http/, 'ws')}${app.options.emulator?.socketPath ?? '/v1/rt'}`, () => callerToken(app));
    app._onDelete.push(() => rt.close());
    return rt;
  });
}

export async function post<T>(app: IceBaseApp, path: string, body: unknown): Promise<T> {
  const token = await callerToken(app);
  let res: Response;
  try {
    res = await emulatorFetch(`${emulatorOrigin(app)}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  } catch (e) {
    throw new IceBaseError('unavailable', `cannot reach the IceBase emulator at ${emulatorOrigin(app)} (is \`icebase dev\` running?): ${(e as Error).message}`);
  }
  const j = (await res.json()) as { error?: { code: IceBaseError['code']; message: string; details?: Record<string, unknown> } } & T;
  if (!res.ok || j.error) throw new IceBaseError(j.error?.code ?? 'internal', j.error?.message ?? `emulator ${res.status}`, j.error?.details ?? {});
  return j;
}

export function createEmulatorDriver(db: Firestore, h: DriverHelpers): FirestoreDriver {
  const app = db.app;
  if (db.databaseId !== '(default)') throw new IceBaseError('unimplemented', 'the IceBase emulator has one Firestore database, (default)', { reason: 'mode' });
  const toRef = (p: string) => h.toRef(p);
  const raw = (d: WireDoc): RawDoc => {
    const out: RawDoc = { id: d.id, path: d.path, data: d.data ? (decode(d.data, toRef) as Record<string, unknown>) : null, native: d };
    if (d.createTime) out.createTime = { seconds: d.createTime.s, nanoseconds: d.createTime.n };
    if (d.updateTime) out.updateTime = { seconds: d.updateTime.s, nanoseconds: d.updateTime.n };
    return out;
  };

  /** Snapshot cursors become values in the query's full order (+ the path for __name__). */
  const wireSpec = (spec: QuerySpec): QuerySpec => {
    const pos = (p: QuerySpec['start']) => {
      if (!p) return undefined;
      if (!p.snapshot) return { values: p.values.map(encode), inclusive: p.inclusive };
      const d = p.snapshot as WireDoc | { _raw?: { native?: WireDoc } };
      const w = ('path' in d ? d : d._raw?.native) as WireDoc | undefined;
      if (!w?.data) throw new IceBaseError('invalid-argument', 'a cursor snapshot must be an existing document');
      const values = fullOrder(spec).map((o) => (isName(o.field) ? w.path : o.field.reduce<unknown>((v, k) => (v && typeof v === 'object' ? (v as Record<string, unknown>)[k] : undefined), w.data)));
      return { values, inclusive: p.inclusive };
    };
    const filters = JSON.parse(JSON.stringify(spec.filters, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) && 'kind' in v && v.kind === 'field' ? { ...v, value: encode(v.value) } : v))) as QuerySpec['filters'];
    const start = pos(spec.start);
    const end = pos(spec.end);
    return { path: spec.path, collectionId: spec.collectionId, filters, orders: spec.orders, ...(spec.limit ? { limit: spec.limit } : {}), ...(start ? { start } : {}), ...(end ? { end } : {}) };
  };

  const writeOf = (op: 'set' | 'delete' | 'create', path: string, data?: Record<string, unknown>, merge?: boolean) => ({ op, path, ...(data ? { data: encode(data) } : {}), ...(merge ? { merge } : {}) });
  const updateOf = (path: string, fields: [string[], unknown][]) => ({ op: 'update', path, fields: fields.map(([p, v]) => ({ path: p, value: encode(v) })) });
  // An admin app made with { emulator: { unchecked: true } } writes without the server's schema check.
  const unchecked = app.kind === 'admin' && !!(app.options.emulator as { unchecked?: boolean } | undefined)?.unchecked;
  const commit = (writes: unknown[], preconditions: { path: string; version: number }[] = []) => post(app, '/v1/fs/commit', { writes, preconditions, ...(unchecked ? { unchecked } : {}) }).then(() => undefined);

  const diff = (prev: Map<string, { i: number; v: number }>, docs: WireDoc[]): RawChange[] => {
    const changes: RawChange[] = [];
    const now = new Map(docs.map((d, i) => [d.path, { i, v: d.version }]));
    for (const [p, o] of prev) if (!now.has(p)) changes.push({ type: 'removed', doc: { id: p.slice(p.lastIndexOf('/') + 1), path: p, data: null }, oldIndex: o.i, newIndex: -1 });
    docs.forEach((d, i) => {
      const o = prev.get(d.path);
      if (!o) changes.push({ type: 'added', doc: raw(d), oldIndex: -1, newIndex: i });
      else if (o.v !== d.version) changes.push({ type: 'modified', doc: raw(d), oldIndex: o.i, newIndex: i });
    });
    return changes;
  };

  return {
    kind: 'emulator',
    get: async (path) => raw((await post<{ docs: WireDoc[] }>(app, '/v1/fs/get', { paths: [path] })).docs[0]!),
    query: async (spec) => ({ docs: (await post<{ docs: WireDoc[] }>(app, '/v1/fs/query', { spec: wireSpec(spec) })).docs.map(raw) }),
    aggregate: async (spec, aggs) => (await post<{ result: Record<string, number | null> }>(app, '/v1/fs/aggregate', { spec: wireSpec(spec), aggs })).result,
    set: (path, data, merge) => commit([writeOf('set', path, data, merge)]),
    create: (path, data) => commit([writeOf('create', path, data)]),
    update: (path, fields) => commit([updateOf(path, fields)]),
    delete: (path) => commit([writeOf('delete', path)]),
    listenDoc(path, next, error) {
      return realtimeOf(app).listen('fs', nextId(), { kind: 'doc', path }, (m) => next(raw((m.docs as WireDoc[])[0]!)), error);
    },
    listenQuery(spec, next, error) {
      let prev = new Map<string, { i: number; v: number }>();
      return realtimeOf(app).listen(
        'fs',
        nextId(),
        { kind: 'query', spec: wireSpec(spec) },
        (m) => {
          const docs = m.docs as WireDoc[];
          const changes = diff(prev, docs);
          prev = new Map(docs.map((d, i) => [d.path, { i, v: d.version }]));
          const r: RawQueryResult = { docs: docs.map(raw), changes };
          next(r);
        },
        error,
      );
    },
    async transaction(fn, opts) {
      const attempts = opts?.maxAttempts ?? 5;
      for (let n = 1; ; n++) {
        const reads = new Map<string, number>();
        const writes: unknown[] = [];
        const tx: TxDriver = {
          async get(path) {
            if (writes.length) throw new IceBaseError('invalid-argument', 'Firestore transactions require all reads to be executed before all writes.');
            const d = (await post<{ docs: WireDoc[] }>(app, '/v1/fs/get', { paths: [path] })).docs[0]!;
            reads.set(path, d.version);
            return raw(d);
          },
          set: (path, d, merge) => void writes.push(writeOf('set', path, d, merge)),
          create: (path, d) => void writes.push(writeOf('create', path, d)),
          update: (path, f) => void writes.push(updateOf(path, f)),
          delete: (path) => void writes.push(writeOf('delete', path)),
        };
        const result = await fn(tx);
        try {
          await commit(writes, [...reads].map(([path, version]) => ({ path, version })));
          return result;
        } catch (e) {
          if ((e as IceBaseError).code !== 'aborted' || n >= attempts) throw e;
          await new Promise((r) => setTimeout(r, Math.min(20 * 2 ** n, 500) * Math.random()));
        }
      }
    },
    batch() {
      const writes: unknown[] = [];
      return {
        set: (path, d, merge) => void writes.push(writeOf('set', path, d, merge)),
        create: (path, d) => void writes.push(writeOf('create', path, d)),
        update: (path, f) => void writes.push(updateOf(path, f)),
        delete: (path) => void writes.push(writeOf('delete', path)),
        commit: () => commit(writes),
      };
    },
    terminate: async () => {},
    fromNative: (d) => raw(d as WireDoc),
    getAll: async (paths) => (await post<{ docs: WireDoc[] }>(app, '/v1/fs/get', { paths })).docs.map(raw),
    listCollections: async (docPath) => (await post<{ ids: string[] }>(app, '/v1/fs/listCollections', { path: docPath })).ids,
    recursiveDelete: async (path) => void (await post(app, '/v1/fs/recursiveDelete', { path })),
  };
}
