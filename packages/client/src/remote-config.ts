// icebase/remote-config — same names as firebase/remote-config, typed from
// config.remoteConfig.parameters: getValue / getString take declared keys, getNumber and getBoolean
// only keys of that type, and getParameter(rc, key) returns the value in its declared type (a JSON
// parameter parsed and checked). The declared defaults are the in-app defaults (defaultConfig).
//
// firebase mode: the Firebase JS SDK (browser). emulator / vm mode: the IceBase server keeps the
// template (getAdminRemoteConfig / manageRemoteConfig publish it; the config's defaults until then)
// and serves fetches; onConfigUpdate is pushed over the realtime socket. Conditions are firebase
// mode only.

import * as rc from 'firebase/remote-config';
import { service, type IceBaseApp } from './app.ts';
import type { AnyConfig, ParamsOf, ParamValue, RemoteConfigParam, RemoteConfigParams } from './config.ts';
import { IceBaseError } from './errors.ts';
import { nativeWebApp } from './internal/firebase-web-app.ts';
import { parseParam, paramToString } from './internal/remote-config-shared.ts';
import { post, realtimeOf } from './drivers/firestore-emulator.ts';
import { nextId } from './internal/rt-client.ts';

export type ValueSource = 'static' | 'default' | 'remote';
export type FetchStatus = 'no-fetch-yet' | 'success' | 'failure' | 'throttle';
export type LogLevel = 'debug' | 'error' | 'silent';
export type Unsubscribe = () => void;
export interface RemoteConfigSettings {
  minimumFetchIntervalMillis: number;
  fetchTimeoutMillis: number;
}
export interface ConfigUpdate {
  getUpdatedKeys(): Set<string>;
}
export interface ConfigUpdateObserver {
  next: (configUpdate: ConfigUpdate) => void;
  error: (error: Error) => void;
  complete: () => void;
}

const TRUTHY = ['1', 'true', 't', 'yes', 'y', 'on'];

/** Firebase's Value: a parameter's string, read as a boolean / number / string, and where it came from. */
export class Value {
  constructor(
    private readonly source: ValueSource,
    private readonly value = '',
  ) {}
  asString(): string {
    return this.value;
  }
  asBoolean(): boolean {
    return this.source === 'static' ? false : TRUTHY.includes(this.value.toLowerCase());
  }
  asNumber(): number {
    if (this.source === 'static') return 0;
    const n = Number(this.value);
    return Number.isNaN(n) ? 0 : n;
  }
  getSource(): ValueSource {
    return this.source;
  }
}

/** @internal what both modes do. */
interface Backend {
  settings: RemoteConfigSettings;
  readonly fetchTimeMillis: number;
  readonly lastFetchStatus: FetchStatus;
  fetch(): Promise<void>;
  activate(): Promise<boolean>;
  ensureInitialized(): Promise<void>;
  /** The active (remote) string of a key, if any. */
  active(key: string): string | undefined;
  activeKeys(): string[];
  onUpdate(o: ConfigUpdateObserver): Unsubscribe;
  setLogLevel(l: LogLevel): void;
}

export class RemoteConfig<Cfg extends AnyConfig = AnyConfig> {
  /** In-app defaults: the declared parameters' defaults (strings for JSON parameters). */
  defaultConfig: Record<string, string | number | boolean>;
  constructor(
    readonly app: IceBaseApp<Cfg>,
    /** @internal */ readonly _backend: Backend,
  ) {
    const params = (app.config.remoteConfig?.parameters ?? {}) as RemoteConfigParams;
    this.defaultConfig = Object.fromEntries(Object.entries(params).map(([k, p]) => [k, p.valueType === 'json' ? JSON.stringify(p.defaultValue) : (p.defaultValue as string | number | boolean)]));
  }
  get settings(): RemoteConfigSettings {
    return this._backend.settings;
  }
  set settings(s: RemoteConfigSettings) {
    this._backend.settings = s;
  }
  get fetchTimeMillis(): number {
    return this._backend.fetchTimeMillis;
  }
  get lastFetchStatus(): FetchStatus {
    return this._backend.lastFetchStatus;
  }
}

export function getRemoteConfig<Cfg extends AnyConfig>(app: IceBaseApp<Cfg>): RemoteConfig<Cfg> {
  if (app.kind === 'admin') throw new IceBaseError('invalid-argument', 'This is an admin app: use getAdminRemoteConfig(app) from icebase/admin', { reason: 'config' });
  return service(app, 'remoteConfig', () => {
    const backend = app.modes.remoteConfig === 'firebase' ? firebaseBackend(app) : emulatorBackend(app);
    const r = new RemoteConfig(app, backend);
    if (app.modes.remoteConfig === 'firebase') (backend as Backend & { _sync(d: Record<string, string | number | boolean>): void })._sync(r.defaultConfig);
    return r;
  });
}

function firebaseBackend(app: IceBaseApp): Backend {
  const native = rc.getRemoteConfig(nativeWebApp(app));
  return {
    get settings() {
      return native.settings;
    },
    set settings(s) {
      native.settings = s;
    },
    get fetchTimeMillis() {
      return native.fetchTimeMillis;
    },
    get lastFetchStatus() {
      return native.lastFetchStatus;
    },
    fetch: () => rc.fetchConfig(native),
    activate: () => rc.activate(native),
    ensureInitialized: () => rc.ensureInitialized(native),
    active(key) {
      const v = rc.getValue(native, key);
      return v.getSource() === 'remote' ? v.asString() : undefined;
    },
    activeKeys: () => Object.entries(rc.getAll(native)).filter(([, v]) => v.getSource() === 'remote').map(([k]) => k),
    onUpdate: (o) => rc.onConfigUpdate(native, o as rc.ConfigUpdateObserver),
    setLogLevel: (l) => rc.setLogLevel(native, l),
    _sync(d: Record<string, string | number | boolean>) {
      native.defaultConfig = d;
    },
  } as Backend;
}

function emulatorBackend(app: IceBaseApp): Backend {
  let fetched: { entries: Record<string, string>; version: number } | null = null;
  let active: { entries: Record<string, string>; version: number } | null = null;
  const b = {
    settings: { minimumFetchIntervalMillis: 43_200_000, fetchTimeoutMillis: 60_000 } as RemoteConfigSettings,
    fetchTimeMillis: -1,
    lastFetchStatus: 'no-fetch-yet' as FetchStatus,
    async fetch(force = false) {
      if (!force && b.fetchTimeMillis > 0 && Date.now() - b.fetchTimeMillis < b.settings.minimumFetchIntervalMillis) {
        b.lastFetchStatus = 'throttle';
        return;
      }
      try {
        const r = await post<{ entries: Record<string, string>; templateVersion: number }>(app, '/v1/rc/fetch', {});
        fetched = { entries: r.entries, version: r.templateVersion };
        b.fetchTimeMillis = Date.now();
        b.lastFetchStatus = 'success';
      } catch (e) {
        b.lastFetchStatus = 'failure';
        throw e;
      }
    },
    async activate() {
      if (!fetched || (active && active.version === fetched.version && JSON.stringify(active.entries) === JSON.stringify(fetched.entries))) return false;
      active = fetched;
      return true;
    },
    async ensureInitialized() {},
    active: (key: string) => active?.entries[key],
    activeKeys: () => Object.keys(active?.entries ?? {}),
    onUpdate(o: ConfigUpdateObserver): Unsubscribe {
      // The server says a new template is out; fetch it (not activated) and tell which keys changed.
      return realtimeOf(app).listen(
        'rc',
        nextId(),
        {},
        () => {
          void (async () => {
            try {
              const before = active?.entries ?? {};
              await b.fetch(true);
              const after = fetched?.entries ?? {};
              const keys = new Set([...Object.keys(before), ...Object.keys(after)].filter((k) => before[k] !== after[k]));
              if (keys.size) o.next({ getUpdatedKeys: () => keys });
            } catch (e) {
              o.error(e as Error);
            }
          })();
        },
        (e) => o.error(e),
      );
    },
    setLogLevel() {},
  };
  return b as Backend;
}

// ─── typed keys ────────────────────────────────────────────────────────────────

type Params<Cfg> = ParamsOf<Cfg>;
/** The declared parameter names (any string when none are declared). */
export type ParamKey<Cfg> = [keyof Params<Cfg>] extends [never] ? string : keyof Params<Cfg> & string;
type KeysOf<Cfg, V> = [keyof Params<Cfg>] extends [never] ? string : { [K in keyof Params<Cfg>]: Params<Cfg>[K] extends RemoteConfigParam<infer T, any> ? (T extends V ? K : never) : never }[keyof Params<Cfg>] & string;
/** A parameter's declared type. */
export type ParamType<Cfg, K> = K extends keyof Params<Cfg> ? ParamValue<Params<Cfg>[K]> : unknown;

const paramOf = (r: RemoteConfig<any>, key: string): RemoteConfigParam<unknown> | undefined => (r.app.config.remoteConfig?.parameters as RemoteConfigParams | undefined)?.[key];

const warn = (msg: string) => console.warn(`[icebase remote-config] ${msg}`);

/**
 * The value of a key: the active remote value when it fits its declaration, else the declared default.
 * A remote value that does not fit is ignored (and logged): an app never reads a value of the wrong type.
 */
export function getValue<Cfg extends AnyConfig>(r: RemoteConfig<Cfg>, key: ParamKey<Cfg>): Value {
  const p = paramOf(r, key);
  const remote = r._backend.active(key);
  if (remote !== undefined) {
    if (!p) return new Value('remote', remote);
    const ok = parseParam(p, remote, `remote config '${key}'`);
    if (ok.ok) return new Value('remote', remote);
    warn(`${ok.error}; using the declared default`);
  }
  if (p) return new Value('default', paramToString(p, p.defaultValue));
  if (key in r.defaultConfig) return new Value('default', String(r.defaultConfig[key]));
  return new Value('static');
}

export const getString = <Cfg extends AnyConfig>(r: RemoteConfig<Cfg>, key: ParamKey<Cfg>): string => getValue(r, key).asString();
export const getNumber = <Cfg extends AnyConfig>(r: RemoteConfig<Cfg>, key: KeysOf<Cfg, number>): number => getValue(r, key as ParamKey<Cfg>).asNumber();
export const getBoolean = <Cfg extends AnyConfig>(r: RemoteConfig<Cfg>, key: KeysOf<Cfg, boolean>): boolean => getValue(r, key as ParamKey<Cfg>).asBoolean();

/** Every declared parameter (and any other active key) with its Value. */
export function getAll<Cfg extends AnyConfig>(r: RemoteConfig<Cfg>): Record<string, Value> {
  const keys = new Set([...Object.keys(r.defaultConfig), ...r._backend.activeKeys()]);
  return Object.fromEntries([...keys].map((k) => [k, getValue(r, k as ParamKey<Cfg>)]));
}

/** IceBase: a declared parameter in its declared type — getParameter(rc, 'theme') is the parsed, checked JSON. */
export function getParameter<Cfg extends AnyConfig, K extends ParamKey<Cfg>>(r: RemoteConfig<Cfg>, key: K): ParamType<Cfg, K> {
  const p = paramOf(r, key);
  if (!p) throw new IceBaseError('invalid-argument', `getParameter(rc, '${key}'): not declared in config.remoteConfig.parameters`, { reason: 'schema', service: 'remoteConfig' });
  const v = getValue(r, key);
  const parsed = parseParam(p, v.asString(), key);
  return (parsed.ok ? parsed.value : p.defaultValue) as ParamType<Cfg, K>;
}

export const fetchConfig = (r: RemoteConfig<any>): Promise<void> => r._backend.fetch();
export const activate = (r: RemoteConfig<any>): Promise<boolean> => r._backend.activate();
export async function fetchAndActivate(r: RemoteConfig<any>): Promise<boolean> {
  await r._backend.fetch();
  return r._backend.activate();
}
export const ensureInitialized = (r: RemoteConfig<any>): Promise<void> => r._backend.ensureInitialized();
export const onConfigUpdate = (r: RemoteConfig<any>, observer: ConfigUpdateObserver): Unsubscribe => r._backend.onUpdate(observer);
export const setLogLevel = (r: RemoteConfig<any>, logLevel: LogLevel): void => r._backend.setLogLevel(logLevel);
/** firebase mode: whether this browser supports Remote Config; the IceBase server's always does. */
export const isSupported = (): Promise<boolean> => rc.isSupported();
