// Custom auth end to end, firebase mode: the IceBase handler on a local port, Firebase Auth
// and the Realtime Database on the official emulators, the client SDK in between.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '@panth977/icebase/app';
import { getAdminAuth, initializeAdminApp } from '@panth977/icebase-server/admin';
import {
  applyActionCode,
  confirmPasswordReset,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  customEmailAuth,
  getAuth,
  isSignInWithEmailLink,
  sendEmailVerification,
  sendPasswordResetEmail,
  sendSignInLinkToEmail,
  signInWithEmailAndPassword,
  signInWithEmailLink,
  signInWithPhoneNumber,
  signOut,
  verifyPasswordResetCode,
  waitForEmailApproval,
  type Auth,
} from '@panth977/icebase/auth';
import { createAuthHandler, customAuthDatabaseRules, getAuthSecurity, linkCustomIdentity, unlinkCustomIdentity, type EmailMessage, type PhoneMessage } from '@panth977/icebase-server/auth';
import { defineConfig, type CustomAuthConfig } from '@panth977/icebase/config';
import { serve } from '@panth977/icebase-server/internal';
import { defineSchema } from '@panth977/icebase/schema';

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (!AUTH_HOST || !DB_HOST) throw new Error('run under scripts/emu.sh with auth and database');
const PROJECT = 'demo-icebase';

const mails: EmailMessage[] = [];
const texts: PhoneMessage[] = [];
const lastMail = (to: string) => mails.filter((m) => m.to === to).pop()!;
const param = (link: string, k: string) => new URL(link).searchParams.get(k)!;

/** One handler + one client app per email sign-in mode. */
async function rig(name: string, email: CustomAuthConfig['email'], extra: Partial<CustomAuthConfig> = {}) {
  const srv = await serve(async (req) => handler(req));
  const config = defineConfig({
    name: `custom-${name}`,
    schema: defineSchema({}),
    auth: {
      providers: ['password', 'emailLink', 'phone'],
      custom: {
        endpoint: srv.url,
        site: 'Acme Shop',
        email,
        phone: { sender: 'handler' },
        security: { store: { path: `_icebase/auth-${name}` }, limits: { perIdentifier: { perHour: 4 } }, challenge: { maxAttempts: 3 } },
        ...extra,
      },
    },
    firebase: { projectId: PROJECT, databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com` },
    environments: { test: { mode: 'firebase' } },
  });
  const admin = initializeAdminApp(config, 'test', { name: `admin-${name}` });
  const handler = createAuthHandler(config, 'test', { app: admin, senders: { email: async (m) => void mails.push(m), phone: async (m) => void texts.push(m) } });
  // The client's own Firebase config has no databaseURL, so approval waits by polling.
  const client = initializeApp(config, 'test', { name: `web-${name}`, firebase: { apiKey: 'demo', projectId: PROJECT } });
  const auth = getAuth(client);
  connectAuthEmulator(auth, `http://${AUTH_HOST}`, { disableWarnings: true });
  return { srv, admin, client, auth, adminAuth: getAdminAuth(admin), config };
}

describe('custom auth · firebase mode', () => {
  let link: Awaited<ReturnType<typeof rig>>;
  let code: Awaited<ReturnType<typeof rig>>;
  let approval: Awaited<ReturnType<typeof rig>>;
  const apps: IceBaseApp[] = [];

  beforeAll(async () => {
    link = await rig('link', { sender: 'handler', signIn: 'link' });
    code = await rig('code', { sender: 'handler', signIn: 'code' });
    approval = await rig('approval', { sender: 'handler', signIn: 'approval' });
    for (const r of [link, code, approval]) apps.push(r.admin, r.client);
  });
  afterAll(async () => {
    for (const r of [link, code, approval]) await r.srv.close();
    for (const a of apps) await deleteApp(a);
  });

  it('email link: the standard Firebase calls, but our sender and template', async () => {
    const email = `link-${Date.now()}@example.com`;
    await sendSignInLinkToEmail(link.auth, email, { url: 'http://localhost:5173/finish', handleCodeInApp: true });
    const m = lastMail(email);
    expect(m.kind).toBe('signIn');
    expect(m.rendered.subject).toBe('Your sign-in link for Acme Shop');
    expect(isSignInWithEmailLink(link.auth, m.link!)).toBe(true);
    const cred = await signInWithEmailLink(link.auth, email, m.link!);
    expect(cred.user.email).toBe(email);
    expect(cred.user.emailVerified).toBe(true);
    // Single use.
    await expect(signInWithEmailLink(link.auth, email, m.link!)).rejects.toMatchObject({ code: 'auth/invalid-action-code' });
    // Same uid next time.
    await sendSignInLinkToEmail(link.auth, email, { url: 'http://localhost:5173/finish', handleCodeInApp: true });
    expect((await signInWithEmailLink(link.auth, email, lastMail(email).link!)).user.uid).toBe(cred.user.uid);
  });

  it('refuses a continue URL outside the authorized domains', async () => {
    await expect(sendSignInLinkToEmail(link.auth, 'x@example.com', { url: 'https://evil.example/x', handleCodeInApp: true })).rejects.toMatchObject({ code: 'auth/unauthorized-domain' });
  });

  it('rate-limits per address', async () => {
    const email = `rl-${Date.now()}@example.com`;
    for (let i = 0; i < 4; i++) await sendSignInLinkToEmail(link.auth, email, { url: 'http://localhost/x', handleCodeInApp: true });
    await expect(sendSignInLinkToEmail(link.auth, email, { url: 'http://localhost/x', handleCodeInApp: true })).rejects.toMatchObject({ code: 'auth/too-many-requests' });
  });

  it('email code: wrong codes are capped, the right one signs in', async () => {
    const email = `code-${Date.now()}@example.com`;
    const flow = customEmailAuth(code.auth);
    await flow.start(email);
    const c = lastMail(email).code!;
    expect(c).toMatch(/^\d{6}$/);
    const wrong = c === '000000' ? '111111' : '000000';
    await expect(flow.verifyCode(wrong)).rejects.toMatchObject({ code: 'auth/invalid-verification-code' });
    expect((await flow.verifyCode(c)).user.email).toBe(email);
    await flow.start(email);
    await expect(flow.verifyCode(wrong)).rejects.toMatchObject({ code: 'auth/invalid-verification-code' });
    await expect(flow.verifyCode(wrong)).rejects.toMatchObject({ code: 'auth/invalid-verification-code' });
    await expect(flow.verifyCode(wrong)).rejects.toMatchObject({ code: 'auth/too-many-requests' });
    await expect(flow.verifyCode(lastMail(email).code!)).rejects.toMatchObject({ code: 'auth/invalid-action-code' }); // burned
  });

  it('email approval: approve from the mail, the waiting tab signs in', async () => {
    const email = `ok-${Date.now()}@example.com`;
    await sendSignInLinkToEmail(approval.auth, email, { url: 'http://localhost/x', handleCodeInApp: true });
    const m = lastMail(email);
    expect(m.rendered.html).toContain('Review sign-in');
    const pageRes = await fetch(m.link!);
    expect(await pageRes.text()).toContain(`as <b>${email}</b>`);
    const states: string[] = [];
    const waiting = waitForEmailApproval(approval.auth, { onState: (s) => states.push(s) });
    await new Promise((r) => setTimeout(r, 300));
    const t = param(m.link!, 't');
    const r = await fetch(`${approval.srv.url}/email/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t }) });
    expect(await r.json()).toEqual({ state: 'approved' });
    const cred = await waiting;
    expect(cred.user.email).toBe(email);
    expect(states).toEqual(['pending', 'approved']);
  });

  it('email approval: the mailbox alone cannot collect the token', async () => {
    const email = `steal-${Date.now()}@example.com`;
    await customEmailAuth(approval.auth).start(email);
    const t = param(lastMail(email).link!, 't');
    await fetch(`${approval.srv.url}/email/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t }) });
    const signinId = t.split('.')[0];
    const r = await fetch(`${approval.srv.url}/email/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signinId, clientSecret: 'guess' }) });
    expect(r.status).toBe(403);
  });

  it('email approval: "this wasn\'t me" turns the device away for a while', async () => {
    const email = `no-${Date.now()}@example.com`;
    await customEmailAuth(approval.auth).start(email);
    const t = param(lastMail(email).link!, 't');
    const waiting = waitForEmailApproval(approval.auth);
    await fetch(`${approval.srv.url}/email/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t }) });
    await expect(waiting).rejects.toMatchObject({ code: 'auth/user-cancelled' });
    await expect(customEmailAuth(approval.auth).start(email)).rejects.toMatchObject({ code: 'auth/too-many-requests' });
  });

  it('password reset: our email, Firebase password', async () => {
    const email = `reset-${Date.now()}@example.com`;
    await createUserWithEmailAndPassword(link.auth, email, 'first-pw');
    await signOut(link.auth);
    await sendPasswordResetEmail(link.auth, email);
    const m = lastMail(email);
    expect(m.kind).toBe('passwordReset');
    expect(param(m.link!, 'mode')).toBe('resetPassword');
    const oob = param(m.link!, 'oobCode');
    expect(await verifyPasswordResetCode(link.auth, oob)).toBe(email);
    const pageHtml = await (await fetch(m.link!)).text();
    expect(pageHtml).toContain('Choose a new password');
    await confirmPasswordReset(link.auth, oob, 'second-pw');
    await signInWithEmailAndPassword(link.auth, email, 'second-pw');
    // No mail, and no difference in the answer, for an address without an account.
    const before = mails.length;
    await sendPasswordResetEmail(link.auth, `nobody-${Date.now()}@example.com`);
    expect(mails.length).toBe(before);
  });

  it('email verification: our email, Firebase flag', async () => {
    const email = `verify-${Date.now()}@example.com`;
    const cred = await createUserWithEmailAndPassword(link.auth, email, 'pw-123456');
    expect(cred.user.emailVerified).toBe(false);
    await sendEmailVerification(cred.user);
    const oob = param(lastMail(email).link!, 'oobCode');
    await applyActionCode(link.auth, oob);
    expect((await link.adminAuth.getUser(cred.user.uid)).emailVerified).toBe(true);
  });

  it('phone: the code goes through our sender, no reCAPTCHA', async () => {
    const phone = `+1555${String(Date.now()).slice(-7)}`;
    const confirmation = await signInWithPhoneNumber(link.auth, phone);
    const sms = texts.filter((t) => t.to === phone).pop()!;
    expect(sms.rendered.text).toContain('is your Acme Shop code');
    const cred = await confirmation.confirm(sms.code);
    expect(cred.user.phoneNumber).toBe(phone);
    await expect(signInWithPhoneNumber(link.auth, '12345')).rejects.toMatchObject({ code: 'auth/invalid-phone-number' });
  });

  it('refuses disabled users', async () => {
    const email = `off-${Date.now()}@example.com`;
    const u = await link.adminAuth.createUser({ email });
    await link.adminAuth.updateUser(u.uid, { disabled: true });
    await sendSignInLinkToEmail(link.auth, email, { url: 'http://localhost/x', handleCodeInApp: true });
    await expect(signInWithEmailLink(link.auth, email, lastMail(email).link!)).rejects.toMatchObject({ code: 'auth/user-disabled' });
  });

  it('admin: getAuthSecurity reads the audit trail and counters from the Realtime Database; resetLimits, unblock, cleanup', async () => {
    const email = `sec-${Date.now()}@example.com`;
    const flow = customEmailAuth(code.auth);
    await flow.start(email);
    await expect(flow.verifyCode('000000')).rejects.toBeTruthy();
    await flow.verifyCode(lastMail(email).code!);
    await signOut(code.auth);
    const sec = getAuthSecurity(code.admin);
    const a = await sec.listAttempts(email.toUpperCase());
    expect(a.attempts.map((e) => e.event)).toEqual(['signed-in', 'wrong-code', 'start']);
    expect(a.limits.map((l) => l.rule).sort()).toEqual(['id-day', 'id-hour']);
    expect((await sec.resetLimits(email)).removed).toBe(2);
    expect((await sec.listAttempts(email)).limits).toEqual([]);
    expect((await sec.unblock(email)).removed).toBe(0);
    expect((await sec.cleanup()).removed).toBeGreaterThanOrEqual(0);
  });

  it('admin: link a phone and a Google account to a user; unlink, never the last one', async () => {
    const u = await code.adminAuth.createUser({ email: `lk-${Date.now()}@example.com`, emailVerified: true });
    await linkCustomIdentity(code.admin, u.uid, { phone: '+919800000001' });
    expect((await code.adminAuth.getUser(u.uid)).phoneNumber).toBe('+919800000001');
    await linkCustomIdentity(code.admin, u.uid, { google: `sub-${u.uid}` });
    await unlinkCustomIdentity(code.admin, u.uid, 'phone');
    expect((await code.adminAuth.getUser(u.uid)).phoneNumber).toBeUndefined();
    await unlinkCustomIdentity(code.admin, u.uid, 'google');
    await expect(unlinkCustomIdentity(code.admin, u.uid, 'email')).rejects.toMatchObject({ code: 'auth/operation-not-allowed' });
  });

  it('generates database rules that hide the store', () => {
    expect(customAuthDatabaseRules(link.config)).toEqual({ _icebase: { 'auth-link': { '.read': false, '.write': false, signin: { $id: { '.read': true } } } } });
  });
});

describe('custom auth · Google with your own OAuth client', () => {
  let r: Awaited<ReturnType<typeof rig>>;
  beforeAll(async () => {
    process.env.TEST_GOOGLE_ID = 'cid.apps.googleusercontent.com';
    process.env.TEST_GOOGLE_SECRET = 'shh';
    r = await rig('google', { sender: 'handler' }, { google: { clientIdEnv: 'TEST_GOOGLE_ID', clientSecretEnv: 'TEST_GOOGLE_SECRET' } });
  });
  afterAll(async () => {
    await r.srv.close();
    await deleteApp(r.admin);
    await deleteApp(r.client);
    vi.unstubAllGlobals();
  });

  it('redirects to Google, exchanges the code, creates the user and hands back a token', async () => {
    const start = await fetch(`${r.srv.url}/google/start?mode=redirect&return=${encodeURIComponent('http://localhost:5173/app')}`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get('location')!);
    expect(to.origin).toBe('https://accounts.google.com');
    expect(to.searchParams.get('client_id')).toBe('cid.apps.googleusercontent.com');
    expect(to.searchParams.get('redirect_uri')).toBe(`${r.srv.url}/google/callback`);
    const state = to.searchParams.get('state')!;
    const nonce = to.searchParams.get('nonce')!;
    const sub = `g-${Date.now()}`;
    const email = `${sub}@gmail.com`;
    const idToken = ['x', Buffer.from(JSON.stringify({ iss: 'https://accounts.google.com', aud: 'cid.apps.googleusercontent.com', exp: Date.now() / 1000 + 600, nonce, sub, email, email_verified: true, name: 'Gee' })).toString('base64url'), 'sig'].join('.');
    // Only Google's token endpoint is faked; everything else is real.
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith('https://oauth2.googleapis.com/token') ? Promise.resolve(new Response(JSON.stringify({ id_token: idToken }))) : realFetch(input, init)));
    const cb = await realFetch(`${r.srv.url}/google/callback?code=abc&state=${state}`, { redirect: 'manual' });
    vi.unstubAllGlobals();
    expect(cb.status).toBe(302);
    const back = new URL(cb.headers.get('location')!);
    expect(back.origin + back.pathname).toBe('http://localhost:5173/app');
    const token = new URLSearchParams(back.hash.slice(1)).get('icebase_token')!;
    const { signInWithCustomToken } = await import('@panth977/icebase/auth');
    const cred = await signInWithCustomToken(r.auth, token);
    expect(cred.user.email).toBe(email);
    expect(cred.user.displayName).toBe('Gee');
    // The state is single use.
    const again = await realFetch(`${r.srv.url}/google/callback?code=abc&state=${state}`, { redirect: 'manual' });
    expect(again.status).toBe(400);
  });

  it('refuses a return URL outside the authorized domains', async () => {
    const res = await fetch(`${r.srv.url}/google/start?mode=popup&return=${encodeURIComponent('https://evil.example')}`, { redirect: 'manual' });
    expect(res.status).toBe(403);
  });
});

void ({} as Auth);
