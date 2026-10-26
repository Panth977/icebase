// icebase/app — like firebase/app's initializeApp, but takes the IceBase config + which
// environment to run. The mode of each service comes from config.environments[env].

import { configError, IceBaseError } from './errors.ts';
import { readEnv, resolveModes, type AnyConfig, type EnvOf, type FirebaseWebConfig, type IceBaseConfig, type Mode, type Service } from './config.ts';

export interface IceBaseAppOptions {
  /** App name, like Firebase's second initializeApp argument. Default '[DEFAULT]'. */
  name?: string;
  /** Firebase web config, overriding config.firebase.webConfig / webConfigEnv. */
  firebase?: FirebaseWebConfig;
  /**
   * Where the IceBase server listens (default config.emulator, then localhost:4400) — or
   * `{ embedded: name }` for one started in this process with startEmulator({ listen: false, name }).
   * `adminToken`: what an admin app sends (default ICEBASE_ADMIN_TOKEN, else 'owner' for a dev server).
   */
  emulator?: { /** The server's full origin ('https://host'): instead of host and port. */ origin?: string; /** Where the realtime socket is (default /v1/rt; config.emulator.socketPath on the server). */ socketPath?: string; host?: string; port?: number; embedded?: string; adminToken?: string; /** Admin apps: writes skip the server's schema check (seeding legacy data). */ unchecked?: boolean };
}

export interface IceBaseApp<Cfg extends AnyConfig = AnyConfig> {
  readonly name: string;
  readonly env: string;
  /** 'client' from initializeApp, 'admin' from icebase/admin's initializeAdminApp. */
  readonly kind: 'client' | 'admin';
  readonly config: Cfg;
  readonly modes: Readonly<Record<Service, Mode>>;
  readonly options: IceBaseAppOptions;
  /** @internal per-service singletons (getFirestore(app) returns the same instance). */
  readonly _services: Map<string, unknown>;
  /** @internal teardown hooks run by deleteApp. */
  readonly _onDelete: (() => Promise<void> | void)[];
  /** @internal */
  _deleted: boolean;
}

const DEFAULT = '[DEFAULT]';
const apps = new Map<string, IceBaseApp>();
const key = (kind: string, name: string) => `${kind}:${name}`;

/** @internal shared by initializeApp and initializeAdminApp. */
export function createApp(config: AnyConfig, env: string, kind: 'client' | 'admin', options: IceBaseAppOptions = {}): IceBaseApp {
  if (!config || !config.environments) throw configError('initializeApp(config, env): config must come from defineConfig(…)');
  const name = options.name ?? DEFAULT;
  const existing = apps.get(key(kind, name));
  if (existing) {
    if (existing.config === config && existing.env === env) return existing;
    throw new IceBaseError('already-exists', `IceBase app '${name}' already exists with a different config or environment; give the second one another name`, { reason: 'config' });
  }
  const app: IceBaseApp = { name, env, kind, config, modes: resolveModes(config, env), options, _services: new Map(), _onDelete: [], _deleted: false };
  apps.set(key(kind, name), app);
  return app;
}

/** initializeApp(config, 'prod') — picks the mode per service from config.environments.prod. */
export function initializeApp<Cfg extends IceBaseConfig<any, any>>(config: Cfg, env: EnvOf<Cfg>, options?: IceBaseAppOptions): IceBaseApp<Cfg> {
  return createApp(config as AnyConfig, env, 'client', options) as unknown as IceBaseApp<Cfg>;
}

export function getApp(name: string = DEFAULT): IceBaseApp {
  const app = apps.get(key('client', name));
  if (!app) throw new IceBaseError('not-found', `No IceBase app '${name}' — call initializeApp(config, env) first`, { reason: 'config' });
  return app;
}

export function getApps(): IceBaseApp[] {
  return [...apps.values()].filter((a) => a.kind === 'client');
}

/** @internal the admin apps, oldest first (functions triggers use the first one by default). */
export function adminApps(): IceBaseApp[] {
  return [...apps.values()].filter((a) => a.kind === 'admin');
}

export async function deleteApp(app: IceBaseApp): Promise<void> {
  if (app._deleted) return;
  app._deleted = true;
  apps.delete(key(app.kind, app.name));
  for (const hook of app._onDelete.splice(0).reverse()) await hook();
  app._services.clear();
}

/** @internal the service singleton, created once per app. */
export function service<T>(app: IceBaseApp, id: string, make: () => T): T {
  if (app._deleted) throw new IceBaseError('failed-precondition', `IceBase app '${app.name}' was deleted`, { reason: 'config' });
  let s = app._services.get(id) as T | undefined;
  if (s === undefined) {
    s = make();
    app._services.set(id, s);
  }
  return s;
}

/** @internal the Firebase web config for a client app in firebase mode. */
export function webConfigOf(app: IceBaseApp): FirebaseWebConfig {
  if (app.options.firebase) return app.options.firebase;
  const fb = app.config.firebase;
  if (!fb) throw configError(`firebase mode needs \`firebase\` in icebase.config (projectId and webConfig or webConfigEnv)`);
  if (fb.webConfig) return fb.webConfig;
  if (fb.webConfigEnv) {
    const raw = readEnv(fb.webConfigEnv);
    // Nothing talks to Google when every service is emulated: the project id is enough.
    if (!raw && Object.values(app.modes).every((m) => m === 'emulator')) return { apiKey: 'icebase-emulator', projectId: fb.projectId, storageBucket: fb.storageBucket ?? `${fb.projectId}.appspot.com` };
    if (!raw) throw configError(`firebase mode: env var ${fb.webConfigEnv} (firebase.webConfigEnv) is not set; it should hold the Firebase web config as JSON`);
    try {
      return JSON.parse(raw) as FirebaseWebConfig;
    } catch {
      throw configError(`firebase mode: env var ${fb.webConfigEnv} is not valid JSON`);
    }
  }
  // Enough for the Firebase emulators and for SDKs that only need the project.
  return { apiKey: 'icebase-no-api-key', projectId: fb.projectId, databaseURL: fb.databaseURL ?? `https://${fb.projectId}-default-rtdb.firebaseio.com`, storageBucket: fb.storageBucket ?? `${fb.projectId}.appspot.com` };
}

/** @internal the emulator server address for this app. */
export function emulatorOrigin(app: IceBaseApp): string {
  if (app.options.emulator?.embedded) return `http://embedded.icebase/${encodeURIComponent(app.options.emulator.embedded)}`;
  if (app.options.emulator?.origin) return app.options.emulator.origin.replace(/\/+$/, '');
  // Set by the IceBase server for the functions it runs, like FIREBASE_*_EMULATOR_HOST.
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ICEBASE_EMULATOR_HOST;
  if (env && !app.options.emulator) return `http://${env.replace(/^https?:\/\//, '')}`;
  const host = app.options.emulator?.host ?? app.config.emulator?.host ?? '127.0.0.1';
  const port = app.options.emulator?.port ?? app.config.emulator?.port ?? 4400;
  return `http://${host}:${port}`;
}

export const SDK_VERSION = '0.1.0';

// ─── embedded servers ───────────────────────────────────────────────────────────

type Handler = (req: Request) => Promise<Response>;
const embedded = new Map<string, Handler>();

/** @internal the IceBase server registers itself when started with listen: false. */
export function registerEmbedded(name: string, handler: Handler | null): void {
  const origin = `http://embedded.icebase/${encodeURIComponent(name)}`;
  if (handler) embedded.set(origin, handler);
  else embedded.delete(origin);
}

/** @internal fetch, or the in-process server when the origin is an embedded one. */
export function emulatorFetch(url: string, init: RequestInit): Promise<Response> {
  // The server sees its own paths (/v1/fs/…), not the name in the origin.
  for (const [origin, h] of embedded) if (url.startsWith(origin + '/')) return h(new Request(`http://embedded.icebase${url.slice(origin.length)}`, init));
  return fetch(url, init);
}
