// icebase/auth — same names and call shapes as firebase/auth.
//
// firebase mode: the Firebase JS SDK, unchanged. emulator mode: the same SDK pointed at the
// IceBase server (which speaks the Identity Toolkit REST API, like Firebase's auth emulator).
// Either way, when config.auth.custom takes over a sign-in method, the functions for that
// method go to IceBase's own flow (your senders, your templates, your OAuth client) and end
// with signInWithCustomToken — the session after login is a normal Firebase session.

import * as fa from 'firebase/auth';
import { emulatorOrigin, service, type IceBaseApp } from './app.ts';
import type { AnyConfig, ClaimsOf } from './config.ts';
import { IceBaseError } from './errors.ts';
import * as customClient from './internal/custom-auth/client.ts';
import { nativeWebApp } from './internal/firebase-web-app.ts';

export type User = fa.User;
export type UserCredential = fa.UserCredential;
export type AuthCredential = fa.AuthCredential;
export type ConfirmationResult = fa.ConfirmationResult;
export type ActionCodeSettings = fa.ActionCodeSettings;
export type Persistence = fa.Persistence;
export type NextOrObserver<T> = fa.NextOrObserver<T>;
export type Unsubscribe = fa.Unsubscribe;
export type ApplicationVerifier = fa.ApplicationVerifier;

export interface IdTokenResult<C = Record<string, unknown>> extends Omit<fa.IdTokenResult, 'claims'> {
  /** Standard claims plus your custom claims, typed from config.auth.claims. */
  claims: fa.ParsedToken & C;
}

/** Which sign-in methods IceBase has taken over (config.auth.custom). */
export interface CustomMethods {
  email: boolean;
  phone: boolean;
  google: boolean;
}

export class Auth<C = Record<string, unknown>> {
  /** @internal */ readonly __claims?: C;
  /** @internal */ readonly _custom: CustomMethods;
  constructor(
    readonly app: IceBaseApp,
    /** @internal the Firebase Auth instance underneath */ readonly _native: fa.Auth,
  ) {
    const custom = app.config.auth?.custom;
    this._custom = { email: !!custom?.email, phone: !!custom?.phone, google: !!custom?.google };
  }
  get currentUser(): User | null {
    return this._native.currentUser;
  }
  get languageCode(): string | null {
    return this._native.languageCode;
  }
  set languageCode(v: string | null) {
    this._native.languageCode = v;
  }
  get tenantId(): string | null {
    return this._native.tenantId;
  }
  get name(): string {
    return this.app.name;
  }
  /** Resolves once the persisted user (if any) has been restored. */
  authStateReady(): Promise<void> {
    return this._native.authStateReady();
  }
  useDeviceLanguage(): void {
    this._native.useDeviceLanguage();
  }
}

export function getAuth<Cfg extends AnyConfig>(app: IceBaseApp<Cfg>): Auth<ClaimsOf<Cfg>> {
  if (app.kind === 'admin') throw new IceBaseError('invalid-argument', 'This is an admin app: use getAdminAuth(app) from icebase/admin', { reason: 'config' });
  return service(app, 'auth', () => {
    const mode = app.modes.auth;
    const native = fa.getAuth(nativeWebApp(app));
    if (mode === 'emulator') fa.connectAuthEmulator(native, emulatorOrigin(app), { disableWarnings: true });
    return track(new Auth<ClaimsOf<Cfg>>(app, native));
  });
}

/** Point a client Auth at the official Firebase auth emulator (firebase mode). */
export function connectAuthEmulator(auth: Auth<unknown>, url: string, options?: { disableWarnings: boolean }): void {
  fa.connectAuthEmulator(auth._native, url, options);
}

// ─── custom flows (filled in by the custom-auth client) ────────────────────────

/** @internal What the custom-auth client implements. Each returns what the Firebase function returns. */
export interface CustomFlows {
  sendSignInLinkToEmail(auth: Auth<unknown>, email: string, settings: ActionCodeSettings): Promise<void>;
  isSignInWithEmailLink(auth: Auth<unknown>, link: string): boolean;
  signInWithEmailLink(auth: Auth<unknown>, email: string, link?: string): Promise<UserCredential>;
  sendPasswordResetEmail(auth: Auth<unknown>, email: string, settings?: ActionCodeSettings): Promise<void>;
  verifyPasswordResetCode(auth: Auth<unknown>, code: string): Promise<string>;
  confirmPasswordReset(auth: Auth<unknown>, code: string, newPassword: string): Promise<void>;
  sendEmailVerification(user: User, settings?: ActionCodeSettings | null): Promise<void>;
  applyActionCode(auth: Auth<unknown>, code: string): Promise<void>;
  signInWithPhoneNumber(auth: Auth<unknown>, phoneNumber: string, verifier?: ApplicationVerifier): Promise<ConfirmationResult>;
  signInWithGoogle(auth: Auth<unknown>, how: 'popup' | 'redirect', provider: fa.GoogleAuthProvider): Promise<UserCredential | never>;
  getRedirectResult(auth: Auth<unknown>): Promise<UserCredential | null>;
}

let flows: CustomFlows | null = null;
/** @internal */
export function registerCustomFlows(f: CustomFlows): void {
  flows = f;
}
const custom = (method: keyof CustomMethods): CustomFlows => {
  if (!flows) throw new IceBaseError('failed-precondition', `config.auth.custom.${method} is set but the custom-auth client is not loaded`, { reason: 'config', service: 'auth' });
  return flows;
};
const authOfUser = (user: User): Auth<unknown> | undefined => {
  for (const a of authInstances) if (a._native === (user as unknown as { auth: fa.Auth }).auth) return a;
  return undefined;
};
const authInstances = new Set<Auth<unknown>>();
const track = <A extends Auth<unknown>>(a: A): A => {
  authInstances.add(a);
  return a;
};

// ─── state ─────────────────────────────────────────────────────────────────────

export const browserLocalPersistence = fa.browserLocalPersistence;
export const browserSessionPersistence = fa.browserSessionPersistence;
export const indexedDBLocalPersistence = fa.indexedDBLocalPersistence;
export const inMemoryPersistence = fa.inMemoryPersistence;

export function setPersistence(auth: Auth<unknown>, persistence: Persistence): Promise<void> {
  return fa.setPersistence(track(auth)._native, persistence);
}
export function onAuthStateChanged(auth: Auth<unknown>, next: NextOrObserver<User | null>, error?: fa.ErrorFn, completed?: fa.CompleteFn): Unsubscribe {
  return fa.onAuthStateChanged(track(auth)._native, next, error, completed);
}
export function onIdTokenChanged(auth: Auth<unknown>, next: NextOrObserver<User | null>, error?: fa.ErrorFn, completed?: fa.CompleteFn): Unsubscribe {
  return fa.onIdTokenChanged(track(auth)._native, next, error, completed);
}
export function signOut(auth: Auth<unknown>): Promise<void> {
  return fa.signOut(auth._native);
}

// ─── email + password (always Firebase; no email is sent) ──────────────────────

export function createUserWithEmailAndPassword(auth: Auth<unknown>, email: string, password: string): Promise<UserCredential> {
  return fa.createUserWithEmailAndPassword(track(auth)._native, email, password);
}
export function signInWithEmailAndPassword(auth: Auth<unknown>, email: string, password: string): Promise<UserCredential> {
  return fa.signInWithEmailAndPassword(track(auth)._native, email, password);
}
export function updatePassword(user: User, newPassword: string): Promise<void> {
  return fa.updatePassword(user, newPassword);
}
export function reauthenticateWithCredential(user: User, credential: AuthCredential): Promise<UserCredential> {
  return fa.reauthenticateWithCredential(user, credential);
}
export const EmailAuthProvider = fa.EmailAuthProvider;

// ─── emails IceBase may take over ──────────────────────────────────────────────

export function sendPasswordResetEmail(auth: Auth<unknown>, email: string, settings?: ActionCodeSettings): Promise<void> {
  return auth._custom.email ? custom('email').sendPasswordResetEmail(track(auth), email, settings) : fa.sendPasswordResetEmail(auth._native, email, settings);
}
export function verifyPasswordResetCode(auth: Auth<unknown>, code: string): Promise<string> {
  return auth._custom.email ? custom('email').verifyPasswordResetCode(track(auth), code) : fa.verifyPasswordResetCode(auth._native, code);
}
export function confirmPasswordReset(auth: Auth<unknown>, code: string, newPassword: string): Promise<void> {
  return auth._custom.email ? custom('email').confirmPasswordReset(track(auth), code, newPassword) : fa.confirmPasswordReset(auth._native, code, newPassword);
}
export function sendEmailVerification(user: User, settings?: ActionCodeSettings | null): Promise<void> {
  const auth = authOfUser(user);
  return auth?._custom.email ? custom('email').sendEmailVerification(user, settings) : fa.sendEmailVerification(user, settings);
}
export function applyActionCode(auth: Auth<unknown>, code: string): Promise<void> {
  return auth._custom.email ? custom('email').applyActionCode(track(auth), code) : fa.applyActionCode(auth._native, code);
}
export function verifyBeforeUpdateEmail(user: User, newEmail: string, settings?: ActionCodeSettings | null): Promise<void> {
  if (authOfUser(user)?._custom.email) throw new IceBaseError('unimplemented', 'verifyBeforeUpdateEmail with custom email auth: link the new address with customEmailAuth(auth).link(…)', { reason: 'not-in-scope', service: 'auth' });
  return fa.verifyBeforeUpdateEmail(user, newEmail, settings);
}

// ─── email link (passwordless) ─────────────────────────────────────────────────

export function sendSignInLinkToEmail(auth: Auth<unknown>, email: string, settings: ActionCodeSettings): Promise<void> {
  return auth._custom.email ? custom('email').sendSignInLinkToEmail(track(auth), email, settings) : fa.sendSignInLinkToEmail(auth._native, email, settings);
}
export function isSignInWithEmailLink(auth: Auth<unknown>, link: string): boolean {
  return auth._custom.email ? custom('email').isSignInWithEmailLink(auth, link) : fa.isSignInWithEmailLink(auth._native, link);
}
export function signInWithEmailLink(auth: Auth<unknown>, email: string, link?: string): Promise<UserCredential> {
  return auth._custom.email ? custom('email').signInWithEmailLink(track(auth), email, link) : fa.signInWithEmailLink(auth._native, email, link);
}

// ─── phone ─────────────────────────────────────────────────────────────────────

/** Same as Firebase's. With custom phone auth it is optional and never rendered. */
export class RecaptchaVerifier extends fa.RecaptchaVerifier {
  constructor(auth: Auth<unknown>, container: HTMLElement | string, parameters?: fa.RecaptchaParameters) {
    super(auth._native, container, parameters);
  }
}

export function signInWithPhoneNumber(auth: Auth<unknown>, phoneNumber: string, verifier?: ApplicationVerifier): Promise<ConfirmationResult> {
  if (auth._custom.phone) return custom('phone').signInWithPhoneNumber(track(auth), phoneNumber, verifier);
  if (!verifier) throw new IceBaseError('invalid-argument', 'signInWithPhoneNumber(auth, phone, verifier): Firebase phone auth needs a RecaptchaVerifier (or set config.auth.custom.phone)', { service: 'auth' });
  return fa.signInWithPhoneNumber(auth._native, phoneNumber, verifier);
}

// ─── Google ────────────────────────────────────────────────────────────────────

export const GoogleAuthProvider = fa.GoogleAuthProvider;
export type GoogleAuthProvider = fa.GoogleAuthProvider;
export type AuthProvider = fa.AuthProvider;

const isGoogle = (p: AuthProvider) => p.providerId === 'google.com';

export function signInWithPopup(auth: Auth<unknown>, provider: AuthProvider, resolver?: fa.PopupRedirectResolver): Promise<UserCredential> {
  if (auth._custom.google && isGoogle(provider)) return custom('google').signInWithGoogle(track(auth), 'popup', provider as fa.GoogleAuthProvider) as Promise<UserCredential>;
  return fa.signInWithPopup(track(auth)._native, provider, resolver);
}
export function signInWithRedirect(auth: Auth<unknown>, provider: AuthProvider, resolver?: fa.PopupRedirectResolver): Promise<never> {
  if (auth._custom.google && isGoogle(provider)) return custom('google').signInWithGoogle(track(auth), 'redirect', provider as fa.GoogleAuthProvider) as Promise<never>;
  return fa.signInWithRedirect(track(auth)._native, provider, resolver);
}
export function getRedirectResult(auth: Auth<unknown>, resolver?: fa.PopupRedirectResolver): Promise<UserCredential | null> {
  if (auth._custom.google) return custom('google').getRedirectResult(track(auth));
  return fa.getRedirectResult(track(auth)._native, resolver);
}
export function signInWithCredential(auth: Auth<unknown>, credential: AuthCredential): Promise<UserCredential> {
  return fa.signInWithCredential(track(auth)._native, credential);
}
export function linkWithCredential(user: User, credential: AuthCredential): Promise<UserCredential> {
  return fa.linkWithCredential(user, credential);
}

// ─── other sign-in ─────────────────────────────────────────────────────────────

export function signInAnonymously(auth: Auth<unknown>): Promise<UserCredential> {
  return fa.signInAnonymously(track(auth)._native);
}
export function signInWithCustomToken(auth: Auth<unknown>, token: string): Promise<UserCredential> {
  return fa.signInWithCustomToken(track(auth)._native, token);
}

// ─── the user ──────────────────────────────────────────────────────────────────

export function updateProfile(user: User, profile: { displayName?: string | null; photoURL?: string | null }): Promise<void> {
  return fa.updateProfile(user, profile);
}
export function updateEmail(user: User, newEmail: string): Promise<void> {
  return fa.updateEmail(user, newEmail);
}
export function deleteUser(user: User): Promise<void> {
  return fa.deleteUser(user);
}
export function reload(user: User): Promise<void> {
  return fa.reload(user);
}
export function getIdToken(user: User, forceRefresh?: boolean): Promise<string> {
  return fa.getIdToken(user, forceRefresh);
}
/** Typed claims: getIdTokenResult(auth.currentUser) on an Auth from a config with auth.claims. */
export function getIdTokenResult<C = Record<string, unknown>>(user: User, forceRefresh?: boolean): Promise<IdTokenResult<C>> {
  return fa.getIdTokenResult(user, forceRefresh) as Promise<IdTokenResult<C>>;
}

export { AuthErrorCodes } from 'firebase/auth';

// ─── custom auth: the client, and APIs Firebase has no shape for ─────────────────

registerCustomFlows(customClient.flows);
customClient.setAuthLookup((u) => {
  const a = authOfUser(u);
  if (!a) throw new IceBaseError('invalid-argument', 'This user does not belong to an IceBase Auth', { service: 'auth' });
  return a;
});

export type { ApprovalState, PendingEmail } from './internal/custom-auth/client.ts';

const needCustom = (auth: Auth<unknown>, m: keyof CustomMethods) => {
  if (!auth._custom[m]) throw new IceBaseError('failed-precondition', `config.auth.custom.${m} is not set`, { reason: 'config', service: 'auth' });
};

/** customEmailAuth(auth): the custom email sign-in, step by step. */
export interface CustomEmailAuth {
  /** Send the approval mail, sign-in link or code. `continueUrl` is where a sign-in link lands. */
  start(email: string, opts?: { continueUrl?: string }): Promise<customClient.PendingEmail>;
  /** The sign-in started in this tab and not finished yet, if any. */
  pending(): customClient.PendingEmail | null;
  /** Approval mode: resolves signed in once the email's button is pressed. */
  waitForApproval(opts?: { onState?: (s: customClient.ApprovalState) => void; signal?: AbortSignal }): Promise<UserCredential>;
  /** Code mode: sign in with the emailed code. */
  verifyCode(code: string): Promise<UserCredential>;
  cancel(): Promise<void>;
}
/** customPhoneAuth(auth): the custom phone sign-in. */
export interface CustomPhoneAuth {
  start(phoneNumber: string): Promise<ConfirmationResult>;
}
/** customGoogleOAuth(auth): Google sign-in with your own OAuth client. */
export interface CustomGoogleOAuth {
  signInWithPopup(): Promise<UserCredential>;
  signInWithRedirect(): Promise<never>;
  getRedirectResult(): Promise<UserCredential | null>;
}

/** Custom email sign-in, step by step (approval / link / code — config.auth.custom.email.signIn). */
export function customEmailAuth(auth: Auth<unknown>): CustomEmailAuth {
  needCustom(auth, 'email');
  const a = track(auth);
  return {
    /** Send the approval mail, sign-in link or code. `continueUrl` is where a sign-in link lands. */
    start: (email: string, opts: { continueUrl?: string } = {}) => customClient.startEmail(a, email, opts.continueUrl),
    /** The sign-in started in this tab and not finished yet, if any. */
    pending: () => customClient.pendingOf(a),
    /** Approval mode: resolves signed in once the email's button is pressed. */
    waitForApproval: (opts?: { onState?: (s: customClient.ApprovalState) => void; signal?: AbortSignal }) => customClient.waitForApproval(a, opts),
    /** Code mode: sign in with the emailed code. */
    verifyCode: (code: string) => customClient.verifyEmailCode(a, code),
    cancel: () => customClient.cancelEmail(a),
  };
}

/** Approval mode: wait for the button in the email (after sendSignInLinkToEmail). */
export function waitForEmailApproval(auth: Auth<unknown>, opts?: { onState?: (s: customClient.ApprovalState) => void; signal?: AbortSignal }): Promise<UserCredential> {
  needCustom(auth, 'email');
  return customClient.waitForApproval(track(auth), opts);
}

/** Custom phone sign-in: the code goes over your WhatsApp / SMS sender. */
export function customPhoneAuth(auth: Auth<unknown>): CustomPhoneAuth {
  needCustom(auth, 'phone');
  const a = track(auth);
  return { start: (phoneNumber: string) => customClient.flows.signInWithPhoneNumber(a, phoneNumber) };
}

/** Custom Google sign-in with your own OAuth client. */
export function customGoogleOAuth(auth: Auth<unknown>): CustomGoogleOAuth {
  needCustom(auth, 'google');
  const a = track(auth);
  return {
    signInWithPopup: () => customClient.googlePopup(a),
    signInWithRedirect: () => customClient.googleRedirect(a),
    getRedirectResult: () => customClient.googleRedirectResult(a),
  };
}
