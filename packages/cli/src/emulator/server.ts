// The IceBase server, emulator mode: one port, every service. Routes are fetch handlers
// (Request → Response); realtime goes over one WebSocket at /v1/rt.
//
//   /v1/fs/*                    Firestore (IceBase protocol, used by the emulator driver)
//   /v1/db/*                    Realtime Database
//   /identitytoolkit…, /securetoken…, /emulator/v1/…   Auth (the Firebase Auth emulator's REST API)
//   /v0/b/…, /storage/v1/…, /upload/storage/v1/…       Storage (Firebase + GCS REST APIs)
//   /<project>/<region>/<fn>    Functions (callable + HTTP)
//   /__/icebase/auth/*          custom auth
//   /__/icebase/health          health

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AnyConfig } from '@panth977/icebase/config';
import { IceBaseError } from '@panth977/icebase/errors';
import { registerEmbedded } from '@panth977/icebase/app';
import { nodeListener } from '@panth977/icebase-server/internal';
import { initializeAdminApp } from '@panth977/icebase-server/admin';
import { FirestoreEngine } from './firestore-engine.ts';

/** Who is calling: the owner (admin SDKs, the console) or a signed-in user (or nobody). */
export interface Caller {
  admin: boolean;
  /** Decoded ID token claims, for rules' request.auth. */
  auth: { uid: string; token: Record<string, unknown> } | null;
}

export interface Service {
  /** Return a Response, or null when the route is not this service's. */
  handle(req: Request, url: URL, caller: Caller): Promise<Response | null> | Response | null;
  /** A WebSocket message for this service ({ s: name, … }). */
  socket?(ws: Live, msg: Record<string, unknown>): void | Promise<void>;
  /** The management API (icebase/manage in emulator mode): POST /__/icebase/admin/manage/<service>/<op>, admin only. */
  manage?(op: string, body: Record<string, unknown>, req?: Request): Promise<unknown> | unknown;
  /** Called once the server listens and ctx.origin is known. */
  started?(): void;
  close?(): void | Promise<void>;
}

/** One WebSocket client. */
export interface Live {
  caller: Caller;
  send(msg: unknown): void;
  /** Teardown for listeners this socket holds, run when it closes. */
  onClose(fn: () => void): void;
}

export interface EmulatorContext {
  config: AnyConfig;
  root: string;
  dataDir: string;
  projectId: string;
  /** ICEBASE_ENV for the functions this server runs. */
  env: string | undefined;
  origin: string;
  /** Resolve an Authorization header (filled in by the auth service). */
  verify(token: string | null): Promise<Caller>;
  services: Map<string, Service>;
  firestore: FirestoreEngine;
  /** The functions source's exports, once loaded (custom auth's 'handler' senders live there). */
  functionExports: Record<string, unknown>;
  /** The token that makes a caller an admin. */
  adminToken: string;
  /** Events between services: storage / database / auth changes, and auth's blocking functions. */
  hooks: EmulatorHooks;
  /** Set when the server signs its tokens (signTokens): the HMAC key. */
  signingKey: Buffer | null;
  /** config.hosting is served on the same port (`icebase serve`). */
  hosting: boolean;
  /**
   * Rules released with the management API ('firestore:<db>', 'storage:<bucket>', 'database'):
   * they replace the config's rules files until the server restarts.
   */
  deployedRules: Map<string, string>;
}

/** A stored object as Cloud Functions' storage events carry it. */
export type StorageObjectEvent = Record<string, unknown> & { name: string; bucket: string };
/** A user as auth events carry it (firebase-admin's UserRecord shape). */
export type AuthUserEvent = Record<string, unknown> & { uid: string };

export interface EmulatorHooks {
  storage: ((e: { event: 'finalized' | 'deleted' | 'metadataUpdated'; object: StorageObjectEvent }) => void)[];
  /** The paths a write touched, and the whole tree before and after it. */
  database: ((e: { paths: string[]; before: (path: string) => unknown; after: (path: string) => unknown }) => void)[];
  auth: ((e: { event: 'created' | 'deleted'; user: AuthUserEvent }) => void)[];
  /** Blocking functions: may refuse (throw) or return changes to the user / its token. */
  beforeCreate: ((user: AuthUserEvent, how: string) => Promise<Record<string, unknown> | void>) | null;
  beforeSignIn: ((user: AuthUserEvent, how: string) => Promise<Record<string, unknown> | void>) | null;
}

export interface EmulatorOptions {
  config: AnyConfig;
  /** The environment the functions run as (ICEBASE_ENV), e.g. 'local'. */
  env?: string;
  /** The project directory (rules files, functions source are relative to it). */
  root?: string;
  port?: number;
  host?: string;
  /** ':memory:' keeps nothing on disk (tests). Default: config.emulator.dataDir or .icebase */
  dataDir?: string;
  /** Services to leave out (all on by default). */
  without?: string[];
  log?: (line: string) => void;
  /**
   * false: no port — the server runs in this process only, for admin apps initialized with
   * { emulator: { embedded: name } } (a backend that keeps its data with IceBase, say).
   */
  listen?: boolean;
  /** The name an embedded server is reached by (default config.name). */
  name?: string;
  /**
   * The token that makes a caller an admin (rules skipped). Default ICEBASE_ADMIN_TOKEN, else
   * 'owner' — fine on a developer machine, never on a server others can reach.
   */
  adminToken?: string;
  /**
   * Sign ID tokens (HMAC, key kept in the data directory) and refuse unsigned ones — for a server
   * others can reach (a VM). Off by default: like Firebase's emulator, tokens are unsigned.
   */
  signTokens?: boolean;
  /**
   * Serve config.hosting on the same port (`icebase serve`): a request no service takes goes to
   * hosting, whose function rewrites run in this process. 'production' also caches, compresses
   * and sets long cache headers on hashed assets.
   */
  hosting?: boolean | 'production';
  /** Learning mode: a query whose index is not declared is reported here and answered (never in production). */
  learnIndexes?: (missing: { collection: string; suggestion: string }) => void;
}

export interface RunningEmulator {
  url: string;
  /** 0 for an embedded server. */
  port: number;
  /** The server as a fetch handler. */
  handler: (req: Request) => Promise<Response>;
  context: EmulatorContext;
  close(): Promise<void>;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const STATUS: Record<string, number> = { 'invalid-argument': 400, 'failed-precondition': 400, 'out-of-range': 400, unauthenticated: 401, 'permission-denied': 403, 'not-found': 404, 'already-exists': 409, aborted: 409, 'resource-exhausted': 429, unimplemented: 501, unavailable: 503, 'deadline-exceeded': 504 };

export function errorResponse(e: unknown): Response {
  if (e instanceof IceBaseError) return json({ error: { code: e.code, message: e.message, details: { ...e.details, cause: undefined } } }, STATUS[e.code] ?? 500);
  console.error('[icebase emulator]', e);
  return json({ error: { code: 'internal', message: (e as Error)?.message ?? String(e) } }, 500);
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, content-type, x-goog-upload-protocol, x-goog-upload-command, x-goog-upload-offset, x-goog-upload-header-content-type, x-goog-upload-header-content-length, x-firebase-storage-version, x-firebase-gmpid, x-client-version, x-firebase-client, x-firebase-appcheck',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'access-control-expose-headers': 'x-goog-upload-url, x-goog-upload-status, x-goog-upload-chunk-granularity, x-goog-upload-control-url, x-goog-upload-size, location',
};

/** ICEBASE_LOG_ERRORS=1: every refused or failed request and listener on stderr (debugging rules and indexes). */
/** ICEBASE_LOG_REQUESTS=1: every service request too. */
const LOG_REQUESTS = !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ICEBASE_LOG_REQUESTS;
const LOG_ERRORS = !!(globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ICEBASE_LOG_ERRORS;

/** The service APIs' paths (everything else is hosting's when the server also hosts). */
const SERVICE_PATH = /^\/(v1\/(fs|db|rt)\/|v1\/rt$|v0\/b\/|identitytoolkit\.googleapis\.com\/|securetoken\.googleapis\.com\/|emulator\/|__\/icebase\/)/;

/** The signing key: random per run in memory, else made once and kept in the data directory. */
function signTokens(opts: EmulatorOptions, dataDir: string, memory: boolean): Buffer | null {
  if (!(opts.signTokens ?? opts.config.emulator?.signTokens)) return null;
  if (memory) return randomBytes(32);
  const file = join(dataDir, 'auth-signing-key');
  if (!existsSync(file)) writeFileSync(file, randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
}

export async function startEmulator(opts: EmulatorOptions): Promise<RunningEmulator> {
  const config = opts.config;
  const root = resolve(opts.root ?? process.cwd());
  const memory = opts.dataDir === ':memory:';
  const dataDir = memory ? ':memory:' : resolve(root, opts.dataDir ?? config.emulator?.dataDir ?? '.icebase');
  if (!memory) mkdirSync(dataDir, { recursive: true });
  const log = opts.log ?? ((l: string) => console.log(l));
  const projectId = config.firebase?.projectId ?? `demo-${config.name}`;
  const adminToken = opts.adminToken ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ICEBASE_ADMIN_TOKEN ?? 'owner';

  const firestore = new FirestoreEngine({ file: memory ? ':memory:' : join(dataDir, 'firestore.sqlite'), schema: config.schema, ...(opts.learnIndexes ? { learn: opts.learnIndexes } : {}) });
  const services = new Map<string, Service>();
  const ctx: EmulatorContext = {
    config,
    root,
    dataDir,
    projectId,
    env: opts.env,
    origin: '',
    services,
    firestore,
    functionExports: {},
    adminToken,
    hooks: { storage: [], database: [], auth: [], beforeCreate: null, beforeSignIn: null },
    signingKey: signTokens(opts, dataDir, memory),
    hosting: !!opts.hosting,
    deployedRules: new Map(),
    // Until the auth service is up, only the admin token is understood.
    verify: async (token) => ({ admin: token === adminToken, auth: null }),
  };

  const without = new Set(opts.without ?? []);
  const { firestoreService } = await import('./firestore-service.ts');
  services.set('firestore', await firestoreService(ctx));
  const optional: [string, () => Promise<Service>][] = [
    ['auth', async () => (await import('./auth-service.ts')).authService(ctx)],
    ['database', async () => (await import('./database-service.ts')).databaseService(ctx)],
    ['storage', async () => (await import('./storage-service.ts')).storageService(ctx)],
    ['functions', async () => (await import('./functions-service.ts')).functionsService(ctx, log)],
    ['customAuth', async () => (await import('./custom-auth-service.ts')).customAuthService(ctx)],
    ['messaging', async () => (await import('./messaging-service.ts')).messagingService(ctx)],
  ];
  for (const [name, make] of optional) {
    if (without.has(name)) continue;
    try {
      services.set(name, await make());
    } catch (e) {
      if ((e as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' && /emulator\/[a-z-]+-service/.test((e as Error).message)) continue; // not built yet
      throw e;
    }
  }

  // Hosting's management API (sites, releases, domains) — served when this server also hosts.
  const { hostingSites } = await import('./hosting-sites.ts');
  const hostingManage = hostingSites(ctx);
  let hosting: ((req: Request) => Promise<Response>) | null = null;
  if (opts.hosting) {
    if (!config.hosting) throw new IceBaseError('failed-precondition', 'hosting: icebase.config has no hosting section');
    const { hostingHandler } = await import('./hosting.ts');
    const handlers = new Map<string, (req: Request) => Promise<Response>>();
    const handlerFor = (publicDir: string | null) => {
      let hd = handlers.get(publicDir ?? '');
      if (!hd) handlers.set(publicDir ?? '', (hd = makeHosting(publicDir)));
      return hd;
    };
    hosting = async (req) => {
      const at = hostingManage.dirFor(new URL(req.url).hostname);
      if (at === 'none') return new Response('This site has nothing released yet', { status: 404 });
      return handlerFor(at.dir)(req);
    };
    const makeHosting = (publicDir: string | null) => hostingHandler({
      ...(publicDir ? { publicDir } : {}),
      config,
      root,
      production: opts.hosting === 'production',
      // A function rewrite: the functions service, in this process.
      callFunction: async (req, fn, region, pathAndQuery) => {
        const inner = new Request(`${new URL(req.url).origin}/${projectId}/${region}/${fn}${pathAndQuery}`, {
          method: req.method,
          headers: req.headers,
          signal: req.signal,
          ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: await req.arrayBuffer() } : {}),
        });
        const svc = services.get('functions');
        const caller = await ctx.verify(null);
        return (await svc?.handle(inner, new URL(inner.url), caller)) ?? json({ error: { code: 'not-found', message: `no function ${fn}` } }, 404);
      },
    });
  }

  // The console, acting as an admin app of this server.
  const { consoleHandler } = await import('../console/index.ts');
  const consoleRoute = consoleHandler(
    '/__/icebase/console',
    () => {
      const env = opts.env ?? Object.keys(config.environments)[0]!;
      return {
        config: ctx.config,
        env,
        siteOrigin: ctx.origin,
        app: initializeAdminApp(ctx.config, env, { name: `icebase-console-${Date.now()}`, emulator: { origin: ctx.origin, adminToken } }),
        server: {
          manage: async (svc, op, body) => {
            const s = services.get(svc) ?? (svc === 'hosting' ? hostingManage : undefined);
            if (!s?.manage) throw new IceBaseError('not-found', `no ${svc} service on this server`);
            return s.manage(op, body);
          },
          health: () => ({ ok: true, project: projectId, services: [...services.keys()], documents: firestore.count() }),
          rules: (svc) => {
            if (svc === 'firestore') return ctx.deployedRules.get('firestore:(default)') ?? (config.rules?.firestore ? readFileSync(resolve(root, config.rules.firestore), 'utf8') : null);
            if (svc === 'storage') return ctx.deployedRules.get(`storage:${config.firebase?.storageBucket ?? `${projectId}.appspot.com`}`) ?? (config.rules?.storage ? readFileSync(resolve(root, config.rules.storage), 'utf8') : null);
            return ctx.deployedRules.get(`database:${projectId}-default-rtdb`) ?? (config.rules?.database ? readFileSync(resolve(root, config.rules.database), 'utf8') : null);
          },
        },
      };
    },
    // The admin token, or ICEBASE_CONSOLE_TOKEN: a token for the console only, set by whoever runs
    // the server (the same name the console's Cloud Function uses).
    async (req) => {
      const a = req.headers.get('authorization');
      const token = a ? a.replace(/^(Bearer|Firebase)\s+/i, '') : null;
      const consoleToken = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ICEBASE_CONSOLE_TOKEN;
      if (token && consoleToken && token.length === consoleToken.length && timingSafeEqual(Buffer.from(token), Buffer.from(consoleToken))) return true;
      return (await ctx.verify(token)).admin;
    },
  );

  const handler = async (req: Request): Promise<Response> => {
    // The console (/__/icebase/console): the page for anyone, its API for the admin. Same origin
    // only: a console manages the deployment serving it and knows of no other (no CORS).
    if (new URL(req.url).pathname.startsWith('/__/icebase/console')) {
      try {
        const r = await consoleRoute(req);
        if (r) return r;
      } catch (e) {
        return errorResponse(e);
      }
    }
    // Preflight for the service APIs; with hosting, anything else is the app's (a function may answer it).
    if (req.method === 'OPTIONS' && (!hosting || SERVICE_PATH.test(new URL(req.url).pathname))) return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/__/icebase/health') return json({ ok: true, project: projectId, services: [...services.keys()], documents: firestore.count() });
      const authz = req.headers.get('authorization');
      const caller = await ctx.verify(authz ? authz.replace(/^(Bearer|Firebase)\s+/i, '') : null);
      const mg = /^\/__\/icebase\/admin\/manage\/([a-zA-Z]+)\/([a-zA-Z]+)$/.exec(url.pathname);
      if (mg && req.method === 'POST') {
        if (!caller.admin) throw new IceBaseError('permission-denied', 'the management API is the admin\'s');
        const svc = services.get(mg[1]!) ?? (mg[1] === 'hosting' ? hostingManage : undefined);
        if (!svc?.manage) throw new IceBaseError('not-found', `no management API for '${mg[1]}' on this server`);
        return json((await svc.manage(mg[2]!, ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>, req)) ?? {}, 200, CORS);
      }
      for (const s of services.values()) {
        const r = await s.handle(req, url, caller);
        if (r && LOG_ERRORS && r.status >= 400) console.error(`[icebase] failed: ${req.method} ${url.pathname} → ${r.status}`);
        else if (r && LOG_REQUESTS) console.error(`[icebase] ${req.method} ${url.pathname}${url.search.length > 1 ? url.search.slice(0, 120) : ''} → ${r.status}`);
        if (r) {
          const h = new Headers(r.headers);
          for (const [k, v] of Object.entries(CORS)) if (!h.has(k)) h.set(k, v);
          return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
        }
      }
      if (hosting) return await hosting(req);
      return json({ error: { code: 'not-found', message: `No route ${req.method} ${url.pathname}` } }, 404, CORS);
    } catch (e) {
      const r = errorResponse(e);
      if (LOG_ERRORS) console.error(`[icebase] failed: ${req.method} ${url.pathname} → ${r.status}: ${(e as Error).message}`);
      for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
      return r;
    }
  };

  if (opts.listen === false) {
    const name = opts.name ?? config.name;
    ctx.origin = `http://embedded.icebase/${encodeURIComponent(name)}`;
    registerEmbedded(name, handler);
    for (const s of services.values()) s.started?.();
    log(`IceBase server embedded as '${name}' · ${[...services.keys()].join(', ')} · data ${memory ? 'in memory' : dataDir}`);
    return {
      url: ctx.origin,
      port: 0,
      handler,
      context: ctx,
      async close() {
        registerEmbedded(name, null);
        for (const s of services.values()) await s.close?.();
        firestore.close();
      },
    };
  }

  const server: Server = createServer(nodeListener(handler));
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const p = (req.url ?? '').split('?')[0];
    if (p !== '/v1/rt' && !(config.emulator?.socketPath && p === config.emulator.socketPath)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket) => {
    const closers: (() => void)[] = [];
    const live: Live = {
      caller: { admin: false, auth: null },
      send: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)),
      onClose: (fn) => void closers.push(fn),
    };
    // One message at a time, in order: a listen sent right after { t: 'auth' } runs as that caller.
    let chain: Promise<void> = Promise.resolve();
    ws.on('message', (raw) => {
      chain = chain.then(async () => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw)) as Record<string, unknown>;
        } catch {
          return;
        }
        try {
          if (msg.t === 'auth') {
            live.caller = await ctx.verify((msg.token as string | null) ?? null);
            live.send({ t: 'authed', id: msg.id ?? null });
            return;
          }
          const svc = services.get(({ fs: 'firestore', db: 'database' } as Record<string, string>)[String(msg.s)] ?? String(msg.s));
          if (!svc?.socket) throw new IceBaseError('not-found', `no realtime service '${String(msg.s)}'`);
          await svc.socket(live, msg);
        } catch (e) {
          const err = e instanceof IceBaseError ? { code: e.code, message: e.message, details: { ...e.details, cause: undefined } } : { code: 'internal', message: (e as Error).message };
          if (LOG_ERRORS) console.error(`[icebase] failed: socket ${String(msg.s)} ${String(msg.t)} ${JSON.stringify(msg.spec ?? msg.path ?? '').slice(0, 300)} → ${err.code}: ${err.message}`);
          live.send({ t: 'error', s: msg.s, id: msg.id, error: err });
        }
      });
    });
    ws.on('close', () => closers.splice(0).forEach((f) => f()));
  });

  const host = opts.host ?? config.emulator?.host ?? '127.0.0.1';
  await new Promise<void>((r, j) => {
    server.once('error', j);
    server.listen(opts.port ?? config.emulator?.port ?? 4400, host, r);
  });
  const port = (server.address() as AddressInfo).port;
  ctx.origin = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;
  for (const s of services.values()) s.started?.();
  log(`IceBase emulator on ${ctx.origin} · ${[...services.keys()].join(', ')} · data ${memory ? 'in memory' : dataDir}`);
  return {
    url: ctx.origin,
    port,
    handler,
    context: ctx,
    async close() {
      for (const c of wss.clients) c.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
      for (const s of services.values()) await s.close?.();
      firestore.close();
    },
  };
}

// ─── icebase serve ─────────────────────────────────────────────────────────────

export interface ServeOptions extends Omit<EmulatorOptions, 'hosting' | 'signTokens' | 'listen'> {
  /** Default PORT, else 8080. */
  port?: number;
  /** Default 0.0.0.0: a server others reach. */
  host?: string;
}

/**
 * `icebase serve`: the IceBase server for production on one port — every service, the functions,
 * and config.hosting (with its function rewrites run in this process). ID tokens are signed, and
 * the admin token is ICEBASE_ADMIN_TOKEN or one made once and kept in the data directory
 * (never 'owner'). In-process admin apps get it through ICEBASE_ADMIN_TOKEN.
 */
export async function serve(opts: ServeOptions): Promise<RunningEmulator> {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process!.env;
  const root = resolve(opts.root ?? process.cwd());
  const memory = opts.dataDir === ':memory:';
  const dataDir = memory ? ':memory:' : resolve(root, opts.dataDir ?? env.ICEBASE_DATA_DIR ?? opts.config.emulator?.dataDir ?? '.icebase');
  if (!memory) mkdirSync(dataDir, { recursive: true });
  let adminToken = opts.adminToken ?? env.ICEBASE_ADMIN_TOKEN;
  if (!adminToken) {
    if (memory) adminToken = randomBytes(24).toString('base64url');
    else {
      const file = join(dataDir, 'admin-token');
      if (!existsSync(file)) writeFileSync(file, randomBytes(24).toString('base64url'), { mode: 0o600 });
      adminToken = readFileSync(file, 'utf8').trim();
    }
  }
  if (adminToken === 'owner') throw new IceBaseError('failed-precondition', "serve: the admin token 'owner' is the emulator's well-known one; set ICEBASE_ADMIN_TOKEN to a secret");
  env.ICEBASE_ADMIN_TOKEN = adminToken;
  return startEmulator({
    ...opts,
    root,
    dataDir,
    adminToken,
    signTokens: true,
    hosting: opts.config.hosting ? 'production' : false,
    port: opts.port ?? (env.PORT ? Number(env.PORT) : 8080),
    host: opts.host ?? '0.0.0.0',
  });
}
