// Functions on the IceBase server: the functions source (config.functions.source) runs in
// this process. Callables speak Firebase's callable protocol at /<project>/<region>/<name>
// (so firebase/functions works unchanged), HTTP functions get a fetch Request, Firestore
// triggers fire from the document engine's change feed, schedules run on their cron.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { IceBaseFunctionRecord } from '@panth977/icebase-server/functions';
import { matchCollectionPath } from '@panth977/icebase/schema';
import { IceBaseError } from '@panth977/icebase/errors';
import { toWire } from './firestore-service.ts';
import { json, type EmulatorContext, type Service } from './server.ts';
import { taskTables } from './tables.ts';

type Rec = IceBaseFunctionRecord;

/** Firebase's callable error statuses. */
const STATUS: Record<string, [string, number]> = {
  ok: ['OK', 200], cancelled: ['CANCELLED', 499], unknown: ['UNKNOWN', 500], 'invalid-argument': ['INVALID_ARGUMENT', 400], 'deadline-exceeded': ['DEADLINE_EXCEEDED', 504], 'not-found': ['NOT_FOUND', 404], 'already-exists': ['ALREADY_EXISTS', 409], 'permission-denied': ['PERMISSION_DENIED', 403], unauthenticated: ['UNAUTHENTICATED', 401], 'resource-exhausted': ['RESOURCE_EXHAUSTED', 429], 'failed-precondition': ['FAILED_PRECONDITION', 400], aborted: ['ABORTED', 409], 'out-of-range': ['OUT_OF_RANGE', 400], unimplemented: ['UNIMPLEMENTED', 501], internal: ['INTERNAL', 500], unavailable: ['UNAVAILABLE', 503], 'data-loss': ['DATA_LOSS', 500],
};

// ─── cron ──────────────────────────────────────────────────────────────────────

function field(spec: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of spec.split(',')) {
    const [range, stepS] = part.split('/') as [string, string | undefined];
    const step = stepS ? Number(stepS) : 1;
    const [a, b] = range === '*' ? [min, max] : range.includes('-') ? range.split('-').map(Number) : [Number(range), stepS ? max : Number(range)];
    for (let v = a!; v <= b!; v += step) out.add(v);
  }
  return out;
}

/** "m h dom mon dow" or App Engine's "every N minutes|hours". */
export function cronMatcher(schedule: string): (d: Date) => boolean {
  const every = /^every (\d+) (minute|minutes|hour|hours)$/i.exec(schedule.trim());
  if (every) {
    const n = Number(every[1]);
    return every[2]!.startsWith('hour') ? (d) => d.getMinutes() === 0 && d.getHours() % n === 0 : (d) => (d.getHours() * 60 + d.getMinutes()) % n === 0;
  }
  const [mi, h, dom, mon, dow] = schedule.trim().split(/\s+/);
  if (!dow) return () => false;
  const M = field(mi!, 0, 59);
  const H = field(h!, 0, 23);
  const D = field(dom!, 1, 31);
  const Mo = field(mon!, 1, 12);
  const W = field(dow!.replace('7', '0'), 0, 6);
  return (d) => M.has(d.getMinutes()) && H.has(d.getHours()) && D.has(d.getDate()) && Mo.has(d.getMonth() + 1) && W.has(d.getDay());
}

/** 'boards/{boardId}/tickets/{ticketId}' against a document path → its params, or null. */
function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/');
  const s = path.split('/');
  if (p.length !== s.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    const m = /^\{([^}=]+)\}$/.exec(p[i]!);
    if (m) params[m[1]!] = s[i]!;
    else if (p[i] !== s[i]) return null;
  }
  return params;
}

// ─── the service ───────────────────────────────────────────────────────────────

export async function functionsService(ctx: EmulatorContext, log: (l: string) => void): Promise<Service> {
  let fns = new Map<string, Rec>();
  const src = ctx.config.functions?.source;
  const dir = src ? resolve(ctx.root, src) : null;

  let loads = 0;
  const load = async () => {
    fns = new Map();
    if (!dir || !existsSync(dir)) return;
    const pkg = existsSync(join(dir, 'package.json')) ? (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { main?: string }) : {};
    const entry = resolve(dir, pkg.main ?? (existsSync(join(dir, 'src/index.ts')) ? 'src/index.ts' : 'index.js'));
    // The functions' own icebase apps reach this server through this variable.
    process.env.ICEBASE_EMULATOR_HOST = ctx.origin.replace(/^http:\/\//, '');
    // A development server says so, as Firebase's emulator does; a signed one (icebase serve) is production.
    if (!ctx.signingKey) process.env.FUNCTIONS_EMULATOR = 'true';
    // What Cloud Functions provides: the project, its default bucket and database (storage and database triggers read them).
    const fb = ctx.config.firebase;
    process.env.GCLOUD_PROJECT ??= ctx.projectId;
    process.env.FIREBASE_CONFIG ??= JSON.stringify({ projectId: ctx.projectId, storageBucket: fb?.storageBucket ?? `${ctx.projectId}.appspot.com`, databaseURL: fb?.databaseURL ?? `https://${ctx.projectId}-default-rtdb.firebaseio.com` });
    if (ctx.env) process.env.ICEBASE_ENV = ctx.env;
    // Built JavaScript loads with Node's own import(): one module graph, as Cloud Functions loads it
    // (code that registers handlers from require()d modules sees the same instances). TypeScript
    // sources go through tsx, fresh on every reload.
    let mod: Record<string, { __icebase?: Rec }>;
    if (/\.(m?js|cjs)$/.test(entry)) mod = (await import(`${pathToFileURL(entry).href}${loads++ ? `?v=${loads}` : ''}`)) as typeof mod;
    else {
      const { importTs } = await import('../cli/load.ts');
      mod = (await importTs(`${pathToFileURL(entry).href}?v=${Date.now()}`)) as typeof mod;
    }
    ctx.functionExports = mod;
    for (const [name, v] of Object.entries(mod)) if (v && (typeof v === 'object' || typeof v === 'function') && v.__icebase) fns.set(name, v.__icebase);
    log(`functions: ${[...fns.entries()].map(([n, r]) => `${n} (${r.kind === 'document' ? `${r.event} ${r.collection ? r.collection.path : r.pattern}` : 'event' in r ? `${r.kind} ${r.event}` : r.kind})`).join(', ') || 'none'}`);
  };
  // Loaded once the server listens (functions need its address), and again on `icebase dev` reloads.
  let loading: Promise<void> | null = null;
  const ready = () => (loading ??= load().catch((e) => log(`functions: failed to load: ${(e as Error).stack ?? e}`)));

  // Firestore triggers, from the change feed.
  const unsub = ctx.firestore.onChanges((changes) => {
    void (async () => {
      await ready();
      for (const c of changes) {
        const m = matchCollectionPath(ctx.config.schema, c.parent);
        for (const [name, r] of fns) {
          if (r.kind !== 'document') continue;
          let params: Record<string, string> | null;
          if (r.collection) params = m && r.collection.path === m.collection.path ? { ...m.params, docId: c.path.slice(c.path.lastIndexOf('/') + 1) } : null;
          else params = matchPattern(r.pattern, c.path);
          if (!params) continue;
          const kind = !c.before ? 'created' : !c.after ? 'deleted' : 'updated';
          if (r.event !== 'written' && r.event !== kind) continue;
          const event = {
            params,
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            time: new Date().toISOString(),
            data: r.event === 'created' ? toWire(c.path, c.after) : r.event === 'deleted' ? toWire(c.path, c.before) : { before: toWire(c.path, c.before), after: toWire(c.path, c.after) },
          };
          Promise.resolve(r.handler(event)).catch((e) => log(`functions: ${name} failed: ${(e as Error).stack ?? e}`));
        }
      }
    })();
  });

  const fail = (name: string) => (e: unknown) => log(`functions: ${name} failed: ${(e as Error).stack ?? e}`);
  const eventId = () => randomUUID();

  // Storage triggers (onObjectFinalized …).
  ctx.hooks.storage.push(({ event, object }) => {
    void (async () => {
      await ready();
      for (const [name, r] of fns) {
        if (r.kind !== 'storage' || r.event !== event) continue;
        if (r.bucket && r.bucket !== object.bucket) continue;
        const e = {
          specversion: '1.0',
          id: eventId(),
          source: `//storage.googleapis.com/projects/_/buckets/${object.bucket}`,
          type: `google.cloud.storage.object.v1.${event}`,
          time: new Date().toISOString(),
          subject: `objects/${object.name}`,
          bucket: object.bucket,
          data: object,
        };
        Promise.resolve(r.handler(e as never)).catch(fail(name));
      }
    })();
  });

  // Realtime Database triggers (onValueWritten …): every location a pattern names that the write changed.
  ctx.hooks.database.push(({ paths, before, after }) => {
    void (async () => {
      await ready();
      const rs = [...fns].filter(([, r]) => r.kind === 'database') as [string, Extract<Rec, { kind: 'database' }>][];
      if (!rs.length) return;
      const keys = (v: unknown) => (v && typeof v === 'object' ? Object.keys(v) : []);
      for (const [name, r] of rs) {
        const pat = r.ref.split('/').filter(Boolean);
        const hits = new Map<string, Record<string, string>>();
        for (const p of paths) {
          const segs = p.split('/').filter(Boolean);
          // Walk the pattern along the written path, then into the data below it.
          const walk = (i: number, at: string[], params: Record<string, string>) => {
            if (i === pat.length) return void hits.set(at.join('/'), params);
            const want = pat[i]!;
            const m = /^\{([^}]+)\}$/.exec(want);
            if (i < segs.length) {
              if (m) walk(i + 1, [...at, segs[i]!], { ...params, [m[1]!]: segs[i]! });
              else if (want === segs[i]) walk(i + 1, [...at, want], params);
              return;
            }
            const here = at.join('/');
            const children = m ? [...new Set([...keys(before(here)), ...keys(after(here))])] : [want];
            for (const k of children) walk(i + 1, [...at, k], m ? { ...params, [m[1]!]: k } : params);
          };
          walk(0, [], {});
        }
        for (const [loc, params] of hits) {
          const b = before(loc);
          const a = after(loc);
          const had = b !== null && b !== undefined;
          const has = a !== null && a !== undefined;
          if (JSON.stringify(b ?? null) === JSON.stringify(a ?? null)) continue;
          const kind = !had ? 'created' : !has ? 'deleted' : 'updated';
          if (r.event !== 'written' && r.event !== kind) continue;
          const snap = (v: unknown) => ({ key: loc.split('/').pop() ?? null, exists: () => v !== null && v !== undefined, val: () => (v === undefined ? null : v) });
          const data = r.event === 'created' ? snap(a) : r.event === 'deleted' ? snap(b) : { before: snap(b), after: snap(a) };
          Promise.resolve(r.handler({ params, id: eventId(), time: new Date().toISOString(), data })).catch(fail(name));
        }
      }
    })();
  });

  // Auth: created / deleted events, and the blocking functions.
  ctx.hooks.auth.push(({ event, user }) => {
    void (async () => {
      await ready();
      for (const [name, r] of fns) if (r.kind === 'auth' && r.event === event) Promise.resolve(r.handler(user)).catch(fail(name));
    })();
  });
  const blocking = (event: 'beforeCreate' | 'beforeSignIn') => async (user: Record<string, unknown>, how: string) => {
    await ready();
    const fn = [...fns.values()].find((r) => r.kind === 'auth' && r.event === event) as Extract<Rec, { kind: 'auth' }> | undefined;
    if (!fn) return;
    const provider = { password: 'password', emailLink: 'password', anonymous: 'anonymous', phone: 'phone', custom: 'custom' }[how] ?? how;
    return (await fn.handler({
      data: user,
      eventId: eventId(),
      eventType: `providers/cloud.auth/eventTypes/user.${event}:${provider}`,
      authType: 'USER',
      resource: { service: 'identitytoolkit.googleapis.com', name: `projects/${ctx.projectId}` },
      timestamp: new Date().toUTCString(),
      locale: 'en',
      ipAddress: '127.0.0.1',
      userAgent: 'icebase',
      additionalUserInfo: { providerId: provider, isNewUser: event === 'beforeCreate' },
      params: {},
    })) as Record<string, unknown> | void;
  };
  ctx.hooks.beforeCreate = blocking('beforeCreate');
  ctx.hooks.beforeSignIn = blocking('beforeSignIn');

  // Task queues (onTaskDispatched): durable in the data directory, retried with backoff.
  const tq = await ctx.stores.open('tasks');
  await taskTables(tq);
  const enqueue = async (fn: string, data: unknown, o: { id?: string; scheduleDelaySeconds?: number; scheduleTime?: string }) => {
    const at = o.scheduleTime ? Date.parse(o.scheduleTime) : Date.now() + (o.scheduleDelaySeconds ?? 0) * 1000;
    const id = o.id ?? randomUUID();
    try {
      await tq.run(`INSERT INTO tasks (id, fn, data, run_at, scheduled) VALUES (?, ?, ?, ?, ?)`, id, fn, JSON.stringify(data ?? null), at, new Date(at).toISOString());
    } catch (e) {
      if (/UNIQUE/.test(String(e))) throw Object.assign(new Error(`A task with id ${id} already exists`), { code: 'functions/task-already-exists' });
      throw e;
    }
    kick();
    return id;
  };
  let busy = false;
  let wake: ReturnType<typeof setTimeout> | null = null;
  const kick = () => {
    if (wake) clearTimeout(wake);
    wake = setTimeout(() => void dispatch(), 0);
  };
  const dispatch = async () => {
    if (busy) return;
    busy = true;
    try {
      await ready();
      for (;;) {
        const t = (await tq.get(`SELECT * FROM tasks WHERE run_at <= ? ORDER BY run_at LIMIT 1`, Date.now())) as { id: string; fn: string; data: string; attempts: number; scheduled: string } | undefined;
        if (!t) break;
        const r = fns.get(t.fn);
        if (r?.kind !== 'task') {
          log(`functions: task for ${t.fn}, which is not a task queue function — dropped`);
          await tq.run(`DELETE FROM tasks WHERE id = ?`, t.id);
          continue;
        }
        try {
          await r.handler({ data: JSON.parse(t.data), queueName: t.fn, id: t.id, retryCount: t.attempts, executionCount: t.attempts, scheduledTime: t.scheduled, previousResponse: undefined, retryReason: undefined, headers: {} } as never);
          await tq.run(`DELETE FROM tasks WHERE id = ?`, t.id);
        } catch (e) {
          const n = t.attempts + 1;
          if (n >= r.retry.maxAttempts) {
            fail(t.fn)(e);
            log(`functions: task ${t.id} for ${t.fn} gave up after ${n} attempt(s)`);
            await tq.run(`DELETE FROM tasks WHERE id = ?`, t.id);
          } else {
            const backoff = Math.min(r.retry.minBackoffSeconds * 2 ** (n - 1), r.retry.maxBackoffSeconds) * 1000;
            await tq.run(`UPDATE tasks SET attempts = ?, run_at = ? WHERE id = ?`, n, Date.now() + backoff, t.id);
          }
        }
      }
    } finally {
      busy = false;
      const next = (await tq.get(`SELECT MIN(run_at) at FROM tasks`).catch(() => undefined)) as { at: number | null } | undefined;
      if (next && next.at !== null) {
        if (wake) clearTimeout(wake);
        wake = setTimeout(() => void dispatch(), Math.max(0, Math.min(next.at - Date.now(), 60_000)));
      }
    }
  };

  // Schedules: check once a minute, on the minute.
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tick = () => {
    const now = new Date();
    for (const [name, r] of fns) {
      if (r.kind === 'schedule' && cronMatcher(r.schedule)(now)) Promise.resolve(r.handler()).catch((e) => log(`functions: ${name} failed: ${(e as Error).stack ?? e}`));
    }
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000));
  };
  timer = setTimeout(tick, 60_000 - (Date.now() % 60_000));

  // What a function is, for the console: its kind and what triggers it.
  const describeFn = (name: string, r: Rec) => ({
    name,
    kind: r.kind,
    trigger:
      r.kind === 'schedule' ? r.schedule
      : r.kind === 'document' ? `${r.event} ${r.collection ? r.collection.path : r.pattern}`
      : r.kind === 'database' ? `${r.event} ${r.ref}`
      : r.kind === 'storage' ? `${r.event}${r.bucket ? ` ${r.bucket}` : ''}`
      : r.kind === 'auth' ? r.event
      : r.kind === 'task' ? `queue (max ${r.retry.maxAttempts} attempts)`
      : r.kind === 'call' ? 'callable'
      : 'https',
  });
  return {
    started: () => void ready().then(() => kick()),
    async manage(op, b) {
      await ready();
      switch (op) {
        case 'list':
          return { functions: [...fns].map(([n, r]) => describeFn(n, r)) };
        case 'run': {
          const r = fns.get(String(b.name ?? ''));
          if (r?.kind !== 'schedule') throw new IceBaseError('not-found', `no scheduled function ${String(b.name)}`);
          const t = Date.now();
          await r.handler();
          return { ok: true, ms: Date.now() - t };
        }
        case 'tasks':
          return { tasks: await tq.all(`SELECT id, fn, run_at, attempts FROM tasks ORDER BY run_at LIMIT 500`) };
      }
      throw new IceBaseError('invalid-argument', `functions: no management operation '${op}'`);
    },
    async handle(req, url, caller) {
      const m = /^\/([^/]+)\/([a-z]+-[a-z]+\d+)\/([A-Za-z0-9_-]+)(\/.*)?$/.exec(url.pathname);
      if (!m) {
        if (url.pathname === '/__/icebase/functions/run' && caller.admin) {
          // Run a scheduled function now (console, tests).
          await ready();
          const name = url.searchParams.get('name') ?? '';
          const r = fns.get(name);
          if (r?.kind !== 'schedule') return json({ error: { code: 'not-found', message: `no scheduled function ${name}` } }, 404);
          await r.handler();
          return json({ ok: true });
        }
        if (url.pathname === '/__/icebase/tasks/enqueue') {
          if (!caller.admin) return json({ error: { code: 'permission-denied', message: 'enqueue is admin only' } }, 403);
          const b = (await req.json().catch(() => ({}))) as { name?: string; data?: unknown; id?: string; scheduleDelaySeconds?: number; scheduleTime?: string };
          if (!b.name) return json({ error: { code: 'invalid-argument', message: 'name' } }, 400);
          try {
            return json({ id: await enqueue(b.name, b.data, b) });
          } catch (e) {
            return json({ error: { code: 'already-exists', message: (e as Error).message } }, 409);
          }
        }
        if (url.pathname === '/__/icebase/tasks' && caller.admin) {
          return json({ tasks: await tq.all(`SELECT id, fn, run_at, attempts FROM tasks ORDER BY run_at`) });
        }
        if (url.pathname === '/__/icebase/functions/reload' && caller.admin) {
          loading = null;
          await ready();
          return json({ functions: [...fns.keys()] });
        }
        return null;
      }
      await ready();
      const r = fns.get(m[3]!);
      if (!r) return null;
      if (r.kind === 'request') {
        // The function sees its own path, like Cloud Functions.
        const inner = new URL(req.url);
        inner.pathname = m[4] ?? '/';
        return r.handler(new Request(inner, req));
      }
      if (r.kind !== 'call') return null;
      if (req.method !== 'POST') return json({ error: { status: 'INVALID_ARGUMENT', message: 'Request has invalid method. GET' } }, 400);
      const body = (await req.json().catch(() => ({}))) as { data?: unknown };
      try {
        const result = await r.handler({ data: body.data ?? null, ...(caller.auth ? { auth: { uid: caller.auth.uid, token: caller.auth.token as never, rawToken: '' } } : {}), rawRequest: req as never, acceptsStreaming: false } as never);
        return json({ result: result === undefined ? null : result });
      } catch (e) {
        const err = e as { code?: string; message?: string; details?: unknown; httpErrorCode?: { status: number } };
        const [status, http] = STATUS[err.code ?? ''] ?? ['INTERNAL', 500];
        if (status === 'INTERNAL') log(`functions: ${m[3]} threw: ${(e as Error).stack ?? e}`);
        return json({ error: { status, message: status === 'INTERNAL' && !err.code ? 'INTERNAL' : (err.message ?? status), ...(err.details !== undefined ? { details: err.details } : {}) } }, http);
      }
    },
    async close() {
      unsub();
      if (timer) clearTimeout(timer);
      if (wake) clearTimeout(wake);
      await tq.close();
    },
  };
}
