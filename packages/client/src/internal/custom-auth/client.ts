// The browser half of custom auth: the standard Firebase function names, talking to the
// IceBase auth endpoint, and ending in signInWithCustomToken.

import { FirebaseError } from 'firebase/app';
import * as fa from 'firebase/auth';
import type { Auth, ConfirmationResult, CustomFlows, User, UserCredential } from '../../auth.ts';
import { authEndpoint, STORE_DEFAULT_PATH } from './shared.ts';

const endpointOf = (auth: Auth<unknown>) => authEndpoint(auth.app.config, auth.app.env, auth.app);

export async function call<T>(auth: Auth<unknown>, route: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${endpointOf(auth)}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new FirebaseError('auth/network-request-failed', `Could not reach the IceBase auth endpoint: ${(e as Error).message}`);
  }
  const j = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; retryAfter?: number } } & T;
  if (!res.ok || j.error) throw new FirebaseError(j.error?.code ?? 'auth/internal-error', j.error?.message ?? `IceBase auth ${res.status}`, j.error?.retryAfter ? { retryAfter: j.error.retryAfter } : undefined);
  return j;
}

const signIn = (auth: Auth<unknown>, token: string): Promise<UserCredential> => fa.signInWithCustomToken(auth._native, token);

// ── pending email sign-ins (approval / code) ─────────────────────────────────

export interface PendingEmail {
  mode: 'approval' | 'code' | 'link';
  email: string;
  signinId?: string;
  clientSecret?: string;
  expiresAt: number;
}
const KEY = (auth: Auth<unknown>) => `icebase:pendingEmail:${auth.app.name}`;
const memory = new Map<string, PendingEmail>();
const storage = (): Storage | null => {
  try {
    return (globalThis as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null;
  }
};
export function savePending(auth: Auth<unknown>, p: PendingEmail | null): void {
  if (p) memory.set(KEY(auth), p);
  else memory.delete(KEY(auth));
  const s = storage();
  if (s) p ? s.setItem(KEY(auth), JSON.stringify(p)) : s.removeItem(KEY(auth));
}
export function pendingOf(auth: Auth<unknown>): PendingEmail | null {
  const p = memory.get(KEY(auth)) ?? (JSON.parse(storage()?.getItem(KEY(auth)) ?? 'null') as PendingEmail | null);
  return p && p.expiresAt > Date.now() ? p : null;
}

export async function startEmail(auth: Auth<unknown>, email: string, continueUrl?: string): Promise<PendingEmail> {
  const r = await call<{ mode: PendingEmail['mode']; signinId?: string; clientSecret?: string; expiresAt: number }>(auth, '/email/start', { email, ...(continueUrl ? { continueUrl } : {}) });
  const p: PendingEmail = { mode: r.mode, email, expiresAt: r.expiresAt, ...(r.signinId ? { signinId: r.signinId } : {}), ...(r.clientSecret ? { clientSecret: r.clientSecret } : {}) };
  savePending(auth, p.mode === 'link' ? null : p);
  return p;
}

export async function verifyEmailCode(auth: Auth<unknown>, code: string, signinId = pendingOf(auth)?.signinId): Promise<UserCredential> {
  if (!signinId) throw new FirebaseError('auth/argument-error', 'No pending email sign-in: call sendSignInLinkToEmail first');
  const { token } = await call<{ token: string }>(auth, '/email/code', { signinId, code });
  savePending(auth, null);
  return signIn(auth, token);
}

export type ApprovalState = 'pending' | 'approved' | 'revoked' | 'expired';

/** Wait for the emailed approval, then sign in. Listens on the Realtime Database status word when it can, else polls. */
export async function waitForApproval(auth: Auth<unknown>, opts: { onState?: (s: ApprovalState) => void; signal?: AbortSignal } = {}): Promise<UserCredential> {
  const p = pendingOf(auth);
  if (!p || p.mode !== 'approval' || !p.signinId || !p.clientSecret) throw new FirebaseError('auth/argument-error', 'No pending email approval: call sendSignInLinkToEmail first');
  const collect = () => call<{ state: ApprovalState | 'busy'; token?: string }>(auth, '/email/collect', { signinId: p.signinId, clientSecret: p.clientSecret });
  const finish = async (): Promise<UserCredential | null> => {
    const r = await collect();
    if (r.state === 'approved' && r.token) {
      savePending(auth, null);
      opts.onState?.('approved');
      return signIn(auth, r.token);
    }
    if (r.state === 'revoked' || r.state === 'expired') {
      savePending(auth, null);
      opts.onState?.(r.state);
      throw new FirebaseError(r.state === 'revoked' ? 'auth/user-cancelled' : 'auth/expired-action-code', r.state === 'revoked' ? 'The sign-in was turned down from the email.' : 'The email link expired. Ask for a new one.');
    }
    return null;
  };
  opts.onState?.('pending');
  const { webConfigOf } = await import('../../app.ts');
  const url = auth.app.modes.auth === 'firebase' ? webConfigOf(auth.app).databaseURL : undefined;
  if (url) {
    // One read when it attaches, one when the word changes; the endpoint is called once at the end.
    const db = await import('firebase/database');
    const { nativeWebApp } = await import('../firebase-web-app.ts');
    const root = auth.app.config.auth?.custom?.security?.store?.path ?? STORE_DEFAULT_PATH;
    const r = db.ref(db.getDatabase(nativeWebApp(auth.app), url), `${root}/signin/${p.signinId}/state`);
    return new Promise<UserCredential>((resolve, reject) => {
      const stop = db.onValue(
        r,
        (s) => {
          const v = s.val() as ApprovalState | null;
          if (v === 'pending') return;
          stop();
          finish().then((c) => (c ? resolve(c) : reject(new FirebaseError('auth/internal-error', 'Approval state changed but nothing to collect'))), reject);
        },
        (e) => reject(e),
      );
      opts.signal?.addEventListener('abort', () => {
        stop();
        reject(new FirebaseError('auth/cancelled-popup-request', 'Stopped waiting'));
      });
    });
  }
  let delay = 2000;
  for (;;) {
    if (opts.signal?.aborted) throw new FirebaseError('auth/cancelled-popup-request', 'Stopped waiting');
    const c = await finish();
    if (c) return c;
    if (Date.now() > p.expiresAt) throw new FirebaseError('auth/expired-action-code', 'The email link expired. Ask for a new one.');
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.3, 6000);
  }
}

export async function cancelEmail(auth: Auth<unknown>): Promise<void> {
  const p = pendingOf(auth);
  savePending(auth, null);
  if (p?.signinId && p.clientSecret) await call(auth, '/email/cancel', { signinId: p.signinId, clientSecret: p.clientSecret }).catch(() => {});
}

// ── Google and Apple ─────────────────────────────────────────────────────────

const here = () => (globalThis as { location?: Location }).location;
export type OAuthKind = 'google' | 'apple';
const label = (p: OAuthKind) => (p === 'google' ? 'Google' : 'Apple');

export function googlePopup(auth: Auth<unknown>, provider: OAuthKind = 'google'): Promise<UserCredential> {
  const loc = here();
  const w = globalThis as unknown as Window;
  if (!loc || typeof w.open !== 'function') throw new FirebaseError('auth/operation-not-supported-in-this-environment', 'signInWithPopup needs a browser');
  const start = `${endpointOf(auth)}/${provider}/start?mode=popup&return=${encodeURIComponent(loc.href)}`;
  const popup = w.open(start, `icebase-${provider}`, 'width=500,height=650');
  if (!popup) throw new FirebaseError('auth/popup-blocked', 'The sign-in popup was blocked');
  const from = new URL(endpointOf(auth)).origin;
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (popup.closed) {
        cleanup();
        reject(new FirebaseError('auth/popup-closed-by-user', 'The sign-in popup was closed'));
      }
    }, 800);
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== from || (e.data as { icebase?: string })?.icebase !== provider) return;
      cleanup();
      const d = e.data as { token?: string; error?: { code: string; message: string } };
      if (d.token) signIn(auth, d.token).then(resolve, reject);
      else reject(new FirebaseError(d.error?.code ?? 'auth/internal-error', d.error?.message ?? `${label(provider)} sign-in failed`));
    };
    const cleanup = () => {
      clearInterval(timer);
      w.removeEventListener('message', onMessage);
    };
    w.addEventListener('message', onMessage);
  });
}

export function googleRedirect(auth: Auth<unknown>, provider: OAuthKind = 'google'): Promise<never> {
  const loc = here();
  if (!loc) throw new FirebaseError('auth/operation-not-supported-in-this-environment', 'signInWithRedirect needs a browser');
  loc.assign(`${endpointOf(auth)}/${provider}/start?mode=redirect&return=${encodeURIComponent(loc.href.split('#')[0]!)}`);
  return new Promise<never>(() => {});
}

export async function googleRedirectResult(auth: Auth<unknown>): Promise<UserCredential | null> {
  const loc = here();
  if (!loc?.hash) return null;
  const params = new URLSearchParams(loc.hash.slice(1));
  const token = params.get('icebase_token');
  const error = params.get('icebase_error');
  if (!token && !error) return null;
  (globalThis as { history?: History }).history?.replaceState(null, '', loc.href.split('#')[0]);
  if (error) throw new FirebaseError(error, 'Sign-in failed');
  return signIn(auth, token!);
}

/** A native app's Sign in with Apple: the identity token of Apple's sheet (and the name, which Apple gives only the first time). */
export async function appleIdTokenSignIn(auth: Auth<unknown>, idToken: string, name?: string | { givenName?: string | null; familyName?: string | null }, nonce?: string): Promise<UserCredential> {
  const { token } = await call<{ token: string }>(auth, '/apple/token', { idToken, ...(name ? { name } : {}), ...(nonce ? { nonce } : {}) });
  return signIn(auth, token);
}

// ── SSO: sign in through the project's hosted sign-in page (PKCE) ─────────────

export interface SsoPending {
  verifier: string;
  clientId: string;
  redirectUri: string;
}
const SSO_KEY = (state: string) => `icebase:sso:${state}`;
const ssoMemory = new Map<string, string>();
// localStorage, not sessionStorage: a native app's return may land in a new tab or webview.
const local = (): Storage | null => {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
};
const keep = (k: string, v: string | null) => {
  if (v === null) ssoMemory.delete(k);
  else ssoMemory.set(k, v);
  try {
    const s = local();
    if (s) v === null ? s.removeItem(k) : s.setItem(k, v);
  } catch {
    /* storage full or blocked: memory still has it */
  }
};
const kept = (k: string): string | null => {
  try {
    return local()?.getItem(k) ?? ssoMemory.get(k) ?? null;
  } catch {
    return ssoMemory.get(k) ?? null;
  }
};
const random = (bytes: number) => {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return b64url(a);
};
const b64url = (a: Uint8Array) => btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function ssoAuthorizeUrl(auth: Auth<unknown>, opts: { clientId: string; redirectUri: string }): Promise<{ url: string; state: string; verifier: string }> {
  const verifier = random(32);
  const state = random(16);
  const challenge = b64url(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const q = new URLSearchParams({ client_id: opts.clientId, redirect_uri: opts.redirectUri, response_type: 'code', state, code_challenge: challenge, code_challenge_method: 'S256' });
  return { url: `${endpointOf(auth)}/sso/authorize?${q}`, state, verifier };
}

export async function startSso(auth: Auth<unknown>, opts: { clientId: string; redirectUri: string; open?: (url: string) => void | Promise<void> }): Promise<void> {
  const { url, state, verifier } = await ssoAuthorizeUrl(auth, opts);
  keep(SSO_KEY(state), JSON.stringify({ verifier, clientId: opts.clientId, redirectUri: opts.redirectUri } satisfies SsoPending));
  if (opts.open) return void (await opts.open(url));
  const loc = here();
  if (!loc) throw new FirebaseError('auth/operation-not-supported-in-this-environment', 'startSsoSignIn needs a browser, or an `open` to show the URL');
  loc.assign(url);
}

export async function completeSso(auth: Auth<unknown>, url?: string, pending?: SsoPending): Promise<UserCredential | null> {
  const loc = here();
  const href = url ?? loc?.href;
  if (!href) return null;
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    return null;
  }
  const q = u.searchParams;
  const code = q.get('code');
  const error = q.get('error');
  const state = q.get('state');
  if (!(code && state) && !error) return null;
  // The return URL leaves the address bar clean (a code is single use anyway).
  if (!url && loc && typeof history !== 'undefined') {
    const clean = new URL(href);
    for (const k of ['code', 'state', 'error']) clean.searchParams.delete(k);
    history.replaceState(null, '', clean.toString());
  }
  const raw = state ? kept(SSO_KEY(state)) : null;
  if (state) keep(SSO_KEY(state), null);
  if (error) throw new FirebaseError(error === 'access_denied' ? 'auth/user-cancelled' : 'auth/internal-error', error === 'access_denied' ? 'The sign-in was declined on the sign-in page.' : `SSO sign-in failed: ${error}`);
  const p = pending ?? (raw ? (JSON.parse(raw) as SsoPending) : null);
  if (!p) throw new FirebaseError('auth/invalid-sso-state', 'This sign-in was not started here (unknown state). Start again.');
  const r = await call<{ token: string }>(auth, '/sso/token', { code, code_verifier: p.verifier, client_id: p.clientId, redirect_uri: p.redirectUri });
  return signIn(auth, r.token);
}

export function watchSso(auth: Auth<unknown>, onRevoked?: () => void): () => void {
  let stopped = false;
  const over = async () => {
    if (stopped) return;
    stop();
    await fa.signOut(auth._native).catch(() => {});
    onRevoked?.();
  };
  const ping = async () => {
    const user = auth._native.currentUser;
    if (stopped || !user) return;
    let idToken: string;
    try {
      idToken = await user.getIdToken();
    } catch (e) {
      // The refresh token was revoked (sign out everywhere) or the account disabled.
      if (['auth/user-token-expired', 'auth/user-disabled', 'auth/user-not-found'].includes((e as { code?: string }).code ?? '')) await over();
      return;
    }
    try {
      const r = await call<{ ok?: boolean; revoked?: boolean }>(auth, '/sso/ping', { idToken });
      if (r.revoked) await over();
    } catch {
      /* offline, or not an SSO session: try again later */
    }
  };
  const doc = (globalThis as { document?: Document }).document;
  const onVisible = () => {
    if (doc?.visibilityState === 'visible') void ping();
  };
  doc?.addEventListener('visibilitychange', onVisible);
  const timer = setInterval(() => void ping(), 10 * 60_000);
  (timer as { unref?: () => void }).unref?.();
  void auth._native.authStateReady().then(ping);
  function stop() {
    stopped = true;
    clearInterval(timer);
    doc?.removeEventListener('visibilitychange', onVisible);
  }
  return stop;
}

/** The SSO request the hosted page is answering. */
export interface SsoRequestInfo {
  client: { id: string; name: string; iconUrl?: string };
  expiresAt: number;
}
/** One app session made by SSO sign-in. */
export interface SsoSessionInfo {
  sid: string;
  client: string;
  clientName: string;
  device: string;
  ip: string | null;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
  revokedAt?: number;
  /** The session of the token that asked. */
  current: boolean;
}
/** An app with live sessions. */
export interface SsoAppInfo {
  client: string;
  clientName: string;
  iconUrl?: string;
  /** How many live sessions. */
  sessions: number;
  lastSeenAt: number;
}
const idTokenOf = async (auth: Auth<unknown>) => {
  const u = auth._native.currentUser;
  if (!u) throw new FirebaseError('auth/user-not-found', 'Sign in first.');
  return u.getIdToken();
};
export const ssoRequestInfo = (auth: Auth<unknown>, sso: string): Promise<SsoRequestInfo> => call<SsoRequestInfo>(auth, '/sso/request', { sso });
export const ssoGrant = async (auth: Auth<unknown>, sso: string): Promise<string> => (await call<{ redirect: string }>(auth, '/sso/grant', { sso, idToken: await idTokenOf(auth) })).redirect;
export const ssoDeny = async (auth: Auth<unknown>, sso: string): Promise<string> => (await call<{ redirect: string }>(auth, '/sso/deny', { sso })).redirect;
export const ssoSessions = async (auth: Auth<unknown>): Promise<{ sessions: SsoSessionInfo[]; apps: SsoAppInfo[] }> => {
  const r = await call<{ sessions: SsoSessionInfo[]; apps: SsoAppInfo[] }>(auth, '/sso/sessions', { idToken: await idTokenOf(auth) });
  return { sessions: r.sessions, apps: r.apps };
};
export const ssoRevoke = async (auth: Auth<unknown>, which: { sid: string } | { client: string } | { all: true }): Promise<{ revoked: number }> => {
  const r = await call<{ revoked: number }>(auth, '/sso/revoke', { idToken: await idTokenOf(auth), ...which });
  return { revoked: r.revoked };
};

// ── the flows behind the standard names ──────────────────────────────────────

export const flows: CustomFlows = {
  async sendSignInLinkToEmail(auth, email, settings) {
    await startEmail(auth, email, settings.url);
  },
  isSignInWithEmailLink(_auth, link) {
    try {
      return new URL(link).searchParams.has('icebase_link');
    } catch {
      return false;
    }
  },
  async signInWithEmailLink(auth, email, link = here()?.href ?? '') {
    const t = new URL(link).searchParams.get('icebase_link');
    if (!t) throw new FirebaseError('auth/argument-error', 'Not an IceBase sign-in link');
    const { token } = await call<{ token: string }>(auth, '/email/link', { email, token: t });
    return signIn(auth, token);
  },
  async sendPasswordResetEmail(auth, email, settings) {
    await call(auth, '/reset/start', { email, ...(settings?.url ? { continueUrl: settings.url } : {}) });
  },
  async verifyPasswordResetCode(auth, code) {
    return (await call<{ email: string }>(auth, '/reset/check', { oobCode: code })).email;
  },
  async confirmPasswordReset(auth, code, newPassword) {
    await call(auth, '/reset/confirm', { oobCode: code, newPassword });
  },
  async sendEmailVerification(user: User, settings) {
    await call(authFor(user), '/verify/start', { idToken: await user.getIdToken(), ...(settings?.url ? { continueUrl: settings.url } : {}) });
  },
  async applyActionCode(auth, code) {
    await call(auth, '/verify/confirm', { oobCode: code });
  },
  async signInWithPhoneNumber(auth, phoneNumber): Promise<ConfirmationResult> {
    const { verificationId } = await call<{ verificationId: string }>(auth, '/phone/start', { phoneNumber });
    return {
      verificationId,
      confirm: async (code: string) => signIn(auth, (await call<{ token: string }>(auth, '/phone/verify', { verificationId, code })).token),
    };
  },
  signInWithGoogle: (auth, how) => (how === 'popup' ? googlePopup(auth) : googleRedirect(auth)),
  signInWithApple: (auth, how) => (how === 'popup' ? googlePopup(auth, 'apple') : googleRedirect(auth, 'apple')),
  getRedirectResult: (auth) => googleRedirectResult(auth),
};

/** Set by auth.ts so sendEmailVerification(user) can find its Auth. */
let authFor: (u: User) => Auth<unknown> = () => {
  throw new FirebaseError('auth/argument-error', 'sendEmailVerification: user is not from an IceBase Auth');
};
export function setAuthLookup(f: (u: User) => Auth<unknown>): void {
  authFor = f;
}
