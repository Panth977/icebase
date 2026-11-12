// Custom auth in emulator mode: newUserUid / signInClaims (the functions source's exports), and
// hosted sign-in for many apps (SSO: authorize → hosted page → grant → code + PKCE → token), its
// sessions, revocation and watchSsoSession.
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '@panth977/icebase/app';
import {
  completeSsoSignIn,
  customEmailAuth,
  denySsoRequest,
  getAuth,
  getIdTokenResult,
  getSsoRequest,
  grantSsoRequest,
  listSsoSessions,
  revokeSsoSessions,
  signOut,
  ssoAuthorizeUrl,
  startSsoSignIn,
  watchSsoSession,
  type Auth,
} from '@panth977/icebase/auth';
import { defineConfig, senders } from '@panth977/icebase/config';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';
import { defineSchema } from '@panth977/icebase/schema';
import { getAdminAuth, initializeAdminApp } from '@panth977/icebase-server/admin';
import { authSecurityOps, customAuthDatabaseRules, getAuthSecurity, memoryStore, type NewUserIdentity, type SignInContext } from '@panth977/icebase-server/auth';
import type { UserRecord } from 'firebase-admin/auth';

const LOGIN = 'https://login.acme.test/';
const SHOP = 'https://shop.acme.test/sso';
const make = (port?: number) =>
  defineConfig({
    name: 'custom-sso',
    schema: defineSchema({}),
    auth: {
      providers: ['emailLink'],
      custom: {
        site: 'Acme',
        email: { sender: senders.console(), signIn: 'code' },
        sso: {
          loginUrl: LOGIN,
          clients: {
            shop: { name: 'Acme Shop', redirectUris: [SHOP, 'com.acme.shop://*'], iconUrl: 'https://shop.acme.test/icon.png' },
            blog: { name: 'Acme Blog', redirectUris: ['https://blog.acme.test/back'] },
          },
        },
      },
    },
    firebase: { projectId: 'demo-icebase' },
    ...(port ? { emulator: { port } } : {}),
    environments: { local: { mode: 'emulator' } },
  });

type Out = { to: string; code?: string };
// An older system's uid: derived from the email (the Firebase user has no email set).
const uidFor = (email: string) => `legacy-${createHash('sha256').update(email).digest('hex').slice(0, 20)}`;

describe('custom auth · newUserUid, signInClaims and SSO · emulator mode', () => {
  let emu: RunningEmulator;
  let login: IceBaseApp;
  let shop: IceBaseApp;
  let admin: IceBaseApp;
  const seen: { identity: NewUserIdentity[]; ctx: SignInContext[] } = { identity: [], ctx: [] };
  const outbox = async () => ((await (await fetch(`${emu.url}/__/icebase/auth/outbox`, { headers: { authorization: 'Bearer owner' } })).json()) as { messages: Out[] }).messages;
  const signInOnLoginSite = async (email: string) => {
    const flow = customEmailAuth(getAuth(login));
    await flow.start(email);
    const code = (await outbox()).filter((m) => m.to === email.toLowerCase()).pop()!.code!;
    return (await flow.verifyCode(code)).user;
  };
  /** The app's half up to the hosted page: the authorize URL, followed to loginUrl?sso=… */
  const authorize = async (auth: Auth<unknown>, clientId = 'shop', redirectUri = SHOP) => {
    const a = await ssoAuthorizeUrl(auth, { clientId, redirectUri });
    const res = await fetch(a.url, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location')!);
    expect(to.origin + to.pathname).toBe(LOGIN);
    return { ...a, sso: to.searchParams.get('sso')!, pending: { verifier: a.verifier, clientId, redirectUri } };
  };
  const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${emu.url}/__/icebase/auth${route}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  beforeAll(async () => {
    emu = await startEmulator({ config: make(), env: 'local', port: 0, dataDir: ':memory:', without: ['functions'], adminToken: 'owner', log: () => {} });
    // What a functions source exporting newUserUid / signInClaims gives the handler.
    emu.context.functionExports = {
      newUserUid: (identity: NewUserIdentity) => {
        seen.identity.push(identity);
        return identity.email ? uidFor(identity.email) : undefined;
      },
      signInClaims: (user: UserRecord, ctx: SignInContext) => {
        seen.ctx.push(ctx);
        return { role: 'authenticated', ...(user.email ? { email: user.email } : {}) };
      },
    };
    login = initializeApp(make(emu.port), 'local', { name: 'sso-login', firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
    shop = initializeApp(make(emu.port), 'local', { name: 'sso-shop', firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
    admin = initializeAdminApp(make(emu.port), 'local', { name: 'sso-admin', emulator: { port: emu.port, adminToken: 'owner' } });
  });
  afterAll(async () => {
    await deleteApp(login);
    await deleteApp(shop);
    await emu.close();
  });

  it('newUserUid names a new user; signInClaims rides on the token', async () => {
    const user = await signInOnLoginSite('New@Acme.test');
    expect(user.uid).toBe(uidFor('new@acme.test'));
    expect(seen.identity.at(-1)).toEqual({ email: 'new@acme.test' });
    const claims = (await getIdTokenResult(user)).claims as Record<string, unknown>;
    expect(claims.role).toBe('authenticated');
    expect(claims.email).toBe('new@acme.test');
    expect(seen.ctx.at(-1)).toEqual({ method: 'email' });
    await signOut(getAuth(login));
  });

  it('an existing user with the newUserUid uid (no email on it) becomes the account, with the verified email set', async () => {
    const email = 'old@acme.test';
    await getAdminAuth(admin).createUser({ uid: uidFor(email), displayName: 'Old Timer' });
    const user = await signInOnLoginSite(email);
    expect(user.uid).toBe(uidFor(email));
    const rec = await getAdminAuth(admin).getUser(uidFor(email));
    expect(rec).toMatchObject({ email, emailVerified: true, displayName: 'Old Timer' });
    // Next time the email lookup finds it first.
    await signOut(getAuth(login));
    expect((await signInOnLoginSite(email)).uid).toBe(uidFor(email));
  });

  it('full SSO: authorize → hosted page → grant → code + verifier → signed into the app, sid / client / signInClaims in the token', async () => {
    const me = await signInOnLoginSite('sso@acme.test');
    const a = await authorize(getAuth(shop));
    expect(await getSsoRequest(getAuth(login), a.sso)).toMatchObject({ client: { id: 'shop', name: 'Acme Shop', iconUrl: 'https://shop.acme.test/icon.png' } });
    const back = new URL(await grantSsoRequest(getAuth(login), a.sso));
    expect(back.origin + back.pathname).toBe(SHOP);
    expect(back.searchParams.get('state')).toBe(a.state);
    // The request is used up.
    await expect(getSsoRequest(getAuth(login), a.sso)).rejects.toMatchObject({ code: 'auth/invalid-action-code' });

    const cred = await completeSsoSignIn(getAuth(shop), back.toString(), a.pending);
    expect(cred!.user.uid).toBe(me.uid);
    const claims = (await getIdTokenResult(cred!.user)).claims as Record<string, unknown>;
    expect(claims.client).toBe('shop');
    expect(typeof claims.sid).toBe('string');
    expect(claims.role).toBe('authenticated');
    expect(claims.email).toBe('sso@acme.test');
    expect(seen.ctx.at(-1)).toEqual({ method: 'sso', client: 'shop', sid: claims.sid });

    // The code was single use.
    const again = await post('/sso/token', { code: back.searchParams.get('code'), code_verifier: a.verifier, client_id: 'shop', redirect_uri: SHOP });
    expect(again.status).toBe(400);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('auth/invalid-action-code');
    await signOut(getAuth(shop));
  });

  it('startSsoSignIn keeps the verifier; completeSsoSignIn finds it by state; a custom-scheme redirect URI matches by prefix', async () => {
    await signInOnLoginSite('native@acme.test');
    let opened = '';
    await startSsoSignIn(getAuth(shop), { clientId: 'shop', redirectUri: 'com.acme.shop://auth/done', open: (url) => void (opened = url) });
    const res = await fetch(opened, { redirect: 'manual' });
    const sso = new URL(res.headers.get('location')!).searchParams.get('sso')!;
    const back = await grantSsoRequest(getAuth(login), sso);
    expect(back.startsWith('com.acme.shop://auth/done?code=')).toBe(true);
    expect((await completeSsoSignIn(getAuth(shop), back))!.user.email).toBe('native@acme.test');
    // Not an SSO return: null.
    expect(await completeSsoSignIn(getAuth(shop), 'https://shop.acme.test/home')).toBeNull();
    // A state this app never started.
    await expect(completeSsoSignIn(getAuth(shop), `${SHOP}?code=x&state=nope`)).rejects.toMatchObject({ code: 'auth/invalid-sso-state' });
    await signOut(getAuth(shop));
  });

  it('a wrong verifier is refused and burns the code', async () => {
    await signInOnLoginSite('pkce@acme.test');
    const a = await authorize(getAuth(shop));
    const back = await grantSsoRequest(getAuth(login), a.sso);
    await expect(completeSsoSignIn(getAuth(shop), back, { ...a.pending, verifier: 'x'.repeat(43) })).rejects.toMatchObject({ code: 'auth/invalid-action-code' });
    await expect(completeSsoSignIn(getAuth(shop), back, a.pending)).rejects.toMatchObject({ code: 'auth/invalid-action-code' });
  });

  it('a code is bound to its client and redirect URI', async () => {
    await signInOnLoginSite('bound@acme.test');
    const a = await authorize(getAuth(shop));
    const code = new URL(await grantSsoRequest(getAuth(login), a.sso)).searchParams.get('code');
    const r = await post('/sso/token', { code, code_verifier: a.verifier, client_id: 'blog', redirect_uri: 'https://blog.acme.test/back' });
    expect(r.status).toBe(400);
  });

  it('authorize refuses an unknown client, an unregistered redirect URI or no S256 challenge with a page, never a redirect', async () => {
    const a = await ssoAuthorizeUrl(getAuth(shop), { clientId: 'shop', redirectUri: SHOP });
    const variants = [
      a.url.replace('client_id=shop', 'client_id=nobody'),
      a.url.replace(encodeURIComponent(SHOP), encodeURIComponent('https://evil.example/steal')),
      a.url.replace(encodeURIComponent(SHOP), encodeURIComponent(`${SHOP}/more`)),
      a.url.replace('code_challenge_method=S256', 'code_challenge_method=plain'),
      a.url.replace(/&code_challenge=[^&]+/, ''),
    ];
    for (const url of variants) {
      const res = await fetch(url, { redirect: 'manual' });
      expect(res.status, url).toBe(400);
      expect(res.headers.get('location')).toBeNull();
      expect(res.headers.get('content-type')).toContain('text/html');
    }
  });

  it('deny sends the app error=access_denied; completeSsoSignIn throws auth/user-cancelled', async () => {
    const a = await authorize(getAuth(shop));
    const back = new URL(await denySsoRequest(getAuth(login), a.sso));
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('state')).toBe(a.state);
    await expect(completeSsoSignIn(getAuth(shop), back.toString(), a.pending)).rejects.toMatchObject({ code: 'auth/user-cancelled' });
  });

  it('/sso/* answers any origin (CORS *); the other routes keep the origin check', async () => {
    const pre = await fetch(`${emu.url}/__/icebase/auth/sso/token`, { method: 'OPTIONS', headers: { origin: 'https://some-app.example' } });
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    const r = await post('/sso/request', { sso: 'nope-nope-nope' }, { origin: 'https://some-app.example' });
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe('auth/invalid-action-code');
    const other = await post('/email/start', { email: 'x@acme.test' }, { origin: 'https://some-app.example' });
    expect(other.status).toBe(403);
  });

  it('sessions: listed newest first with the current one marked, grouped per app; revoke → ping says revoked → watchSsoSession signs out', async () => {
    const me = await signInOnLoginSite('sessions@acme.test');
    const grantTo = async (clientId: string, redirectUri: string) => {
      const a = await authorize(getAuth(shop), clientId, redirectUri);
      return completeSsoSignIn(getAuth(shop), await grantSsoRequest(getAuth(login), a.sso), a.pending);
    };
    await grantTo('blog', 'https://blog.acme.test/back');
    await grantTo('shop', SHOP);
    const shopSid = (await getIdTokenResult(getAuth(shop).currentUser!)).claims.sid as string;

    const { sessions, apps } = await listSsoSessions(getAuth(shop));
    expect(sessions.map((s) => s.client)).toEqual(['shop', 'blog']);
    expect(sessions[0]).toMatchObject({ sid: shopSid, clientName: 'Acme Shop', revoked: false, current: true });
    expect(sessions[0]!.device).toMatch(/ on /);
    expect(sessions[1]!.current).toBe(false);
    expect(apps.map((x) => x.client).sort()).toEqual(['blog', 'shop']);
    expect(apps.find((x) => x.client === 'shop')).toMatchObject({ clientName: 'Acme Shop', iconUrl: 'https://shop.acme.test/icon.png', sessions: 1 });
    expect((await getAuthSecurity(admin).listSessions(me.uid)).map((s) => s.sid)).toContain(shopSid);

    const idToken = await getAuth(shop).currentUser!.getIdToken();
    expect(await (await post('/sso/ping', { idToken })).json()).toEqual({ ok: true });
    // From the hosted page: sign the shop out.
    expect(await revokeSsoSessions(getAuth(login), { client: 'shop' })).toEqual({ revoked: 1 });
    expect(await (await post('/sso/ping', { idToken })).json()).toEqual({ revoked: true });
    const revoked = new Promise<void>((resolve) => watchSsoSession(getAuth(shop), resolve));
    await revoked;
    expect(getAuth(shop).currentUser).toBeNull();
    const after = await listSsoSessions(getAuth(login));
    expect(after.apps.map((x) => x.client)).toEqual(['blog']);
    expect(after.sessions.find((s) => s.sid === shopSid)).toMatchObject({ revoked: true });
  });

  it('admin revokeSession; revoke { all } also revokes refresh tokens', async () => {
    const me = await signInOnLoginSite('all@acme.test');
    const a = await authorize(getAuth(shop));
    await completeSsoSignIn(getAuth(shop), await grantSsoRequest(getAuth(login), a.sso), a.pending);
    const sid = (await getIdTokenResult(getAuth(shop).currentUser!)).claims.sid as string;
    expect(await getAuthSecurity(admin).revokeSession(me.uid, sid)).toEqual({ revoked: true });
    expect(await (await post('/sso/ping', { idToken: await getAuth(shop).currentUser!.getIdToken() })).json()).toEqual({ revoked: true });

    const b = await authorize(getAuth(shop));
    await completeSsoSignIn(getAuth(shop), await grantSsoRequest(getAuth(login), b.sso), b.pending);
    const shopToken = await getAuth(shop).currentUser!.getIdToken();
    expect(await revokeSsoSessions(getAuth(login), { all: true })).toEqual({ revoked: 1 });
    expect(await (await post('/sso/ping', { idToken: shopToken })).json()).toEqual({ revoked: true });
    expect(Date.parse((await getAdminAuth(admin).getUser(me.uid)).tokensValidAfterTime!)).toBeGreaterThan(Date.now() - 5000);
    await signOut(getAuth(shop));
    await signOut(getAuth(login));
  });

  it('cleanup removes expired SSO requests and codes; database rules open only a session\'s revoked flag to its own user', async () => {
    const store = memoryStore();
    await store.set('_icebase/auth/sso/req/old', { expiresAt: 1000 });
    await store.set('_icebase/auth/sso/req/live', { expiresAt: 9000 });
    await store.set('_icebase/auth/sso/code/old', { expiresAt: 1000 });
    const ops = authSecurityOps(make(), store, async () => getAdminAuth(admin) as never, () => 5000);
    expect(await ops.cleanup()).toEqual({ removed: 2 });
    expect(Object.keys((await store.get<Record<string, unknown>>('_icebase/auth/sso/req'))!)).toEqual(['live']);
    const rules = customAuthDatabaseRules(make()) as { _icebase: { auth: { sessions: { $uid: { $sid: { revoked: { '.read': string } } } }; '.read': boolean } } };
    expect(rules._icebase.auth['.read']).toBe(false);
    expect(rules._icebase.auth.sessions.$uid.$sid.revoked['.read']).toBe('auth != null && auth.uid == $uid');
  });
});
