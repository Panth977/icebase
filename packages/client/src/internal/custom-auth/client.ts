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

// ── Google ───────────────────────────────────────────────────────────────────

const here = () => (globalThis as { location?: Location }).location;

export function googlePopup(auth: Auth<unknown>): Promise<UserCredential> {
  const loc = here();
  const w = globalThis as unknown as Window;
  if (!loc || typeof w.open !== 'function') throw new FirebaseError('auth/operation-not-supported-in-this-environment', 'signInWithPopup needs a browser');
  const start = `${endpointOf(auth)}/google/start?mode=popup&return=${encodeURIComponent(loc.href)}`;
  const popup = w.open(start, 'icebase-google', 'width=500,height=650');
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
      if (e.origin !== from || (e.data as { icebase?: string })?.icebase !== 'google') return;
      cleanup();
      const d = e.data as { token?: string; error?: { code: string; message: string } };
      if (d.token) signIn(auth, d.token).then(resolve, reject);
      else reject(new FirebaseError(d.error?.code ?? 'auth/internal-error', d.error?.message ?? 'Google sign-in failed'));
    };
    const cleanup = () => {
      clearInterval(timer);
      w.removeEventListener('message', onMessage);
    };
    w.addEventListener('message', onMessage);
  });
}

export function googleRedirect(auth: Auth<unknown>): Promise<never> {
  const loc = here();
  if (!loc) throw new FirebaseError('auth/operation-not-supported-in-this-environment', 'signInWithRedirect needs a browser');
  loc.assign(`${endpointOf(auth)}/google/start?mode=redirect&return=${encodeURIComponent(loc.href.split('#')[0]!)}`);
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
  if (error) throw new FirebaseError(error, 'Google sign-in failed');
  return signIn(auth, token!);
}

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
  getRedirectResult: (auth) => googleRedirectResult(auth),
};

/** Set by auth.ts so sendEmailVerification(user) can find its Auth. */
let authFor: (u: User) => Auth<unknown> = () => {
  throw new FirebaseError('auth/argument-error', 'sendEmailVerification: user is not from an IceBase Auth');
};
export function setAuthLookup(f: (u: User) => Auth<unknown>): void {
  authFor = f;
}
