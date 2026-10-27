// The Auth conformance suite: client SDK wrapper + typed admin, against Firebase's auth
// emulator and the IceBase emulator.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, type IceBaseApp } from '@panth977/icebase/app';
import { getAdminAuth } from '@panth977/icebase-server/admin';
import {
  createUserWithEmailAndPassword,
  getAuth,
  getIdTokenResult,
  isSignInWithEmailLink,
  onAuthStateChanged,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInAnonymously,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signOut,
  updateProfile,
  confirmPasswordReset,
  EmailAuthProvider,
  GoogleAuthProvider,
  inMemoryPersistence,
  linkWithCredential,
  onIdTokenChanged,
  reauthenticateWithCredential,
  setPersistence,
  signInWithCredential,
  updateEmail,
  updatePassword,
  type Auth,
} from '@panth977/icebase/auth';
import { defineConfig, type Mode } from '@panth977/icebase/config';
import { defineSchema, f } from '@panth977/icebase/schema';

export const authConfig = (mode: Mode, port?: number) =>
  defineConfig({
  name: 'auth-test',
  schema: defineSchema({}),
  auth: { providers: ['password', 'emailLink', 'anonymous'], claims: { role: f.enum(['admin', 'member']), shop: f.optional(f.string()) } },
  firebase: { projectId: 'demo-icebase' },
  ...(port ? { emulator: { port } } : {}),
  environments: { test: { mode } },
});

const oobOf = (origin: string) => async (email: string, type: 'PASSWORD_RESET' | 'EMAIL_SIGNIN') => {
  const r = (await (await fetch(`${origin}/emulator/v1/projects/demo-icebase/oobCodes`)).json()) as { oobCodes: { email: string; requestType: string; oobCode: string; oobLink: string }[] };
  return r.oobCodes.filter((c) => c.email === email && c.requestType === type).pop()!;
};

type Cfg = ReturnType<typeof authConfig>;
export interface AuthSetup {
  app: IceBaseApp<Cfg>;
  admin: IceBaseApp<Cfg>;
  /** Where the emulator's /emulator/v1 endpoints are. */
  origin: string;
  /** firebase mode: connectAuthEmulator; emulator mode: nothing (getAuth connects itself). */
  connect(auth: Auth<any>): void;
  close?(): Promise<void>;
}

export function authSuite(name: string, setup: () => Promise<AuthSetup>): void {
describe(`auth · ${name}`, () => {
  let app: IceBaseApp<Cfg>;
  let admin: IceBaseApp<Cfg>;
  let oob: ReturnType<typeof oobOf>;
  let s: AuthSetup;
  let auth: Auth<{ role?: 'admin' | 'member'; shop?: string }>;
  const email = `u${Date.now()}@example.com`;

  beforeAll(async () => {
    s = await setup();
    app = s.app;
    admin = s.admin;
    oob = oobOf(s.origin);
    auth = getAuth(app);
    s.connect(auth);
  });
  afterAll(async () => {
    await deleteApp(app);
    await deleteApp(admin);
    await s.close?.();
  });

  it('creates, signs out and signs in with email + password', async () => {
    const states: (string | null)[] = [];
    const un = onAuthStateChanged(auth, (u) => states.push(u?.uid ?? null));
    const cred = await createUserWithEmailAndPassword(auth, email, 'secret123');
    await updateProfile(cred.user, { displayName: 'Uma' });
    await signOut(auth);
    expect(auth.currentUser).toBeNull();
    const again = await signInWithEmailAndPassword(auth, email, 'secret123');
    expect(again.user.uid).toBe(cred.user.uid);
    expect(again.user.displayName).toBe('Uma');
    un();
    expect(states).toContain(cred.user.uid);
  });

  it('sets typed custom claims from admin and reads them on the client', async () => {
    const adminAuth = getAdminAuth(admin);
    const uid = auth.currentUser!.uid;
    await adminAuth.setCustomUserClaims(uid, { role: 'admin', shop: 's1' });
    // @ts-expect-error 'owner' is not a declared role
    await expect(adminAuth.setCustomUserClaims(uid, { role: 'owner' })).rejects.toThrow(/role: expected "admin" \| "member"/);
    const t = await getIdTokenResult<{ role: 'admin' | 'member' }>(auth.currentUser!, true);
    expect(t.claims.role).toBe('admin');
    expect((await adminAuth.getUser(uid)).customClaims).toEqual({ role: 'admin', shop: 's1' });
  });

  it('enables / disables a user (admin updateUser disabled)', async () => {
    const adminAuth = getAdminAuth(admin);
    const uid = auth.currentUser!.uid;
    await signOut(auth);
    await adminAuth.updateUser(uid, { disabled: true });
    await expect(signInWithEmailAndPassword(auth, email, 'secret123')).rejects.toMatchObject({ code: 'auth/user-disabled' });
    await adminAuth.updateUser(uid, { disabled: false });
    await signInWithEmailAndPassword(auth, email, 'secret123');
    await adminAuth.revokeRefreshTokens(uid);
    expect((await adminAuth.getUser(uid)).tokensValidAfterTime).toBeTruthy();
  });

  it('password reset through Firebase (no custom email configured)', async () => {
    await sendPasswordResetEmail(auth, email);
    const code = await oob(email, 'PASSWORD_RESET');
    await confirmPasswordReset(auth, code.oobCode, 'newsecret1');
    await signOut(auth);
    await signInWithEmailAndPassword(auth, email, 'newsecret1');
  });

  it('email link sign-in through Firebase', async () => {
    const e2 = `link${Date.now()}@example.com`;
    await sendSignInLinkToEmail(auth, e2, { url: 'http://localhost/finish', handleCodeInApp: true });
    const link = (await oob(e2, 'EMAIL_SIGNIN')).oobLink;
    expect(isSignInWithEmailLink(auth, link)).toBe(true);
    const cred = await signInWithEmailLink(auth, e2, link);
    expect(cred.user.email).toBe(e2);
  });

  it('custom token and anonymous sign-in', async () => {
    const token = await getAdminAuth(admin).createCustomToken('custom-uid-1', { role: 'member' });
    const c = await signInWithCustomToken(auth, token);
    expect(c.user.uid).toBe('custom-uid-1');
    const a = await signInAnonymously(auth);
    expect(a.user.isAnonymous).toBe(true);
  });

  it('admin: users by email and phone number, and the whole list', async () => {
    const adminAuth = getAdminAuth(admin);
    const email = `look-${Date.now()}@example.com`;
    const u = await adminAuth.createUser({ email, phoneNumber: `+1555${String(Date.now()).slice(-7)}`, displayName: 'Look' });
    expect((await adminAuth.getUserByEmail(email)).uid).toBe(u.uid);
    expect((await adminAuth.getUserByPhoneNumber(u.phoneNumber!)).uid).toBe(u.uid);
    await expect(adminAuth.getUserByEmail(`none-${Date.now()}@example.com`)).rejects.toMatchObject({ code: 'auth/user-not-found' });
    const page = await adminAuth.listUsers(1000);
    expect(page.users.some((x) => x.uid === u.uid)).toBe(true);
  });

  it('admin: action links — sign-in, password reset and verification — work in the client', async () => {
    const adminAuth = getAdminAuth(admin);
    const email = `links-${Date.now()}@example.com`;
    await adminAuth.createUser({ email, password: 'secret12' });
    const signIn = await adminAuth.generateSignInWithEmailLink(email, { url: 'http://localhost/finish', handleCodeInApp: true });
    expect(isSignInWithEmailLink(auth, signIn)).toBe(true);
    expect((await signInWithEmailLink(auth, email, signIn)).user.email).toBe(email);
    await signOut(auth);
    const reset = await adminAuth.generatePasswordResetLink(email);
    await confirmPasswordReset(auth, new URL(reset).searchParams.get('oobCode')!, 'newpass12');
    expect((await signInWithEmailAndPassword(auth, email, 'newpass12')).user.email).toBe(email);
    const verify = await adminAuth.generateEmailVerificationLink(email);
    expect(new URL(verify).searchParams.get('mode')).toBe('verifyEmail');
    await signOut(auth);
  });

  it('client: persistence, onIdTokenChanged, update and re-authenticate the password, change the email', async () => {
    await setPersistence(auth, inMemoryPersistence);
    const email = `client-${Date.now()}@example.com`;
    const seen: (string | null)[] = [];
    const off = onIdTokenChanged(auth, (u) => void seen.push(u?.email ?? null));
    const { user } = await createUserWithEmailAndPassword(auth, email, 'first123');
    await updatePassword(user, 'second123');
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(email, 'second123'));
    await expect(reauthenticateWithCredential(user, EmailAuthProvider.credential(email, 'first123'))).rejects.toBeTruthy();
    const next = `client2-${Date.now()}@example.com`;
    await updateEmail(user, next);
    expect(auth.currentUser?.email).toBe(next);
    off();
    expect(seen).toContain(email);
    await signOut(auth);
  });

  it('anonymous upgrade: linkWithCredential keeps the uid', async () => {
    const anon = await signInAnonymously(auth);
    const email = `upgrade-${Date.now()}@example.com`;
    const linked = await linkWithCredential(anon.user, EmailAuthProvider.credential(email, 'upgrade1'));
    expect(linked.user.uid).toBe(anon.user.uid);
    expect(linked.user.isAnonymous).toBe(false);
    await signOut(auth);
    expect((await signInWithEmailAndPassword(auth, email, 'upgrade1')).user.uid).toBe(anon.user.uid);
    await signOut(auth);
  });

  it('Google: signInWithCredential with an ID token (the emulators take an unsigned one), same uid next time', async () => {
    const sub = `g-${Date.now()}`;
    const idToken = JSON.stringify({ sub, email: `${sub}@gmail.com`, email_verified: true, name: 'G User' });
    const first = await signInWithCredential(auth, GoogleAuthProvider.credential(idToken));
    expect(first.user.email).toBe(`${sub}@gmail.com`);
    expect(first.user.providerData.map((p) => p.providerId)).toContain('google.com');
    await signOut(auth);
    expect((await signInWithCredential(auth, GoogleAuthProvider.credential(idToken))).user.uid).toBe(first.user.uid);
    await signOut(auth);
  });
});
}
