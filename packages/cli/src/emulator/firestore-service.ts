// Firestore on the IceBase server: the IceBase protocol over HTTP + the realtime socket,
// schema validation and composite-index checks on the server too, and firestore.rules for
// every request that is not the owner's.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { IceBaseError } from '@panth977/icebase/errors';
import { dnf, isName, type QuerySpec } from '@panth977/icebase/internal';
import { decode } from '@panth977/icebase/internal';
import { matchCollectionPath, schemaFromJson, validateUpdate, validateWrite, type AnyCollection } from '@panth977/icebase/schema';
import { applyUpdate, applyWrite, FirestoreEngine, matchesFilters, type Json, type Precondition, type StoredDoc, type Write } from './firestore-engine.ts';
import { firestoreIndexesJson, indexKey, type IndexesFile } from '../internal/firebase-indexes.ts';
import { loadRules, type RulesEngine } from './rules.ts';
import { json, type Caller, type EmulatorContext, type Live, type Service } from './server.ts';

export interface WireDoc {
  path: string;
  id: string;
  data: Record<string, Json> | null;
  createTime?: { s: number; n: number };
  updateTime?: { s: number; n: number };
  version: number;
}

export const toWire = (path: string, d: StoredDoc | null): WireDoc =>
  d ? { path, id: d.id, data: d.data, createTime: d.createTime, updateTime: d.updateTime, version: d.version } : { path, id: path.slice(path.lastIndexOf('/') + 1), data: null, version: 0 };

const collOf = (ctx: EmulatorContext, docPath: string): AnyCollection | null => matchCollectionPath(ctx.config.schema, docPath.slice(0, docPath.lastIndexOf('/')))?.collection ?? null;

/** One Firestore database: its engine, rules and listeners. */
interface FirestoreDb {
  engine: FirestoreEngine;
  reloadRules(): void;
  op(name: string, b: Record<string, unknown>, caller: Caller): Promise<Response | null>;
  socket(live: Live, msg: Record<string, unknown>): Promise<void>;
}

/** The rules a database runs: a ruleset set with the management API (until restart), else config.rules.firestore. */
function firestoreRulesSource(ctx: EmulatorContext, dbId: string): string | null {
  const deployed = ctx.deployedRules.get(`firestore:${dbId}`);
  if (deployed !== undefined) return deployed;
  const file = ctx.config.rules?.firestore;
  return file ? readFileSync(resolve(ctx.root, file), 'utf8') : null;
}

function firestoreDatabase(ctx: EmulatorContext, dbId: string, engine: FirestoreEngine): FirestoreDb {
  let rules: RulesEngine | null = null;
  const reloadRules = () => {
    const src = firestoreRulesSource(ctx, dbId);
    rules = src !== null ? loadRules(src, 'firestore') : null;
  };
  reloadRules();
  const db = `/databases/${dbId}/documents`;

  /** Rules context for one document path: request.resource / resource as rules see them. */
  const allow = async (caller: Caller, method: 'get' | 'list' | 'create' | 'update' | 'delete', path: string, resource: StoredDoc | null, requestData: Record<string, Json> | null, query?: QuerySpec) => {
    if (caller.admin) return;
    if (!rules && ctx.signingKey) throw new IceBaseError('permission-denied', 'firestore: no rules file, so only the admin may read or write on this server');
    if (!rules) return;
    const ok = await rules.allows({
      method,
      path: `${db}/${path}`,
      auth: caller.auth,
      resource: resource ? { data: resource.data, id: resource.id, path: `${db}/${path}` } : null,
      requestResource: requestData ? { data: requestData, id: path.slice(path.lastIndexOf('/') + 1), path: `${db}/${path}` } : null,
      query: query ? { limit: query.limit?.n ?? null, orderBy: query.orders[0]?.field.join('.') ?? null } : null,
      load: async (p) => {
        const d = await engine.get(p.replace(/^\/databases\/[^/]+\/documents\//, ''));
        return d ? { data: d.data, id: d.id, path: p } : null;
      },
    });
    if (!ok) throw new IceBaseError('permission-denied', `Missing or insufficient permissions (${method} ${path})`);
  };

  /**
   * "Rules are not filters": a list is allowed only when the rule holds for every document the
   * query could return. Wildcards the query does not pin (the document id; every parent in a
   * collection-group query) are unknown, and resource.data has only the fields the query fixes
   * with == — reading any other field is an error, which denies.
   */
  const ANY = '\u0000any';
  const allowList = async (caller: Caller, spec: QuerySpec, _docs: StoredDoc[]) => {
    if (caller.admin) return;
    if (!rules && ctx.signingKey) throw new IceBaseError('permission-denied', 'firestore: no rules file, so only the admin may read or write on this server');
    if (!rules) return;
    let path: string;
    if (spec.path !== null) path = `${spec.path}/${ANY}`;
    else {
      const c = Object.values(ctx.config.schema.collections).find((x) => x.id === spec.collectionId && x.group) ?? Object.values(ctx.config.schema.collections).find((x) => x.id === spec.collectionId);
      path = `${(c?.path ?? spec.collectionId).replace(/\{[^}]+\}/g, ANY)}/${ANY}`;
    }
    const conjs = dnf(spec.filters);
    // Every branch of an or() must be allowed on its own.
    for (const conj of conjs.length ? conjs : [[]]) {
      const fixed: Record<string, Json> = {};
      for (const f of conj) {
        if ((f.op !== '==' && f.op !== 'array-contains') || isName(f.field)) continue;
        let node = fixed;
        for (const k of f.field.slice(0, -1)) node = (node[k] && typeof node[k] === 'object' ? node[k] : (node[k] = {})) as Record<string, Json>;
        const key = f.field[f.field.length - 1]!;
        // array-contains: the list holds this value (and nothing else is known about it).
        if (f.op === 'array-contains') {
          const cur = node[key] as unknown as { __contains?: unknown[] } | undefined;
          node[key] = { __contains: [...(cur?.__contains ?? []), f.value] } as unknown as Json;
        } else node[key] = f.value as Json;
      }
      await allow(caller, 'list', path, { path, id: ANY, data: fixed, createTime: { s: 0, n: 0 }, updateTime: { s: 0, n: 0 }, version: 0 }, null, spec);
    }
  };

  const checkSchema = (w: Write) => {
    if (w.op === 'delete') return;
    const c = collOf(ctx, w.path);
    if (!c) throw new IceBaseError('invalid-argument', `${w.path}: not in the schema; IceBase only writes declared collections`, { reason: 'unknown-collection' });
    const toRef = (p: string) => ({ type: 'document', path: p, id: p.slice(p.lastIndexOf('/') + 1) });
    if (w.op === 'update') validateUpdate(c, w.fields.map((f) => [f.path, decode(f.value, toRef)] as const));
    else validateWrite(c, decode(w.data, toRef), w.op === 'create' ? 'create' : w.merge ? 'merge' : 'set');
  };

  const commit = async (caller: Caller, writes: Write[], pre: Precondition[], unchecked = false) => {
    // An admin may write without the schema check (seeding legacy-shaped data); no one else.
    if (!(unchecked && caller.admin)) for (const w of writes) checkSchema(w);
    if (!caller.admin && !rules && ctx.signingKey) throw new IceBaseError('permission-denied', 'firestore: no rules file, so only the admin may read or write on this server');
    if (!caller.admin && rules) {
      const preview = { s: 0, n: 0 };
      for (const w of writes) {
        const cur = await engine.get(w.path);
        if (w.op === 'delete') await allow(caller, 'delete', w.path, cur, null);
        else {
          const base = structuredClone(w.op === 'set' && !w.merge ? {} : (cur?.data ?? {}));
          const next = w.op === 'update' ? applyUpdate(base, w.fields, preview) : applyWrite(base, w.data, w.op === 'set' && w.merge ? 'merge' : 'set', preview);
          await allow(caller, cur ? 'update' : 'create', w.path, cur, next);
        }
      }
    }
    return engine.commit(writes, pre);
  };

  // ── realtime ────────────────────────────────────────────────────────────────

  interface Listener {
    live: Live;
    id: string;
    kind: 'doc' | 'query';
    path?: string;
    spec?: QuerySpec;
    last: string | null;
    /** A push in flight, and whether another change came while it ran. */
    running?: Promise<void> | null;
    again?: boolean;
  }
  const listeners = new Set<Listener>();
  // One push at a time per listener, the last one after the last change: reads that answer out of
  // order (Postgres connections) never leave an older snapshot as the latest.
  const push = (l: Listener): Promise<void> => {
    if (l.running) {
      l.again = true;
      return l.running;
    }
    l.running = (async () => {
      do {
        l.again = false;
        await pushOnce(l);
      } while (l.again && listeners.has(l));
      l.running = null;
    })();
    return l.running;
  };
  const pushOnce = async (l: Listener) => {
    try {
      let docs: WireDoc[];
      if (l.kind === 'doc') {
        const d = await engine.get(l.path!);
        await allow(l.live.caller, 'get', l.path!, d, null);
        docs = [toWire(l.path!, d)];
      } else {
        const found = await engine.query(l.spec!);
        await allowList(l.live.caller, l.spec!, found);
        docs = found.map((d) => toWire(d.path, d));
      }
      const key = docs.map((d) => `${d.path}@${d.version}`).join(',');
      if (key === l.last) return;
      l.last = key;
      l.live.send({ t: 'snap', s: 'fs', id: l.id, docs });
    } catch (e) {
      listeners.delete(l);
      const err = e instanceof IceBaseError ? { code: e.code, message: e.message } : { code: 'internal', message: (e as Error).message };
      l.live.send({ t: 'error', s: 'fs', id: l.id, error: err });
    }
  };
  engine.onChanges((changes) => {
    for (const l of listeners) {
      const hit = changes.some((c) => {
        if (l.kind === 'doc') return c.path === l.path;
        const s = l.spec!;
        if (c.collectionId !== s.collectionId) return false;
        if (s.path !== null && c.parent !== s.path) return false;
        // Only re-run when the change could enter or leave the result.
        return [c.before, c.after].some((d) => d && matchesFilters(d, s.filters));
      });
      if (hit) void push(l);
    }
  });

  return {
    engine,
    reloadRules,
    async op(name, b, caller) {
      switch (name) {
        case 'get': {
          const paths = b.paths as string[];
          const docs = await engine.getAll(paths);
          for (let i = 0; i < paths.length; i++) await allow(caller, 'get', paths[i]!, docs[i]!, null);
          return json({ docs: paths.map((p, i) => toWire(p, docs[i]!)) });
        }
        case 'query': {
          const spec = b.spec as QuerySpec;
          const docs = await engine.query(spec);
          await allowList(caller, spec, docs);
          return json({ docs: docs.map((d) => toWire(d.path, d)) });
        }
        case 'aggregate': {
          const spec = b.spec as QuerySpec;
          await allowList(caller, spec, await engine.query(spec));
          return json({ result: await engine.aggregate(spec, b.aggs as Record<string, never>) });
        }
        case 'commit':
          return json({ time: (await commit(caller, b.writes as Write[], (b.preconditions as Precondition[]) ?? [], b.unchecked === true)).time });
        case 'listCollections':
          if (!caller.admin) throw new IceBaseError('permission-denied', 'listCollections is admin only');
          return json({ ids: await engine.listCollections((b.path as string | null) ?? null) });
        case 'recursiveDelete':
          if (!caller.admin) throw new IceBaseError('permission-denied', 'recursiveDelete is admin only');
          return json({ deleted: await engine.recursiveDelete(b.path as string) });
        case 'reloadRules':
          if (!caller.admin) throw new IceBaseError('permission-denied', 'admin only');
          reloadRules();
          return json({ ok: true });
      }
      return null;
    },
    async socket(live, msg) {
      if (msg.t === 'listen') {
        const l: Listener = { live, id: String(msg.id), kind: msg.kind as 'doc' | 'query', ...(msg.path ? { path: String(msg.path) } : {}), ...(msg.spec ? { spec: msg.spec as QuerySpec } : {}), last: null };
        listeners.add(l);
        live.onClose(() => listeners.delete(l));
        await push(l);
      } else if (msg.t === 'unlisten') {
        for (const l of listeners) if (l.live === live && l.id === String(msg.id)) listeners.delete(l);
      }
    },
  };
}

/** A named database id as Firestore takes it: 4–63 of a-z 0-9 -, a letter first, not ending in -. */
const DB_ID = /^[a-z][a-z0-9-]{2,61}[a-z0-9]$/;

export async function firestoreService(ctx: EmulatorContext): Promise<Service> {
  const memory = ctx.dataDir === ':memory:';
  const dbs = new Map<string, FirestoreDb>([['(default)', firestoreDatabase(ctx, '(default)', ctx.firestore)]]);
  // Named databases (manageFirestore(app).createDb(id)): one store each (a SQLite file, a Postgres
  // schema), listed in the data directory.
  const listFile = memory ? null : join(ctx.dataDir, 'firestore-databases.json');
  const named: string[] = listFile && existsSync(listFile) ? (JSON.parse(readFileSync(listFile, 'utf8')) as string[]) : [];
  // The stores know them too (a migrated deployment, a new data directory on Postgres).
  for (const s of await ctx.stores.list()) if (s.startsWith('firestore-') && !named.includes(s.slice(10))) named.push(s.slice(10));
  const open = async (id: string): Promise<FirestoreDb> => {
    const d = firestoreDatabase(ctx, id, await FirestoreEngine.open({ store: await ctx.stores.open(`firestore-${id}`), schema: ctx.config.schema }));
    dbs.set(id, d);
    return d;
  };
  for (const id of named) await open(id);
  const dbOf = (b: Record<string, unknown>): FirestoreDb => {
    const id = typeof b.database === 'string' ? b.database : '(default)';
    const d = dbs.get(id);
    if (!d) throw new IceBaseError('not-found', `The database ${id} does not exist for project ${ctx.projectId} (create it with manageFirestore(app).createDb('${id}'))`);
    return d;
  };
  const info = (id: string) => ({ name: `projects/${ctx.projectId}/databases/${id}`, id, locationId: 'icebase', type: 'FIRESTORE_NATIVE' });
  const diffIndexes = (before: IndexesFile, after: IndexesFile) => {
    const had = new Set(before.indexes.map(indexKey));
    const has = new Set(after.indexes.map(indexKey));
    return {
      created: after.indexes.filter((ix) => !had.has(indexKey(ix))),
      deleted: before.indexes.filter((ix) => !has.has(indexKey(ix))).map((ix) => `${ix.collectionGroup}: ${ix.fields.map((f) => f.fieldPath).join(', ')}`),
      unchanged: after.indexes.filter((ix) => had.has(indexKey(ix))).length,
    };
  };

  return {
    async handle(req, url, caller) {
      if (!url.pathname.startsWith('/v1/fs/')) return null;
      if (req.method !== 'POST') return json({ error: { code: 'invalid-argument', message: 'POST only' } }, 405);
      const b = (await req.json()) as Record<string, unknown>;
      return dbOf(b).op(url.pathname.slice(7), b, caller);
    },
    async socket(live, msg) {
      // An unlisten names only the listener; every database drops it if it holds it.
      if (msg.t === 'unlisten') {
        for (const d of dbs.values()) await d.socket(live, msg);
        return;
      }
      await dbOf(msg).socket(live, msg);
    },
    async manage(op, b) {
      switch (op) {
        case 'listDbs':
          return { databases: [...dbs.keys()].map(info) };
        case 'sqlIndexes':
          // What the IceBase server built from the declared indexes, and the document count, per database.
          return { databases: await Promise.all([...dbs].map(async ([id, d]) => ({ id, documents: await d.engine.count(), sqlIndexes: d.engine.sqlIndexes }))) };
        case 'createDb': {
          const id = typeof b.id === 'string' ? b.id : '(default)';
          // The default database is always there on an IceBase server.
          if (id === '(default)') return info(id);
          if (!DB_ID.test(id)) throw new IceBaseError('invalid-argument', `createDb('${id}'): a database id is 4–63 characters of a-z, 0-9 and -, starting with a letter and not ending with -`);
          if (dbs.has(id)) throw new IceBaseError('already-exists', `Database '${id}' already exists`);
          await open(id);
          if (listFile) writeFileSync(listFile, JSON.stringify([...dbs.keys()].filter((k) => k !== '(default)')));
          return info(id);
        }
        case 'setRules': {
          const id = typeof b.database === 'string' ? b.database : '(default)';
          const d = dbOf({ database: id });
          const source = String(b.source ?? '');
          loadRules(source, 'firestore'); // a syntax error refuses the release, as Firebase does
          ctx.deployedRules.set(`firestore:${id}`, source);
          d.reloadRules();
          return { ruleset: `projects/${ctx.projectId}/rulesets/icebase-${Date.now()}`, release: `projects/${ctx.projectId}/releases/${id === '(default)' ? 'cloud.firestore' : `cloud.firestore/${id}`}` };
        }
        case 'setSchema':
        case 'setIndexes': {
          const before = firestoreIndexesJson(ctx.config.schema);
          if (b.schema) {
            const schema = schemaFromJson(b.schema);
            const after = firestoreIndexesJson(schema);
            // The server validates writes and plans queries with the schema it is given.
            (ctx as { config: EmulatorContext['config'] }).config = { ...ctx.config, schema };
            for (const d of dbs.values()) await d.engine.setSchema(schema);
            return { ...diffIndexes(before, after), fieldOverrides: op === 'setSchema' ? after.fieldOverrides.length : 0 };
          }
          // An index file: the IceBase server plans queries from the schema, so every index in the
          // file must already be declared there.
          const file = b.indexes as IndexesFile;
          const have = new Set(before.indexes.map(indexKey));
          const missing = file.indexes.filter((ix) => !have.has(indexKey(ix)));
          if (missing.length) {
            throw new IceBaseError('failed-precondition', `setIndexes: the IceBase server plans queries from the schema; declare these with index(…) and call setSchema(schema):\n${missing.map((ix) => `  ${ix.collectionGroup}: ${ix.fields.map((f) => `${f.fieldPath} ${f.order ?? f.arrayConfig}`).join(', ')}`).join('\n')}`);
          }
          return { created: [], deleted: [], unchanged: file.indexes.length, fieldOverrides: 0 };
        }
      }
      throw new IceBaseError('invalid-argument', `firestore: no management operation '${op}'`);
    },
    async close() {
      for (const [id, d] of dbs) if (id !== '(default)') await d.engine.close();
    },
  };
}
