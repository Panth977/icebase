// newUserUid / signInClaims and SSO, firebase mode: the IceBase handler on a local port, Firebase
// Auth and the Realtime Database (the security store) on the official emulators.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '@panth977/icebase/app';
import { getAdminAuth, initializeAdminApp } from '@panth977/icebase-server/admin';
import { completeSsoSignIn, connectAuthEmulator, customEmailAuth, getAuth, getIdTokenResult, grantSsoRequest, listSsoSessions, revokeSsoSessions, signOut, ssoAuthorizeUrl, type Auth } from '@panth977/icebase/auth';
import { createAuthHandler, getAuthSecurity, type EmailMessage } from '@panth977/icebase-server/auth';
import { defineConfig } from '@panth977/icebase/config';
import { serve } from '@panth977/icebase-server/internal';
import { defineSchema } from '@panth977/icebase/schema';

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;
const DB_HOST = process.env.FIREBASE_DATABASE_EMULATOR_HOST;
if (!AUTH_HOST || !DB_HOST) throw new Error('run under scripts/emu.sh with auth and database');
const PROJECT = 'demo-icebase';
const SHOP = 'https://shop.acme.test/sso';
const uidFor = (email: string) => `legacy-${createHash('sha256').update(email).digest('hex').slice(0, 20)}`;

describe('custom auth · newUserUid, signInClaims, SSO · firebase mode', () => {
  const mails: EmailMessage[] = [];
  let srv: Awaited<ReturnType<typeof serve>>;
  let admin: IceBaseApp;
  let login: IceBaseApp;
  let shop: IceBaseApp;
  const authOf = (app: IceBaseApp) => {
    const a = getAuth(app);
    connectAuthEmulator(a, `http://${AUTH_HOST}`, { disableWarnings: true });
    return a;
  };
  let loginAuth: Auth<unknown>;
  let shopAuth: Auth<unknown>;
  const signIn = async (email: string) => {
    const flow = customEmailAuth(loginAuth);
    await flow.start(email);
    return (await flow.verifyCode(mails.filter((m) => m.to === email).pop()!.code!)).user;
  };
  const sso = async () => {
    const a = await ssoAuthorizeUrl(shopAuth, { clientId: 'shop', redirectUri: SHOP });
    const res = await fetch(a.url, { redirect: 'manual' });
    const rid = new URL(res.headers.get('location')!).searchParams.get('sso')!;
    return completeSsoSignIn(shopAuth, await grantSsoRequest(loginAuth, rid), { verifier: a.verifier, clientId: 'shop', redirectUri: SHOP });
  };

  beforeAll(async () => {
    let handler: (req: Request) => Promise<Response> = async () => new Response(null, { status: 503 });
    srv = await serve(async (req) => handler(req));
    const config = defineConfig({
      name: 'custom-sso-fb',
      schema: defineSchema({}),
      auth: {
        providers: ['emailLink'],
        custom: {
          endpoint: srv.url,
          email: { sender: 'handler', signIn: 'code' },
          sso: { loginUrl: 'https://login.acme.test/', clients: { shop: { name: 'Acme Shop', redirectUris: [SHOP] } } },
          security: { store: { path: '_icebase/auth-sso' } },
        },
      },
      firebase: { projectId: PROJECT, databaseURL: `https://${PROJECT}-default-rtdb.firebaseio.com` },
      environments: { test: { mode: 'firebase' } },
    });
    admin = initializeAdminApp(config, 'test', { name: 'admin-sso' });
    handler = createAuthHandler(config, 'test', {
      app: admin,
      senders: { email: async (m) => void mails.push(m) },
      newUserUid: ({ email }) => (email ? uidFor(email) : undefined),
      signInClaims: (u) => ({ role: 'authenticated', ...(u.email ? { email: u.email } : {}) }),
    });
    login = initializeApp(config, 'test', { name: 'web-sso-login', firebase: { apiKey: 'demo', projectId: PROJECT } });
    shop = initializeApp(config, 'test', { name: 'web-sso-shop', firebase: { apiKey: 'demo', projectId: PROJECT } });
    loginAuth = authOf(login);
    shopAuth = authOf(shop);
  });
  afterAll(async () => {
    await srv.close();
    for (const a of [login, shop, admin]) await deleteApp(a);
  });

  it('newUserUid on Firebase Auth: a new user gets it; an existing uid with no email gets the verified email', async () => {
    const fresh = `fresh-${Date.now()}@example.com`;
    expect((await signIn(fresh)).uid).toBe(uidFor(fresh));
    const old = `old-${Date.now()}@example.com`;
    await getAdminAuth(admin).createUser({ uid: uidFor(old) });
    const u = await signIn(old);
    expect(u.uid).toBe(uidFor(old));
    expect(await getAdminAuth(admin).getUser(u.uid)).toMatchObject({ email: old, emailVerified: true });
    const claims = (await getIdTokenResult(u)).claims as Record<string, unknown>;
    expect(claims.role).toBe('authenticated');
    expect(claims.email).toBe(old);
  });

  it('SSO end to end on Firebase: code single use (RTDB transaction), sid / client claims, revoke ends the session', async () => {
    const me = await signIn(`sso-${Date.now()}@example.com`);
    const cred = await sso();
    expect(cred!.user.uid).toBe(me.uid);
    const claims = (await getIdTokenResult(cred!.user)).claims as Record<string, unknown>;
    expect(claims).toMatchObject({ client: 'shop', role: 'authenticated' });
    const sid = claims.sid as string;
    const { sessions, apps } = await listSsoSessions(shopAuth);
    expect(sessions[0]).toMatchObject({ sid, current: true, revoked: false });
    expect(apps).toMatchObject([{ client: 'shop', sessions: 1 }]);
    const ping = async () => (await fetch(`${srv.url}/sso/ping`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: await shopAuth.currentUser!.getIdToken() }) })).json();
    expect(await ping()).toEqual({ ok: true });
    await revokeSsoSessions(loginAuth, { sid });
    expect(await ping()).toEqual({ revoked: true });
    expect((await getAuthSecurity(admin).listSessions(me.uid))[0]).toMatchObject({ sid, revoked: true });
    await signOut(shopAuth);
    await signOut(loginAuth);
  });
});
