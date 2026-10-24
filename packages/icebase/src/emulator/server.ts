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

import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AnyConfig } from '../config.js';
import { IceBaseError } from '../errors.js';
import { nodeListener } from '../internal/node-http.js';
import { FirestoreEngine } from './firestore-engine.js';

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
}

export interface RunningEmulator {
  url: string;
  port: number;
  context: EmulatorContext;
  close(): Promise<void>;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
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

export async function startEmulator(opts: EmulatorOptions): Promise<RunningEmulator> {
  const config = opts.config;
  const root = resolve(opts.root ?? process.cwd());
  const memory = opts.dataDir === ':memory:';
  const dataDir = memory ? ':memory:' : resolve(root, opts.dataDir ?? config.emulator?.dataDir ?? '.icebase');
  if (!memory) mkdirSync(dataDir, { recursive: true });
  const log = opts.log ?? ((l: string) => console.log(l));
  const projectId = config.firebase?.projectId ?? `demo-${config.name}`;

  const firestore = new FirestoreEngine({ file: memory ? ':memory:' : join(dataDir, 'firestore.sqlite'), schema: config.schema });
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
    // Until the auth service is up, only the owner token is understood.
    verify: async (token) => ({ admin: token === 'owner', auth: null }),
  };

  const without = new Set(opts.without ?? []);
  const { firestoreService } = await import('./firestore-service.js');
  services.set('firestore', await firestoreService(ctx));
  const optional: [string, () => Promise<Service>][] = [
    ['auth', async () => (await import('./auth-service.js')).authService(ctx)],
    ['database', async () => (await import('./database-service.js')).databaseService(ctx)],
    ['storage', async () => (await import('./storage-service.js')).storageService(ctx)],
    ['functions', async () => (await import('./functions-service.js')).functionsService(ctx, log)],
    ['customAuth', async () => (await import('./custom-auth-service.js')).customAuthService(ctx)],
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

  const handler = async (req: Request): Promise<Response> => {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const url = new URL(req.url);
    try {
      if (url.pathname === '/__/icebase/health') return json({ ok: true, project: projectId, services: [...services.keys()], documents: firestore.count() });
      const authz = req.headers.get('authorization');
      const caller = await ctx.verify(authz ? authz.replace(/^(Bearer|Firebase)\s+/i, '') : null);
      for (const s of services.values()) {
        const r = await s.handle(req, url, caller);
        if (r) {
          const h = new Headers(r.headers);
          for (const [k, v] of Object.entries(CORS)) if (!h.has(k)) h.set(k, v);
          return new Response(r.body, { status: r.status, statusText: r.statusText, headers: h });
        }
      }
      return json({ error: { code: 'not-found', message: `No route ${req.method} ${url.pathname}` } }, 404, CORS);
    } catch (e) {
      const r = errorResponse(e);
      for (const [k, v] of Object.entries(CORS)) r.headers.set(k, v);
      return r;
    }
  };

  const server: Server = createServer(nodeListener(handler));
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/v1/rt')) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  wss.on('connection', (ws: WebSocket) => {
    const closers: (() => void)[] = [];
    const live: Live = {
      caller: { admin: false, auth: null },
      send: (m) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)),
      onClose: (fn) => void closers.push(fn),
    };
    ws.on('message', (raw) => {
      void (async () => {
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
          live.send({ t: 'error', s: msg.s, id: msg.id, error: err });
        }
      })();
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
