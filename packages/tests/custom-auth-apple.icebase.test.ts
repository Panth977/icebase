// Sign in with Apple, custom (like custom Google), in emulator mode: the web flow (authorize →
// form_post callback → code exchange with an ES256 client secret) and a native app's identity
// token (/apple/token, RS256 checked against Apple's keys). Apple's endpoints are faked: a fetch
// handed to createAuthHandler, or the global one under the IceBase server.
import { generateKeyPairSync, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '@panth977/icebase/app';
import { getAuth, OAuthProvider, signInWithAppleIdToken, signInWithCustomToken, signOut } from '@panth977/icebase/auth';
import { defineConfig } from '@panth977/icebase/config';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';
import { defineSchema } from '@panth977/icebase/schema';
import { getAdminAuth, initializeAdminApp } from '@panth977/icebase-server/admin';
import { createAuthHandler, memoryStore, type AuthDirectory } from '@panth977/icebase-server/auth';

const APPLE = 'https://appleid.apple.com';
const cfg = (port?: number) =>
  defineConfig({
    name: 'custom-apple',
    schema: defineSchema({}),
    auth: {
      providers: [],
      custom: { site: 'Acme', apple: { clientIdEnv: 'ICE_APPLE_SERVICES_ID', teamIdEnv: 'ICE_APPLE_TEAM', keyIdEnv: 'ICE_APPLE_KEY_ID', privateKeyEnv: 'ICE_APPLE_P8', audiences: ['com.acme.app'] } },
    },
    firebase: { projectId: 'demo-icebase' },
    ...(port ? { emulator: { port } } : {}),
    environments: { local: { mode: 'emulator' } },
  });

// The team's Sign in with Apple key (ES256) and Apple's own signing key (RS256, served as a JWKS).
const teamKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const appleKey = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'apple-test-kid';
const jwks = { keys: [{ ...(appleKey.publicKey.export({ format: 'jwk' }) as object), kid: KID, alg: 'RS256', use: 'sig' }] };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const appleJwt = (claims: Record<string, unknown>, key: KeyObject = appleKey.privateKey, kid = KID) => {
  const input = `${b64({ alg: 'RS256', kid })}.${b64(claims)}`;
  return `${input}.${cryptoSign('RSA-SHA256', Buffer.from(input), key).toString('base64url')}`;
};
const claimsOf = (jwt: string) => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;

/** Apple's token and keys endpoints; checks the client secret IceBase signs. */
const fakeApple = (idTokenFor: (form: URLSearchParams) => string) => {
  const calls: string[] = [];
  const f = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push(url);
    if (url === `${APPLE}/auth/keys`) return new Response(JSON.stringify(jwks));
    if (url === `${APPLE}/auth/token`) {
      const form = new URLSearchParams(String(init?.body));
      const [h, p, s] = form.get('client_secret')!.split('.');
      const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
      const c = claimsOf(form.get('client_secret')!);
      const ok =
        header.alg === 'ES256' &&
        header.kid === 'KEY123' &&
        c.iss === 'TEAM123' &&
        c.sub === 'com.acme.web' &&
        c.aud === APPLE &&
        (c.exp as number) - (c.iat as number) <= 600 &&
        cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key: teamKey.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(s!, 'base64url'));
      if (!ok || form.get('client_id') !== 'com.acme.web' || form.get('grant_type') !== 'authorization_code') return new Response('{"error":"invalid_client"}', { status: 400 });
      return new Response(JSON.stringify({ id_token: idTokenFor(form) }));
    }
    throw new Error(`unexpected fetch ${url}`);
  };
  return { fetch: f as typeof fetch, calls };
};

describe('custom auth · Sign in with Apple · emulator mode', () => {
  let emu: RunningEmulator;
  let app: IceBaseApp;
  let admin: IceBaseApp;
  beforeAll(async () => {
    process.env.ICE_APPLE_SERVICES_ID = 'com.acme.web';
    process.env.ICE_APPLE_TEAM = 'TEAM123';
    process.env.ICE_APPLE_KEY_ID = 'KEY123';
    // As one env line: newlines escaped.
    process.env.ICE_APPLE_P8 = (teamKey.privateKey.export({ format: 'pem', type: 'pkcs8' }) as string).replace(/\n/g, '\\n');
    emu = await startEmulator({ config: cfg(), env: 'local', port: 0, dataDir: ':memory:', without: ['functions'], adminToken: 'owner', log: () => {} });
    app = initializeApp(cfg(emu.port), 'local', { name: 'apple-client', firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
    admin = initializeAdminApp(cfg(emu.port), 'local', { name: 'apple-admin', emulator: { port: emu.port, adminToken: 'owner' } });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await deleteApp(app);
    await emu.close();
  });

  it('OAuthProvider is exported and names apple.com', () => {
    expect(new OAuthProvider('apple.com').providerId).toBe('apple.com');
  });

  it('web flow: /apple/start → Apple (form_post) → /apple/callback from appleid.apple.com → token; the name from the first sign-in; same uid next time', async () => {
    const base = `${emu.url}/__/icebase/auth`;
    const sub = `001234.${Date.now()}`;
    const signInOnce = async (user?: unknown) => {
      const start = await fetch(`${base}/apple/start?mode=redirect&return=${encodeURIComponent('http://localhost:5173/app')}`, { redirect: 'manual' });
      expect(start.status).toBe(302);
      const to = new URL(start.headers.get('location')!);
      expect(to.origin + to.pathname).toBe(`${APPLE}/auth/authorize`);
      expect(Object.fromEntries(to.searchParams)).toMatchObject({ client_id: 'com.acme.web', redirect_uri: `${base}/apple/callback`, response_type: 'code', response_mode: 'form_post', scope: 'name email' });
      const nonce = to.searchParams.get('nonce');
      // The IceBase server's handler reaches Apple with the global fetch: fake only Apple.
      const realFetch = globalThis.fetch;
      const fake = fakeApple((form) => {
        expect(form.get('code')).toBe('the-code');
        return appleJwt({ iss: APPLE, aud: 'com.acme.web', exp: Date.now() / 1000 + 600, sub, nonce, email: 'pat@privaterelay.appleid.com', email_verified: 'true' });
      });
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith(APPLE) ? fake.fetch(input, init) : realFetch(input, init)));
      try {
        const form = new URLSearchParams({ state: to.searchParams.get('state')!, code: 'the-code', ...(user ? { user: JSON.stringify(user) } : {}) });
        const cb = await emu.handler(new Request(`${base}/apple/callback`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APPLE }, body: form }));
        expect(cb.status).toBe(302);
        const hash = new URLSearchParams(new URL(cb.headers.get('location')!).hash.slice(1));
        expect(hash.get('icebase_error')).toBeNull();
        const cred = await signInWithCustomToken(getAuth(app), hash.get('icebase_token')!);
        await signOut(getAuth(app));
        return cred.user;
      } finally {
        vi.stubGlobal('fetch', realFetch);
        vi.unstubAllGlobals();
      }
    };
    const first = await signInOnce({ name: { firstName: 'Pat', lastName: 'Lee' }, email: 'pat@privaterelay.appleid.com' });
    expect(first.email).toBe('pat@privaterelay.appleid.com');
    expect(first.displayName).toBe('Pat Lee');
    const second = await signInOnce();
    expect(second.uid).toBe(first.uid);
    expect(second.displayName).toBe('Pat Lee');
  });

  it('a callback with an unknown state is refused', async () => {
    const r = await emu.handler(new Request(`${emu.url}/__/icebase/auth/apple/callback`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: APPLE }, body: 'state=nope&code=x' }));
    expect(r.status).toBe(400);
  });

  describe('native identity token (/apple/token), with createAuthHandler({ fetch, newUserUid, signInClaims })', () => {
    const fake = fakeApple(() => '');
    const make = () =>
      createAuthHandler(cfg(emu.port), 'local', {
        app: admin,
        directory: getAdminAuth(admin) as unknown as AuthDirectory,
        store: memoryStore(),
        fetch: fake.fetch,
        newUserUid: (id) => (id.apple ? `apple-${id.apple.replace(/\W/g, '')}` : undefined),
        signInClaims: (u, ctx) => ({ role: 'authenticated', via: ctx.method, ...(u.email ? { email: u.email } : {}) }),
      });
    const call = (handler: (r: Request) => Promise<Response>, body: unknown) =>
      handler(new Request('http://localhost/__/icebase/auth/apple/token', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    const good = (over: Record<string, unknown> = {}) => ({ iss: APPLE, aud: 'com.acme.app', exp: Math.floor(Date.now() / 1000) + 600, sub: 'native.sub.1', email: 'n@acme.test', email_verified: true, ...over });

    it('a token signed by Apple for a listed bundle id signs in (newUserUid, signInClaims, name); keys are fetched once', async () => {
      const handler = make();
      const r = await call(handler, { idToken: appleJwt(good()), name: { givenName: 'Nat', familyName: 'Ive' } });
      expect(r.status).toBe(200);
      const { token } = (await r.json()) as { token: string };
      const user = (await signInWithCustomToken(getAuth(app), token)).user;
      expect(user.uid).toBe('apple-nativesub1');
      expect(user.displayName).toBe('Nat Ive');
      expect(claimsOf(await user.getIdToken())).toMatchObject({ role: 'authenticated', via: 'apple', email: 'n@acme.test' });
      await signOut(getAuth(app));
      // The Services ID is an audience too.
      expect((await call(handler, { idToken: appleJwt(good({ aud: 'com.acme.web' })) })).status).toBe(200);
      expect(fake.calls.filter((u) => u.endsWith('/auth/keys'))).toHaveLength(1);
    });

    it('refuses a wrong signature, an unknown key, another audience, another issuer, an expired token', async () => {
      const handler = make();
      const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
      const bad = [
        appleJwt(good(), other),
        appleJwt(good(), appleKey.privateKey, 'other-kid'),
        appleJwt(good({ aud: 'com.evil.app' })),
        appleJwt(good({ iss: 'https://evil.example' })),
        appleJwt(good({ exp: Math.floor(Date.now() / 1000) - 10 })),
        'not.a.jwt',
      ];
      for (const idToken of bad) {
        const r = await call(handler, { idToken });
        expect(r.status, idToken.slice(0, 30)).toBe(401);
        expect(((await r.json()) as { error: { code: string } }).error.code).toBe('auth/invalid-id-token');
      }
    });

    it('signInWithAppleIdToken (client) goes through the IceBase server', async () => {
      // The server fetches Apple's keys with the global fetch.
      const realFetch = globalThis.fetch;
      vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => (String(input).startsWith(APPLE) ? fake.fetch(input, init) : realFetch(input, init)));
      try {
        const cred = await signInWithAppleIdToken(getAuth(app), appleJwt(good({ sub: 'native.sub.2', email: 'n2@acme.test' })), 'Nia');
        expect(cred.user).toMatchObject({ email: 'n2@acme.test', displayName: 'Nia' });
      } finally {
        vi.unstubAllGlobals();
      }
      await signOut(getAuth(app));
    });
  });
});
