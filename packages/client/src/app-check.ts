// icebase/app-check — same names as firebase/app-check.
//
// firebase mode: the Firebase JS SDK with the provider you pass (reCAPTCHA v3 / Enterprise, a
// custom provider, or DebugProvider: Firebase's debug-token mode).
// emulator / vm mode: the IceBase server issues the App Check tokens. The app proves itself with a
// debug token (DebugProvider(token), else FIREBASE_APPCHECK_DEBUG_TOKEN / ICEBASE_APPCHECK_DEBUG_TOKEN,
// else one made up and logged, as Firebase's debug mode does); the server takes any debug token when
// it does not sign its tokens (a dev emulator), only registered ones (manageAppCheck) otherwise.
// Initialize App Check before the other services: their requests carry the token.

import * as ac from 'firebase/app-check';
import { emulatorFetch, emulatorOrigin, service, type IceBaseApp } from './app.ts';
import { readEnv } from './config.ts';
import { IceBaseError } from './errors.ts';
import { nativeWebApp } from './internal/firebase-web-app.ts';

export type AppCheckTokenResult = ac.AppCheckTokenResult;
export type AppCheckOptions = Omit<ac.AppCheckOptions, 'provider'> & { provider: ReCaptchaV3Provider | ReCaptchaEnterpriseProvider | CustomProvider | DebugProvider };
export type Unsubscribe = ac.Unsubscribe;
export const ReCaptchaV3Provider = ac.ReCaptchaV3Provider;
export type ReCaptchaV3Provider = ac.ReCaptchaV3Provider;
export const ReCaptchaEnterpriseProvider = ac.ReCaptchaEnterpriseProvider;
export type ReCaptchaEnterpriseProvider = ac.ReCaptchaEnterpriseProvider;
export const CustomProvider = ac.CustomProvider;
export type CustomProvider = ac.CustomProvider;

/**
 * Debug-token attestation. emulator / vm: the token is exchanged with the IceBase server. firebase
 * mode: Firebase's debug mode (the token must be registered in the Firebase console or with
 * manageAppCheck(app).createDebugToken); `siteKey` is the reCAPTCHA v3 key used outside debug mode.
 */
export class DebugProvider {
  readonly kind = 'icebase-debug' as const;
  constructor(readonly debugToken?: string, readonly siteKey?: string) {}
}

export class AppCheck {
  constructor(
    readonly app: IceBaseApp,
    /** @internal */ readonly _native: ac.AppCheck,
    /** @internal the token the IceBase server's services get (emulator / vm). */ readonly _icebaseToken: (() => Promise<string | null>) | null,
  ) {}
}

function debugTokenOf(p: AppCheckOptions['provider']): string {
  if (p instanceof DebugProvider && p.debugToken) return p.debugToken;
  const g = (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN;
  if (typeof g === 'string' && g) return g;
  const env = readEnv('ICEBASE_APPCHECK_DEBUG_TOKEN');
  if (env) return env;
  const made = crypto.randomUUID();
  console.log(`IceBase App Check debug token: ${made}. On a server that signs its tokens, register it: manageAppCheck(adminApp).createDebugToken('name', '${made}').`);
  return made;
}

/** initializeAppCheck(app, { provider, isTokenAutoRefreshEnabled }) — once per app. */
export function initializeAppCheck(app: IceBaseApp, options: AppCheckOptions): AppCheck {
  if (app.kind === 'admin') throw new IceBaseError('invalid-argument', 'App Check is for client apps; admin apps are trusted (getAdminAppCheck verifies tokens)', { reason: 'config' });
  if (app._services.has('appCheck')) throw new IceBaseError('already-exists', `App Check is already initialized for app '${app.name}'`, { reason: 'config' });
  return service(app, 'appCheck', () => {
    const mode = app.modes.appCheck;
    if (mode === 'firebase') {
      let provider: ac.AppCheckOptions['provider'] | DebugProvider = options.provider;
      if (provider instanceof DebugProvider) {
        (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN = provider.debugToken ?? true;
        // Debug mode replaces attestation; a site key keeps reCAPTCHA v3 for when it is off.
        provider = provider.siteKey ? new ac.ReCaptchaV3Provider(provider.siteKey) : new ac.CustomProvider({ getToken: () => Promise.reject(new IceBaseError('failed-precondition', 'App Check DebugProvider: debug mode only (give a reCAPTCHA site key for the rest)')) });
      }
      return new AppCheck(app, ac.initializeAppCheck(nativeWebApp(app), { ...options, provider }), null);
    }
    const debugToken = debugTokenOf(options.provider);
    let cached: { token: string; until: number } | null = null;
    const exchange = async (): Promise<{ token: string; expireTimeMillis: number }> => {
      const res = await emulatorFetch(`${emulatorOrigin(app)}/v1/appcheck/exchangeDebugToken`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ debugToken, appId: app.options.firebase?.appId ?? app.config.firebase?.webConfig?.appId ?? app.config.name }) });
      const j = (await res.json().catch(() => ({}))) as { token?: string; ttlMillis?: number; error?: { code: IceBaseError['code']; message: string } };
      if (!res.ok || !j.token) throw new IceBaseError(j.error?.code ?? 'internal', `App Check: ${j.error?.message ?? res.status}`, { service: 'appCheck' });
      cached = { token: j.token, until: Date.now() + (j.ttlMillis ?? 3_600_000) };
      return { token: j.token, expireTimeMillis: cached.until };
    };
    // The Firebase SDKs IceBase drives in this mode (storage, functions, auth) attach the token themselves.
    const native = ac.initializeAppCheck(nativeWebApp(app), { provider: new ac.CustomProvider({ getToken: exchange }), isTokenAutoRefreshEnabled: options.isTokenAutoRefreshEnabled ?? false });
    const token = async () => {
      if (cached && cached.until - 60_000 > Date.now()) return cached.token;
      return (await ac.getToken(native)).token;
    };
    return new AppCheck(app, native, token);
  });
}

export const getToken = (appCheck: AppCheck, forceRefresh?: boolean): Promise<AppCheckTokenResult> => ac.getToken(appCheck._native, forceRefresh);
export const getLimitedUseToken = (appCheck: AppCheck): Promise<AppCheckTokenResult> => ac.getLimitedUseToken(appCheck._native);
export const setTokenAutoRefreshEnabled = (appCheck: AppCheck, enabled: boolean): void => ac.setTokenAutoRefreshEnabled(appCheck._native, enabled);
export function onTokenChanged(appCheck: AppCheck, onNext: ((t: AppCheckTokenResult) => void) | ac.PartialObserver<AppCheckTokenResult>, onError?: (e: Error) => void, onCompletion?: () => void): Unsubscribe {
  return typeof onNext === 'function' ? ac.onTokenChanged(appCheck._native, onNext, onError, onCompletion) : ac.onTokenChanged(appCheck._native, onNext);
}
