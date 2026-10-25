// Signed tokens (signTokens): the IceBase server as a server others reach. Tokens are HMAC-signed;
// unsigned or tampered ones are refused everywhere; admin verify / custom tokens go through the server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '@panth977/icebase/app';
import { defineConfig } from '@panth977/icebase/config';
import { createUserWithEmailAndPassword, getAuth, signInWithCustomToken } from '@panth977/icebase/auth';
import { getAdminAuth, initializeAdminApp } from '@panth977/icebase-server/admin';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';
import { defineSchema } from '@panth977/icebase/schema';

const make = (port?: number) => defineConfig({ name: 'signed', schema: defineSchema({}), firebase: { projectId: 'demo-icebase' }, ...(port ? { emulator: { port } } : {}), environments: { local: { mode: 'emulator' } } });
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

describe('auth · signed tokens', () => {
  let emu: RunningEmulator;
  let app: IceBaseApp;
  let admin: IceBaseApp;
  beforeAll(async () => {
    emu = await startEmulator({ config: make(), port: 0, dataDir: ':memory:', without: ['functions'], signTokens: true, adminToken: 'secret-admin', log: () => {} });
    app = initializeApp(make(emu.port), 'local', { name: 'signed', firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
    admin = initializeAdminApp(make(emu.port), 'local', { name: 'signed-admin', emulator: { port: emu.port, adminToken: 'secret-admin' } });
  });
  afterAll(async () => {
    await deleteApp(app);
    await deleteApp(admin);
    await emu.close();
  });

  it('issues signed tokens; admin verifies them; a forged or tampered one is refused', async () => {
    const c = await createUserWithEmailAndPassword(getAuth(app), 'sig@x.test', 'secret1');
    const token = await c.user.getIdToken();
    expect(JSON.parse(Buffer.from(token.split('.')[0]!, 'base64url').toString()).alg).toBe('HS256');
    const decoded = await getAdminAuth(admin).verifyIdToken(token);
    expect(decoded.uid).toBe(c.user.uid);
    const [h, body] = token.split('.');
    const forged = `${b64({ alg: 'none', typ: 'JWT' })}.${body}.`;
    await expect(getAdminAuth(admin).verifyIdToken(forged)).rejects.toThrow(/not a valid token/);
    const tampered = `${h}.${b64({ ...JSON.parse(Buffer.from(body!, 'base64url').toString()), user_id: 'someone-else' })}.${token.split('.')[2]}`;
    await expect(getAdminAuth(admin).verifyIdToken(tampered)).rejects.toThrow(/not a valid token/);
    const lookup = await fetch(`${emu.url}/identitytoolkit.googleapis.com/v1/accounts:lookup?key=x`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: forged }) });
    expect(lookup.status).toBe(400);
  });

  it('custom tokens are minted by the server; unsigned ones are refused', async () => {
    const t = await getAdminAuth(admin).createCustomToken('cust-1', { role: 'x' });
    const c = await signInWithCustomToken(getAuth(app), t);
    expect(c.user.uid).toBe('cust-1');
    expect((await c.user.getIdTokenResult()).claims.role).toBe('x');
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ uid: 'evil' })}.`;
    await expect(signInWithCustomToken(getAuth(app), unsigned)).rejects.toThrow(/invalid-custom-token|INVALID_CUSTOM_TOKEN/);
  });

  it('the admin token is the configured one, not "owner"', async () => {
    const r = await fetch(`${emu.url}/__/icebase/admin/auth/createCustomToken`, { method: 'POST', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: JSON.stringify({ uid: 'x' }) });
    expect(r.status).toBe(403);
  });

  it('the emulator\'s open doors are admin only: other users, codes and links stay on the server', async () => {
    const c = await createUserWithEmailAndPassword(getAuth(app), 'door@x.test', 'secret1');
    const post = (path: string, body: object, token?: string) =>
      fetch(`${emu.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    expect((await post('/identitytoolkit.googleapis.com/v1/accounts:delete?key=x', { localId: c.user.uid })).status).toBe(403);
    expect((await post('/identitytoolkit.googleapis.com/v1/projects/demo-icebase/accounts:update', { localId: c.user.uid, customAttributes: '{"admin":true}' })).status).toBe(403);
    expect((await post('/identitytoolkit.googleapis.com/v1/projects/demo-icebase/accounts', { email: 'new@x.test' })).status).toBe(403);
    expect((await fetch(`${emu.url}/emulator/v1/projects/demo-icebase/oobCodes`)).status).toBe(403);
    expect((await fetch(`${emu.url}/emulator/v1/projects/demo-icebase/accounts`, { method: 'DELETE' })).status).toBe(403);
    const reset = await (await post('/identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=x', { requestType: 'PASSWORD_RESET', email: 'door@x.test', returnOobLink: true })).json();
    expect(reset.oobLink).toBeUndefined();
    // The admin (its token) still can.
    expect((await getAdminAuth(admin).getUser(c.user.uid)).email).toBe('door@x.test');
    expect((await fetch(`${emu.url}/emulator/v1/projects/demo-icebase/oobCodes`, { headers: { authorization: 'Bearer secret-admin' } })).status).toBe(200);
  });

  it('importAuthUsers: uids kept; an imported scrypt$N$r$p hash signs in with its password', async () => {
    const { scryptSync, randomBytes } = await import('node:crypto');
    const salt = randomBytes(16);
    const hash = `scrypt$16384$8$1$${salt.toString('base64url')}$${scryptSync('old-secret', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64url')}`;
    const { importAuthUsers } = await import('@panth977/icebase-server/admin');
    const r = await importAuthUsers(admin, [
      { uid: 'imported-1', email: 'Imp@X.test', passwordHash: hash, emailVerified: true, displayName: 'Imp', customClaims: { role: 'admin' }, providers: ['password'] },
      { uid: 'imported-2', email: 'link@x.test', providers: ['emailLink'] },
    ]);
    expect(r.every((x) => x.ok)).toBe(true);
    expect((await importAuthUsers(admin, [{ uid: 'imported-2' }]))[0]!.ok).toBe(false);
    const { signInWithEmailAndPassword } = await import('@panth977/icebase/auth');
    const c = await signInWithEmailAndPassword(getAuth(app), 'imp@x.test', 'old-secret');
    expect(c.user.uid).toBe('imported-1');
    expect((await c.user.getIdTokenResult()).claims.role).toBe('admin');
    await expect(signInWithEmailAndPassword(getAuth(app), 'imp@x.test', 'wrong')).rejects.toThrow();
    expect((await getAdminAuth(admin).getUser('imported-2')).email).toBe('link@x.test');
  });
});
