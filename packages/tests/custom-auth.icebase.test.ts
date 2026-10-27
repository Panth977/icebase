// Custom auth in emulator mode: the handler mounted on the IceBase server, users in its auth
// service, messages through the console sender (read back from the outbox).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '@panth977/icebase/app';
import { customEmailAuth, getAuth, isSignInWithEmailLink, sendPasswordResetEmail, sendSignInLinkToEmail, signInWithEmailAndPassword, signInWithEmailLink, signInWithPhoneNumber, waitForEmailApproval, createUserWithEmailAndPassword, signOut, confirmPasswordReset } from '@panth977/icebase/auth';
import { defineConfig, senders } from '@panth977/icebase/config';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';
import { defineSchema } from '@panth977/icebase/schema';

const make = (signIn: 'link' | 'approval', port?: number) =>
  defineConfig({
    name: 'custom-emu',
    schema: defineSchema({}),
    auth: { providers: ['password', 'emailLink', 'phone'], custom: { site: 'Acme', email: { sender: senders.console(), signIn }, phone: { sender: senders.console() } } },
    firebase: { projectId: 'demo-icebase' },
    ...(port ? { emulator: { port } } : {}),
    environments: { local: { mode: 'emulator' } },
  });

type Out = { channel: string; to: string; link?: string; code?: string; subject?: string };
const outbox = async (emu: RunningEmulator) => ((await (await fetch(`${emu.url}/__/icebase/auth/outbox`, { headers: { authorization: 'Bearer owner' } })).json()) as { messages: Out[] }).messages;
const last = async (emu: RunningEmulator, to: string) => (await outbox(emu)).filter((m) => m.to === to).pop()!;

for (const mode of ['link', 'approval'] as const) {
  describe(`custom auth · emulator mode · email ${mode}`, () => {
    let emu: RunningEmulator;
    let app: IceBaseApp;
    beforeAll(async () => {
      emu = await startEmulator({ config: make(mode), env: 'local', port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
      app = initializeApp(make(mode, emu.port), 'local', { name: `ce-${mode}`, firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
    });
    afterAll(async () => {
      await deleteApp(app);
      await emu.close();
    });

    it('email sign-in', async () => {
      const auth = getAuth(app);
      const email = `${mode}-${Date.now()}@example.com`;
      await sendSignInLinkToEmail(auth, email, { url: 'http://localhost:5173/done', handleCodeInApp: true });
      const m = await last(emu, email);
      if (mode === 'link') {
        expect(isSignInWithEmailLink(auth, m.link!)).toBe(true);
        expect((await signInWithEmailLink(auth, email, m.link!)).user.email).toBe(email);
      } else {
        const waiting = waitForEmailApproval(auth);
        const t = new URL(m.link!).searchParams.get('t');
        await fetch(`${emu.url}/__/icebase/auth/email/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t }) });
        expect((await waiting).user.email).toBe(email);
        expect(customEmailAuth(auth).pending()).toBeNull();
      }
    });

    if (mode === 'link') {
      it('phone sign-in without reCAPTCHA', async () => {
        const auth = getAuth(app);
        const phone = `+1555${String(Date.now()).slice(-7)}`;
        const c = await signInWithPhoneNumber(auth, phone);
        const m = await last(emu, phone);
        expect((await c.confirm(m.code!)).user.phoneNumber).toBe(phone);
      });

      it('password reset with our email, Firebase-shaped action link', async () => {
        const auth = getAuth(app);
        const email = `reset-${Date.now()}@example.com`;
        await createUserWithEmailAndPassword(auth, email, 'first-pw');
        await signOut(auth);
        await sendPasswordResetEmail(auth, email);
        const link = new URL((await last(emu, email)).link!);
        expect(link.pathname).toBe('/__/icebase/auth/action');
        await confirmPasswordReset(auth, link.searchParams.get('oobCode')!, 'second-pw');
        expect((await signInWithEmailAndPassword(auth, email, 'second-pw')).user.email).toBe(email);
      });
    }
  });
}

describe('custom auth · Google with your own OAuth client · emulator mode', () => {
  let emu: RunningEmulator;
  let app: IceBaseApp;
  const cfg = (port?: number) =>
    defineConfig({
      name: 'custom-google',
      schema: defineSchema({}),
      auth: { providers: [], custom: { site: 'Acme', google: { clientIdEnv: 'ICE_TEST_GOOGLE_ID', clientSecretEnv: 'ICE_TEST_GOOGLE_SECRET' } } },
      firebase: { projectId: 'demo-icebase' },
      ...(port ? { emulator: { port } } : {}),
      environments: { local: { mode: 'emulator' } },
    });
  beforeAll(async () => {
    process.env.ICE_TEST_GOOGLE_ID = 'cid.apps.googleusercontent.com';
    process.env.ICE_TEST_GOOGLE_SECRET = 'shh';
    emu = await startEmulator({ config: cfg(), env: 'local', port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
    app = initializeApp(cfg(emu.port), 'local', { name: 'cg', firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await deleteApp(app);
    await emu.close();
  });

  it('redirects to Google, exchanges the code, creates the user (same uid next time) and hands back a token', async () => {
    const base = `${emu.url}/__/icebase/auth`;
    const signInOnce = async (sub: string) => {
      const start = await fetch(`${base}/google/start?mode=redirect&return=${encodeURIComponent('http://localhost:5173/app')}`, { redirect: 'manual' });
      expect(start.status).toBe(302);
      const to = new URL(start.headers.get('location')!);
      expect(to.origin).toBe('https://accounts.google.com');
      expect(to.searchParams.get('redirect_uri')).toBe(`${base}/google/callback`);
      const claims = { iss: 'https://accounts.google.com', aud: 'cid.apps.googleusercontent.com', exp: Date.now() / 1000 + 600, nonce: to.searchParams.get('nonce'), sub, email: `${sub}@gmail.com`, email_verified: true, name: 'Gee' };
      const idToken = ['x', Buffer.from(JSON.stringify(claims)).toString('base64url'), 'sig'].join('.');
      // Only Google's token endpoint is faked (the handler runs in this process).
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith('https://oauth2.googleapis.com/token') ? Promise.resolve(new Response(JSON.stringify({ id_token: idToken }))) : realFetch(input, init)));
      const cb = await realFetch(`${base}/google/callback?code=abc&state=${to.searchParams.get('state')}`, { redirect: 'manual' });
      vi.unstubAllGlobals();
      expect(cb.status).toBe(302);
      const token = new URLSearchParams(new URL(cb.headers.get('location')!).hash.slice(1)).get('icebase_token')!;
      const { signInWithCustomToken } = await import('@panth977/icebase/auth');
      const cred = await signInWithCustomToken(getAuth(app), token);
      await signOut(getAuth(app));
      return cred.user;
    };
    const sub = `g-${Date.now()}`;
    const first = await signInOnce(sub);
    expect(first.email).toBe(`${sub}@gmail.com`);
    expect(first.displayName).toBe('Gee');
    expect((await signInOnce(sub)).uid).toBe(first.uid);
  });

  it('refuses a return URL outside the authorized domains', async () => {
    const res = await fetch(`${emu.url}/__/icebase/auth/google/start?mode=popup&return=${encodeURIComponent('https://evil.example')}`, { redirect: 'manual' });
    expect(res.status).toBe(403);
  });
});
