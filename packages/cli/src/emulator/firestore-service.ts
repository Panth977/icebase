// Firestore on the IceBase server: the IceBase protocol over HTTP + the realtime socket,
// schema validation and composite-index checks on the server too, and firestore.rules for
// every request that is not the owner's.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { IceBaseError } from '@panth977/icebase/errors';
import { dnf, isName, type QuerySpec } from '@panth977/icebase/internal';
import { decode } from '@panth977/icebase/internal';
import { matchCollectionPath, validateUpdate, validateWrite, type AnyCollection } from '@panth977/icebase/schema';
import { applyUpdate, applyWrite, matchesFilters, type Json, type Precondition, type StoredDoc, type Write } from './firestore-engine.ts';
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

export async function firestoreService(ctx: EmulatorContext): Promise<Service> {
  const engine = ctx.firestore;
  let rules: RulesEngine | null = null;
  const reloadRules = () => {
    const file = ctx.config.rules?.firestore;
    rules = file ? loadRules(readFileSync(resolve(ctx.root, file), 'utf8'), 'firestore') : null;
  };
  reloadRules();
  const db = `/databases/(default)/documents`;

  /** Rules context for one document path: request.resource / resource as rules see them. */
  const allow = async (caller: Caller, method: 'get' | 'list' | 'create' | 'update' | 'delete', path: string, resource: StoredDoc | null, requestData: Record<string, Json> | null, query?: QuerySpec) => {
    if (caller.admin || !rules) return;
    const ok = await rules.allows({
      method,
      path: `${db}/${path}`,
      auth: caller.auth,
      resource: resource ? { data: resource.data, id: resource.id, path: `${db}/${path}` } : null,
      requestResource: requestData ? { data: requestData, id: path.slice(path.lastIndexOf('/') + 1), path: `${db}/${path}` } : null,
      query: query ? { limit: query.limit?.n ?? null, orderBy: query.orders[0]?.field.join('.') ?? null } : null,
      get: (p) => {
        const d = engine.get(p.replace(/^\/databases\/[^/]+\/documents\//, ''));
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
    if (caller.admin || !rules) return;
    let path: string;
    if (spec.path !== null) path = `${spec.path}/${ANY}`;
    else {
      const c = Object.values(ctx.config.schema.collections).find((x) => x.id === spec.collectionId);
      path = `${(c?.path ?? spec.collectionId).replace(/\{[^}]+\}/g, ANY)}/${ANY}`;
    }
    const conjs = dnf(spec.filters);
    // Every branch of an or() must be allowed on its own.
    for (const conj of conjs.length ? conjs : [[]]) {
      const fixed: Record<string, Json> = {};
      for (const f of conj) {
        if (f.op !== '==' || isName(f.field)) continue;
        let node = fixed;
        for (const k of f.field.slice(0, -1)) node = (node[k] && typeof node[k] === 'object' ? node[k] : (node[k] = {})) as Record<string, Json>;
        node[f.field[f.field.length - 1]!] = f.value as Json;
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

  const commit = async (caller: Caller, writes: Write[], pre: Precondition[]) => {
    for (const w of writes) checkSchema(w);
    if (!caller.admin && rules) {
      const preview = { s: 0, n: 0 };
      for (const w of writes) {
        const cur = engine.get(w.path);
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
    last: string;
  }
  const listeners = new Set<Listener>();
  const push = async (l: Listener) => {
    try {
      let docs: WireDoc[];
      if (l.kind === 'doc') {
        const d = engine.get(l.path!);
        await allow(l.live.caller, 'get', l.path!, d, null);
        docs = [toWire(l.path!, d)];
      } else {
        const found = engine.query(l.spec!);
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
    async handle(req, url, caller) {
      if (!url.pathname.startsWith('/v1/fs/')) return null;
      if (req.method !== 'POST') return json({ error: { code: 'invalid-argument', message: 'POST only' } }, 405);
      const b = (await req.json()) as Record<string, unknown>;
      switch (url.pathname.slice(7)) {
        case 'get': {
          const paths = b.paths as string[];
          const docs = engine.getAll(paths);
          for (let i = 0; i < paths.length; i++) await allow(caller, 'get', paths[i]!, docs[i]!, null);
          return json({ docs: paths.map((p, i) => toWire(p, docs[i]!)) });
        }
        case 'query': {
          const spec = b.spec as QuerySpec;
          const docs = engine.query(spec);
          await allowList(caller, spec, docs);
          return json({ docs: docs.map((d) => toWire(d.path, d)) });
        }
        case 'aggregate': {
          const spec = b.spec as QuerySpec;
          await allowList(caller, spec, engine.query(spec));
          return json({ result: engine.aggregate(spec, b.aggs as Record<string, never>) });
        }
        case 'commit':
          return json({ time: (await commit(caller, b.writes as Write[], (b.preconditions as Precondition[]) ?? [])).time });
        case 'listCollections':
          if (!caller.admin) throw new IceBaseError('permission-denied', 'listCollections is admin only');
          return json({ ids: engine.listCollections((b.path as string | null) ?? null) });
        case 'recursiveDelete':
          if (!caller.admin) throw new IceBaseError('permission-denied', 'recursiveDelete is admin only');
          return json({ deleted: engine.recursiveDelete(b.path as string) });
        case 'reloadRules':
          if (!caller.admin) throw new IceBaseError('permission-denied', 'admin only');
          reloadRules();
          return json({ ok: true });
      }
      return null;
    },
    async socket(live, msg) {
      if (msg.t === 'listen') {
        const l: Listener = { live, id: String(msg.id), kind: msg.kind as 'doc' | 'query', ...(msg.path ? { path: String(msg.path) } : {}), ...(msg.spec ? { spec: msg.spec as QuerySpec } : {}), last: '' };
        listeners.add(l);
        live.onClose(() => listeners.delete(l));
        await push(l);
      } else if (msg.t === 'unlisten') {
        for (const l of listeners) if (l.live === live && l.id === String(msg.id)) listeners.delete(l);
      }
    },
  };
}
