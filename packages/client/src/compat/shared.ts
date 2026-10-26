// What the web compat modules (compat/firestore, compat/database) share: the IceBase app they talk
// through, made from any Firebase-style app ({ name, options }) — no icebase.config needed: the
// IceBase server holds the schema and the rules, and checks every read and write itself.

import { initializeApp, type IceBaseApp } from '../app.ts';
import type { AnyConfig } from '../config.ts';
import { defineSchema } from '../schema.ts';

export interface CompatSettings {
  /** The IceBase server, e.g. 'https://tt.example.com'. Default: the page's origin. */
  origin?: string;
  /** Where the server takes the realtime socket (default /v1/rt). */
  socketPath?: string;
  /** The signed-in user's ID token (e.g. () => auth.currentUser?.getIdToken() ?? null). */
  idToken?: () => Promise<string | null> | string | null;
}

let settings: CompatSettings = {};
const apps = new Map<string, IceBaseApp>();

/**
 * Where the compat modules find the IceBase server and the caller's ID token. Call it once, before
 * the first read (an auth wrapper usually does, with onIdTokenChanged → refreshIceBaseAuth()).
 */
export function configureIceBase(s: CompatSettings): void {
  settings = { ...settings, ...s };
}

/** The ID token changed (sign-in, sign-out, refresh): open listeners are re-authenticated. */
export function refreshIceBaseAuth(): void {
  for (const app of apps.values()) {
    const rt = app._services.get('emulator:rt') as { reauth?: () => void } | undefined;
    rt?.reauth?.();
  }
}

const pageOrigin = (): string => (globalThis as { location?: { origin?: string } }).location?.origin ?? 'http://127.0.0.1:4400';

/** A Firebase-style app (or nothing: the default) → its IceBase app. */
export function iceApp(app?: { name?: string } | null): IceBaseApp {
  const name = app?.name ?? '[DEFAULT]';
  let a = apps.get(name);
  if (!a) {
    const origin = settings.origin ?? pageOrigin();
    // An empty schema: the server validates; this side only moves data.
    const config = { name: 'icebase-compat', schema: defineSchema({}), environments: { compat: { mode: 'emulator' } } } as unknown as AnyConfig;
    a = initializeApp(config, 'compat' as never, { name: `icebase-compat:${name}`, emulator: { origin, ...(settings.socketPath ? { socketPath: settings.socketPath } : {}) } });
    // callerToken() reads the token through the app's auth service.
    a._services.set('auth', {
      get currentUser() {
        return { getIdToken: async () => (settings.idToken ? await settings.idToken() : null) };
      },
    });
    apps.set(name, a);
  }
  return a;
}
