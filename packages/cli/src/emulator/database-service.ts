// The Realtime Database on the IceBase server: one JSON tree (persisted to SQLite), queries
// with Firebase's ordering, value listeners over the socket, onDisconnect, and
// database.rules.json (.read / .write / .validate) for every caller that is not the owner.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IceBaseError } from '@panth977/icebase/errors';
import type { DbQuery } from '@panth977/icebase/internal';
import { json, type Caller, type EmulatorContext, type Live, type Service } from './server.ts';

type Node = null | boolean | number | string | { [k: string]: Node };

const segs = (p: string) => p.split('/').filter(Boolean);
const isObj = (v: unknown): v is Record<string, Node> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Arrays become objects with numeric keys, empty objects and nulls vanish — as Firebase stores them. */
function normalize(v: unknown): Node {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) v = Object.fromEntries(v.map((x, i) => [String(i), x]));
  if (isObj(v)) {
    const out: Record<string, Node> = {};
    for (const [k, x] of Object.entries(v)) {
      const n = normalize(x);
      if (n !== null) out[k] = n;
    }
    return Object.keys(out).length ? out : null;
  }
  return v as Node;
}

/** Firebase returns an object with keys 0..n-1 (mostly dense) as an array. */
function exportVal(v: Node): unknown {
  if (!isObj(v)) return v;
  const keys = Object.keys(v);
  const ints = keys.every((k) => /^(0|[1-9]\d*)$/.test(k));
  if (ints && keys.length) {
    const max = Math.max(...keys.map(Number));
    if (max < 2 * keys.length) {
      const arr: unknown[] = [];
      for (let i = 0; i <= max; i++) arr.push(i in v ? exportVal(v[String(i)]!) : null);
      return arr;
    }
  }
  return Object.fromEntries(keys.map((k) => [k, exportVal(v[k]!)]));
}

function getAt(root: Node, path: string): Node {
  let cur: Node = root;
  for (const s of segs(path)) {
    if (!isObj(cur)) return null;
    cur = cur[s] ?? null;
  }
  return cur;
}

function setAt(root: Node, path: string, value: Node): Node {
  const ks = segs(path);
  if (!ks.length) return value;
  const out: Record<string, Node> = isObj(root) ? { ...root } : {};
  const [head, ...rest] = ks;
  const child = setAt(out[head!] ?? null, rest.join('/'), value);
  if (child === null) delete out[head!];
  else out[head!] = child;
  return Object.keys(out).length ? out : null;
}

// ─── Firebase's ordering ───────────────────────────────────────────────────────

const keyRank = (k: string) => (/^-?(0|[1-9]\d*)$/.test(k) && Math.abs(Number(k)) <= 2 ** 31 - 1 ? 0 : 1);
export function cmpKey(a: string, b: string): number {
  const ra = keyRank(a);
  const rb = keyRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return Number(a) - Number(b);
  return a < b ? -1 : a > b ? 1 : 0;
}
const valRank = (v: Node) => (v === null ? 0 : v === false ? 1 : v === true ? 2 : typeof v === 'number' ? 3 : typeof v === 'string' ? 4 : 5);
function cmpVal(a: Node, b: Node): number {
  const ra = valRank(a);
  const rb = valRank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 3) return (a as number) - (b as number);
  if (ra === 4) return (a as string) < (b as string) ? -1 : (a as string) > (b as string) ? 1 : 0;
  return 0;
}

export function runQuery(node: Node, q: DbQuery | null): { key: string; value: Node }[] {
  if (!isObj(node)) return [];
  let items = Object.entries(node).map(([key, value]) => ({ key, value }));
  const ob = q?.orderBy ?? { kind: 'key' as const };
  const sortVal = (x: { key: string; value: Node }): Node => (ob.kind === 'child' ? getAt(x.value, ob.child.replace(/\./g, '/')) : ob.kind === 'value' ? x.value : x.key);
  const cmp = (a: { key: string; value: Node }, b: { key: string; value: Node }) => (ob.kind === 'key' ? cmpKey(a.key, b.key) : cmpVal(sortVal(a), sortVal(b)) || cmpKey(a.key, b.key));
  items.sort(cmp);
  const pos = (v: unknown, key?: string) => ({ key: key ?? '', value: (ob.kind === 'child' ? setAt(null, ob.child.replace(/\./g, '/'), v as Node) : v) as Node });
  const at = (p: { value: unknown; key?: string }, edge: 'start' | 'end') => (x: { key: string; value: Node }) => {
    const target = ob.kind === 'key' ? { key: String(p.value), value: null } : pos(p.value, p.key);
    let c = ob.kind === 'key' ? cmpKey(x.key, target.key) : cmpVal(sortVal(x), ob.kind === 'child' ? getAt(target.value, ob.child.replace(/\./g, '/')) : target.value);
    if (c === 0 && ob.kind !== 'key' && p.key !== undefined) c = cmpKey(x.key, p.key);
    return edge === 'start' ? c >= 0 : c <= 0;
  };
  if (q?.equalTo) items = items.filter((x) => at(q.equalTo!, 'start')(x) && at(q.equalTo!, 'end')(x));
  if (q?.startAt) items = items.filter(at(q.startAt, 'start'));
  if (q?.endAt) items = items.filter(at(q.endAt, 'end'));
  if (q?.limitToFirst) items = items.slice(0, q.limitToFirst);
  if (q?.limitToLast) items = items.slice(-q.limitToLast);
  return items;
}

// ─── database.rules.json ───────────────────────────────────────────────────────

type RuleNode = { [k: string]: RuleNode | string | boolean | string[] };

/** A RuleDataSnapshot (data / newData / root) for rule expressions. */
class Snap {
  constructor(
    private readonly tree: Node,
    private readonly path: string,
  ) {}
  private get v(): Node {
    return getAt(this.tree, this.path);
  }
  val(): unknown {
    return exportVal(this.v);
  }
  child(p: string): Snap {
    return new Snap(this.tree, `${this.path}/${p}`);
  }
  parent(): Snap {
    return new Snap(this.tree, segs(this.path).slice(0, -1).join('/'));
  }
  exists(): boolean {
    return this.v !== null;
  }
  hasChild(p: string): boolean {
    return this.child(p).exists();
  }
  hasChildren(keys?: string[]): boolean {
    const v = this.v;
    if (!isObj(v)) return false;
    return keys ? keys.every((k) => k in v) : Object.keys(v).length > 0;
  }
  isNumber(): boolean {
    return typeof this.v === 'number';
  }
  isString(): boolean {
    return typeof this.v === 'string';
  }
  isBoolean(): boolean {
    return typeof this.v === 'boolean';
  }
  getPriority(): null {
    return null;
  }
}

/** Evaluate one rule expression (JavaScript-like) with the RTDB rule variables in scope. */
function evalRule(expr: string | boolean, vars: Record<string, unknown>): boolean {
  if (typeof expr === 'boolean') return expr;
  // The rules language is a small, side-effect-free JS subset; translate its two oddities.
  const js = expr.replace(/\.matches\(\/((?:[^/\\]|\\.)+)\/([a-z]*)\)/g, (_m, re: string, fl: string) => `.__matches(${JSON.stringify(re)}, ${JSON.stringify(fl)})`);
  if (/\b(function|=>|new|this|globalThis|process|require|import|constructor|__proto__|prototype|eval|while|for)\b|[;`{}]/.test(js.replace(/'[^']*'|"[^"]*"/g, ''))) {
    throw new IceBaseError('invalid-argument', `database.rules.json: unsupported expression: ${expr}`, { reason: 'config' });
  }
  const names = Object.keys(vars);
  // The rules language's string methods, present only while a rule runs (evaluation is synchronous).
  const proto = String.prototype as unknown as Record<string, unknown>;
  const extra: Record<string, unknown> = {
    contains(this: string, s: string) {
      return this.includes(s);
    },
    beginsWith(this: string, s: string) {
      return this.startsWith(s);
    },
    __matches(this: string, re: string, fl: string) {
      return new RegExp(re, fl).test(this);
    },
  };
  for (const [k, f] of Object.entries(extra)) Object.defineProperty(proto, k, { value: f, configurable: true });
  try {
    // The rules file is the developer's own (like firestore.rules); never request data.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    return new Function(...names, `"use strict"; return (${js});`)(...names.map((n) => vars[n])) === true;
  } catch {
    return false;
  } finally {
    for (const k of Object.keys(extra)) delete proto[k];
  }
}

export function loadDatabaseRules(source: string): { canRead(path: string, auth: Caller['auth'], root: Node): boolean; canWrite(path: string, auth: Caller['auth'], root: Node, next: Node): boolean } {
  const parsed = JSON.parse(source.replace(/^\s*\/\/.*$/gm, '')) as { rules: RuleNode };
  const rules = parsed.rules;
  /** Walk the rule tree along a path, yielding each level's node and the $variables bound so far. */
  const levels = (path: string) => {
    const out: { node: RuleNode; vars: Record<string, string>; at: string }[] = [];
    let node: RuleNode | undefined = rules;
    let vars: Record<string, string> = {};
    let at = '';
    out.push({ node: rules, vars, at });
    for (const s of segs(path)) {
      if (!node) break;
      const lit = node[s];
      let next: RuleNode | undefined;
      if (lit && typeof lit === 'object' && !Array.isArray(lit)) next = lit as RuleNode;
      else {
        const wild = Object.keys(node).find((k) => k.startsWith('$'));
        if (wild) {
          next = node[wild] as RuleNode;
          vars = { ...vars, [wild]: s };
        }
      }
      at = `${at}/${s}`;
      node = next;
      if (node) out.push({ node, vars, at });
    }
    return out;
  };
  const scope = (auth: Caller['auth'], root: Node, at: string, vars: Record<string, string>, next?: Node) => ({
    auth: auth ? { uid: auth.uid, token: auth.token, provider: (auth.token.firebase as { sign_in_provider?: string } | undefined)?.sign_in_provider } : null,
    root: new Snap(root, ''),
    data: new Snap(root, at),
    newData: new Snap(next ?? root, at),
    now: Date.now(),
    ...vars,
  });
  return {
    // .read / .write cascade: true at any level above or at the path grants it.
    canRead(path, auth, root) {
      return levels(path).some((l) => l.node['.read'] !== undefined && evalRule(l.node['.read'] as string | boolean, scope(auth, root, l.at, l.vars)));
    },
    canWrite(path, auth, root, next) {
      const ok = levels(path).some((l) => l.node['.write'] !== undefined && evalRule(l.node['.write'] as string | boolean, scope(auth, root, l.at, l.vars, next)));
      if (!ok) return false;
      // .validate must hold at every level of the new data that has one (on and below the path).
      const validate = (node: RuleNode, at: string, vars: Record<string, string>): boolean => {
        if (node['.validate'] !== undefined && getAt(next, at) !== null && !evalRule(node['.validate'] as string | boolean, scope(auth, root, at, vars, next))) return false;
        const value = getAt(next, at);
        if (!isObj(value)) return true;
        for (const k of Object.keys(value)) {
          const lit = node[k];
          const wild = Object.keys(node).find((x) => x.startsWith('$'));
          if (lit && typeof lit === 'object' && !Array.isArray(lit)) {
            if (!validate(lit as RuleNode, `${at}/${k}`, vars)) return false;
          } else if (wild) {
            if (!validate(node[wild] as RuleNode, `${at}/${k}`, { ...vars, [wild]: k })) return false;
          }
        }
        return true;
      };
      const lv = levels(path);
      for (const l of lv.slice(0, -1)) if (l.node['.validate'] !== undefined && !evalRule(l.node['.validate'] as string | boolean, scope(auth, root, l.at, l.vars, next))) return false;
      const last = lv[lv.length - 1];
      return !last || last.at !== `/${segs(path).join('/')}`.replace(/^\/$/, '') ? true : validate(last.node, last.at, last.vars);
    },
  };
}

// ─── the service ───────────────────────────────────────────────────────────────

const ts = () => Date.now();
function resolveSentinels(v: unknown, cur: Node): Node {
  if (v && typeof v === 'object' && (v as { __ib?: string }).__ib === 'fv') {
    const fv = v as { op: string; v?: number };
    if (fv.op === 'serverTime') return ts();
    if (fv.op === 'increment') return (typeof cur === 'number' ? cur : 0) + (fv.v ?? 0);
    throw new IceBaseError('invalid-argument', `${fv.op}() is not a Realtime Database value`);
  }
  if (isObj(v) || Array.isArray(v)) {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
    return normalize(Object.fromEntries(entries.map(([k, x]) => [k, resolveSentinels(x, isObj(cur) ? (cur[k] ?? null) : null)])));
  }
  return normalize(v);
}

/** One Realtime Database instance (the project's default, or one made with createDb). */
interface DbInstance extends Service {
  reloadRules(): void;
}

function databaseInstance(ctx: EmulatorContext, instance: string, isDefault: boolean): DbInstance {
  const file = ctx.dataDir === ':memory:' ? ':memory:' : join(ctx.dataDir, isDefault ? 'database.sqlite' : `database-${instance}.sqlite`);
  const sql = new DatabaseSync(file);
  sql.exec(`CREATE TABLE IF NOT EXISTS tree (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`);
  let root: Node = JSON.parse((sql.prepare(`SELECT json FROM tree WHERE id = 1`).get() as { json: string } | undefined)?.json ?? 'null') as Node;
  let dirty: ReturnType<typeof setTimeout> | null = null;
  const persist = () => {
    if (dirty) return;
    dirty = setTimeout(() => {
      dirty = null;
      sql.prepare(`INSERT INTO tree (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`).run(JSON.stringify(root));
    }, 50);
  };

  let rules: ReturnType<typeof loadDatabaseRules> | null = null;
  // Rules set with the management API (until restart), else config.rules.database.
  const reloadRules = () => {
    const deployed = ctx.deployedRules.get(`database:${instance}`);
    const rulesFile = ctx.config.rules?.database;
    rules = deployed !== undefined ? loadDatabaseRules(deployed) : rulesFile ? loadDatabaseRules(readFileSync(resolve(ctx.root, rulesFile), 'utf8')) : null;
  };
  reloadRules();

  const canRead = (c: Caller, path: string) => {
    if (c.admin) return;
    if (!rules && ctx.signingKey) throw new IceBaseError('permission-denied', 'database: no rules file, so only the admin may read or write on this server');
    if (!rules) return;
    if (!rules.canRead(path, c.auth, root)) throw new IceBaseError('permission-denied', `Permission denied (read ${path || '/'})`);
  };

  interface Sub {
    live: Live;
    id: string;
    path: string;
    query: DbQuery | null;
    last: string;
  }
  const subs = new Set<Sub>();
  const snapshot = (path: string, q: DbQuery | null) => {
    const node = getAt(root, path);
    const children = isObj(node) ? runQuery(node, q).map((c) => ({ key: c.key, value: exportVal(c.value) })) : null;
    const value = q && children ? (children.length ? Object.fromEntries(children.map((c) => [c.key, c.value])) : null) : exportVal(node);
    return { key: segs(path).pop() ?? null, value, children };
  };
  const notify = (changed: string[]) => {
    for (const s of subs) {
      const hit = changed.some((p) => p === s.path || p.startsWith(`${s.path}/`) || s.path.startsWith(`${p}/`) || p === '' || s.path === '');
      if (!hit) continue;
      try {
        canRead(s.live.caller, s.path);
      } catch (e) {
        subs.delete(s);
        s.live.send({ t: 'error', s: 'db', id: s.id, error: { code: 'permission-denied', message: (e as Error).message } });
        continue;
      }
      const snap = snapshot(s.path, s.query);
      const key = JSON.stringify(snap.children ?? snap.value);
      if (key === s.last) continue;
      s.last = key;
      s.live.send({ t: 'snap', s: 'db', id: s.id, snap });
    }
  };

  const write = (c: Caller, ops: { path: string; value: unknown }[]) => {
    let next = root;
    for (const o of ops) next = setAt(next, o.path, resolveSentinels(o.value, getAt(next, o.path)));
    if (!c.admin && !rules && ctx.signingKey) throw new IceBaseError('permission-denied', 'database: no rules file, so only the admin may read or write on this server');
    if (!c.admin && rules) for (const o of ops) if (!rules.canWrite(o.path, c.auth, root, next)) throw new IceBaseError('permission-denied', `Permission denied (write ${o.path || '/'})`);
    const prev = root;
    root = next;
    persist();
    notify(ops.map((o) => segs(o.path).join('/')));
    // Database triggers fire for the default instance.
    if (isDefault && ctx.hooks.database.length) {
      const e = { paths: ops.map((o) => segs(o.path).join('/')), before: (p: string) => exportVal(getAt(prev, p)), after: (p: string) => exportVal(getAt(next, p)) };
      for (const h of ctx.hooks.database) h(e);
    }
  };

  const disconnects = new Map<Live, { path: string; value: unknown; id: string }[]>();
  const clean = (p: unknown) => segs(String(p ?? '')).join('/');

  return {
    reloadRules,
    async handle(req, url, caller) {
      // Firebase's REST API for reading, GET /__/icebase/rtdb/{path}.json?auth=<ID token>: the value,
      // or (Accept: text/event-stream) its stream — event: put {"path":"/","data":…} now and on
      // every change, keep-alive every 30 s, auth_revoked when the token expires.
      if (isDefault && (url.pathname.startsWith('/__/icebase/rtdb/') || url.pathname === '/__/icebase/rtdb.json')) {
        if (req.method !== 'GET') return json({ error: 'Only GET is served here' }, 405);
        const raw = url.pathname === '/__/icebase/rtdb.json' ? '' : url.pathname.slice('/__/icebase/rtdb/'.length);
        if (raw && !raw.endsWith('.json')) return json({ error: 'The path must end in .json' }, 400);
        const path = clean(decodeURIComponent(raw.replace(/\.json$/, '')));
        const token = url.searchParams.get('auth');
        const who: Caller = token ? await ctx.verify(token) : caller;
        if (token && !who.admin && !who.auth) return json({ error: 'Could not parse auth token.' }, 401);
        try {
          canRead(who, path);
        } catch {
          return json({ error: 'Permission denied' }, 401);
        }
        if (!(req.headers.get('accept') ?? '').includes('text/event-stream')) return json(snapshot(path, null).value);
        const enc = new TextEncoder();
        const closers: (() => void)[] = [];
        let closed = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const event = (name: string, data: unknown) => {
              if (!closed) controller.enqueue(enc.encode(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`));
            };
            const end = () => {
              if (closed) return;
              closed = true;
              closers.splice(0).forEach((f) => f());
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            };
            const live: Live = {
              caller: who,
              send: (msg) => {
                const m = msg as { t?: string; snap?: { value: unknown } };
                if (m.t === 'snap') event('put', { path: '/', data: m.snap?.value ?? null });
                else if (m.t === 'error') {
                  event('cancel', 'Permission denied');
                  end();
                }
              },
              onClose: (fn) => void closers.push(fn),
            };
            const sub: Sub = { live, id: `rest-${Math.random()}`, path, query: null, last: '' };
            subs.add(sub);
            closers.push(() => subs.delete(sub));
            const snap = snapshot(path, null);
            sub.last = JSON.stringify(snap.value);
            event('put', { path: '/', data: snap.value ?? null });
            const keep = setInterval(() => event('keep-alive', null), 30_000);
            closers.push(() => clearInterval(keep));
            const exp = Number((who.auth?.token as { exp?: number } | undefined)?.exp);
            if (exp) {
              const t = setTimeout(() => {
                event('auth_revoked', 'credential is no longer valid');
                end();
              }, Math.max(0, exp * 1000 - Date.now()));
              closers.push(() => clearTimeout(t));
            }
            req.signal.addEventListener('abort', end);
          },
          cancel() {
            closed = true;
            closers.splice(0).forEach((f) => f());
          },
        });
        return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' } });
      }
      if (!url.pathname.startsWith('/v1/db/')) return null;
      const b = ((req as Request & { _body?: Record<string, unknown> })._body ?? (await req.json().catch(() => ({})))) as Record<string, unknown>;
      const path = clean(b.path);
      switch (url.pathname.slice(7)) {
        case 'get':
          canRead(caller, path);
          return json(snapshot(path, (b.query as DbQuery | null) ?? null));
        case 'set':
          write(caller, [{ path, value: b.value }]);
          return json({ ok: true });
        case 'update': {
          const values = b.values as Record<string, unknown>;
          write(caller, Object.entries(values).map(([k, v]) => ({ path: clean(`${path}/${k}`), value: v })));
          return json({ ok: true });
        }
        case 'transaction': {
          // Optimistic: the client sends what it saw; a mismatch returns the current value to retry with.
          const cur = exportVal(getAt(root, path));
          if (JSON.stringify(cur) !== JSON.stringify(b.expect ?? null)) return json({ committed: false, current: cur });
          if (b.abort) return json({ committed: false, current: cur });
          write(caller, [{ path, value: b.value }]);
          return json({ committed: true, snap: snapshot(path, null) });
        }
      }
      return null;
    },
    async socket(live, msg) {
      if (msg.t === 'listen') {
        const s: Sub = { live, id: String(msg.id), path: clean(msg.path), query: (msg.query as DbQuery | null) ?? null, last: '' };
        canRead(live.caller, s.path);
        subs.add(s);
        live.onClose(() => subs.delete(s));
        const snap = snapshot(s.path, s.query);
        s.last = JSON.stringify(snap.children ?? snap.value);
        live.send({ t: 'snap', s: 'db', id: s.id, snap });
      } else if (msg.t === 'unlisten') {
        for (const s of subs) if (s.live === live && s.id === String(msg.id)) subs.delete(s);
      } else if (msg.t === 'onDisconnect') {
        let list = disconnects.get(live);
        if (!list) {
          disconnects.set(live, (list = []));
          live.onClose(() => {
            const ops = disconnects.get(live) ?? [];
            disconnects.delete(live);
            try {
              if (ops.length) write({ admin: true, auth: null }, ops.map(({ path, value }) => ({ path, value })));
            } catch (e) {
              console.error('[icebase database] onDisconnect', e);
            }
          });
        }
        const path = clean(msg.path);
        if (msg.op === 'cancel') disconnects.set(live, list.filter((o) => o.path !== path && !o.path.startsWith(`${path}/`)));
        else if (msg.op === 'update') for (const [k, v] of Object.entries(msg.value as Record<string, unknown>)) list.push({ path: clean(`${path}/${k}`), value: v, id: String(msg.id) });
        else list.push({ path, value: msg.op === 'remove' ? null : msg.value, id: String(msg.id) });
        live.send({ t: 'ok', s: 'db', id: msg.id });
      }
    },
    close() {
      if (dirty) {
        clearTimeout(dirty);
        sql.prepare(`INSERT INTO tree (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json`).run(JSON.stringify(root));
      }
      sql.close();
    },
  };
}

/** A Realtime Database instance name as Firebase takes it: 6–63 of a-z 0-9 -. */
const INSTANCE = /^[a-z0-9][a-z0-9-]{4,61}[a-z0-9]$/;

export function databaseService(ctx: EmulatorContext): Service {
  const defaultId = `${ctx.projectId}-default-rtdb`;
  const instances = new Map<string, DbInstance>([[defaultId, databaseInstance(ctx, defaultId, true)]]);
  const listFile = ctx.dataDir === ':memory:' ? null : join(ctx.dataDir, 'database-instances.json');
  const open = (id: string) => {
    const d = databaseInstance(ctx, id, false);
    instances.set(id, d);
    return d;
  };
  if (listFile && existsSync(listFile)) for (const id of JSON.parse(readFileSync(listFile, 'utf8')) as string[]) open(id);
  // A request names its instance with `ns` (the instance id); none is the default.
  const instanceOf = (ns: unknown): DbInstance => {
    const id = typeof ns === 'string' && ns && ns !== defaultId ? ns : defaultId;
    const d = instances.get(id);
    if (!d) throw new IceBaseError('not-found', `no Realtime Database instance '${id}' (create it with manageDatabase(app).createDb('${id}'))`);
    return d;
  };
  const info = (id: string, origin: string) => ({ name: `projects/${ctx.projectId}/locations/icebase/instances/${id}`, id, databaseUrl: `${origin}?ns=${id}`, type: id === defaultId ? 'DEFAULT_DATABASE' : 'USER_DATABASE', state: 'ACTIVE' });
  return {
    async handle(req, url, caller) {
      if (url.pathname.startsWith('/v1/db/')) {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        return instanceOf(body.ns).handle(Object.assign(req, { _body: body }), url, caller);
      }
      return instances.get(defaultId)!.handle(req, url, caller);
    },
    async socket(live, msg) {
      if (msg.t === 'unlisten') {
        for (const d of instances.values()) await d.socket?.(live, msg);
        return;
      }
      await instanceOf(msg.ns).socket?.(live, msg);
    },
    manage(op, b, req) {
      const origin = req ? new URL(req.url).origin : ctx.origin;
      switch (op) {
        case 'listDbs':
          return { instances: [...instances.keys()].map((id) => info(id, origin)) };
        case 'createDb': {
          const id = typeof b.id === 'string' ? b.id : defaultId;
          if (id === defaultId) return info(id, origin);
          if (!INSTANCE.test(id)) throw new IceBaseError('invalid-argument', `createDb('${id}'): an instance id is 6–63 characters of a-z, 0-9 and -`);
          if (instances.has(id)) throw new IceBaseError('already-exists', `Realtime Database instance '${id}' already exists`);
          open(id);
          if (listFile) writeFileSync(listFile, JSON.stringify([...instances.keys()].filter((k) => k !== defaultId)));
          return info(id, origin);
        }
        case 'setRules': {
          const id = typeof b.instance === 'string' ? b.instance : defaultId;
          const d = instanceOf(id);
          const source = JSON.stringify(b.rules ?? { rules: {} });
          loadDatabaseRules(source); // refuse rules it cannot read
          ctx.deployedRules.set(`database:${id}`, source);
          d.reloadRules();
          return { rules: (b.rules as { rules: Record<string, unknown> } | undefined)?.rules ?? {} };
        }
      }
      throw new IceBaseError('invalid-argument', `database: no management operation '${op}'`);
    },
    async close() {
      for (const d of instances.values()) await d.close?.();
    },
  };
}
