// Functions on the IceBase server: the functions source (config.functions.source) runs in
// this process. Callables speak Firebase's callable protocol at /<project>/<region>/<name>
// (so firebase/functions works unchanged), HTTP functions get a fetch Request, Firestore
// triggers fire from the document engine's change feed, schedules run on their cron.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IceBaseFunctionRecord } from '@panth977/icebase-server/functions';
import { matchCollectionPath } from '@panth977/icebase/schema';
import { toWire } from './firestore-service.ts';
import { json, type EmulatorContext, type Service } from './server.ts';

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

// ─── the service ───────────────────────────────────────────────────────────────

export async function functionsService(ctx: EmulatorContext, log: (l: string) => void): Promise<Service> {
  let fns = new Map<string, Rec>();
  const src = ctx.config.functions?.source;
  const dir = src ? resolve(ctx.root, src) : null;

  const load = async () => {
    fns = new Map();
    if (!dir || !existsSync(dir)) return;
    const pkg = existsSync(join(dir, 'package.json')) ? (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { main?: string }) : {};
    const entry = resolve(dir, pkg.main ?? (existsSync(join(dir, 'src/index.ts')) ? 'src/index.ts' : 'index.js'));
    // The functions' own icebase apps reach this server through this variable.
    process.env.ICEBASE_EMULATOR_HOST = ctx.origin.replace(/^http:\/\//, '');
    process.env.FUNCTIONS_EMULATOR = 'true';
    if (ctx.env) process.env.ICEBASE_ENV = ctx.env;
    const { importTs } = await import('../cli/load.ts');
    const mod = (await importTs(`${pathToFileURL(entry).href}?v=${Date.now()}`)) as Record<string, { __icebase?: Rec }>;
    ctx.functionExports = mod;
    for (const [name, v] of Object.entries(mod)) if (v && (typeof v === 'object' || typeof v === 'function') && v.__icebase) fns.set(name, v.__icebase);
    log(`functions: ${[...fns.entries()].map(([n, r]) => `${n} (${r.kind === 'document' ? `${r.event} ${r.collection.path}` : r.kind})`).join(', ') || 'none'}`);
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
        if (!m) continue;
        for (const [name, r] of fns) {
          if (r.kind !== 'document' || r.collection.path !== m.collection.path) continue;
          const kind = !c.before ? 'created' : !c.after ? 'deleted' : 'updated';
          if (r.event !== 'written' && r.event !== kind) continue;
          const event = {
            params: { ...m.params, docId: c.path.slice(c.path.lastIndexOf('/') + 1) },
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            time: new Date().toISOString(),
            data: r.event === 'created' ? toWire(c.path, c.after) : r.event === 'deleted' ? toWire(c.path, c.before) : { before: toWire(c.path, c.before), after: toWire(c.path, c.after) },
          };
          Promise.resolve(r.handler(event)).catch((e) => log(`functions: ${name} failed: ${(e as Error).stack ?? e}`));
        }
      }
    })();
  });

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

  return {
    started: () => void ready(),
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
    close() {
      unsub();
      if (timer) clearTimeout(timer);
    },
  };
}
