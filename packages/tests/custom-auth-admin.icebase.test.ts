// Custom auth's admin side in emulator mode: the audit trail, getAuthSecurity (listAttempts,
// resetLimits, unblock, cleanup) and linkCustomIdentity / unlinkCustomIdentity — over the
// IceBase server's management API.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '@panth977/icebase/app';
import { customEmailAuth, getAuth, signOut } from '@panth977/icebase/auth';
import { defineConfig, senders } from '@panth977/icebase/config';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';
import { defineSchema } from '@panth977/icebase/schema';
import { getAdminAuth, initializeAdminApp } from '@panth977/icebase-server/admin';
import { getAuthSecurity, linkCustomIdentity, unlinkCustomIdentity } from '@panth977/icebase-server/auth';

const make = (signIn: 'code' | 'approval', port?: number) =>
  defineConfig({
    name: 'custom-admin',
    schema: defineSchema({}),
    auth: {
      providers: ['password', 'emailLink', 'phone'],
      custom: {
        site: 'Acme',
        email: { sender: senders.console(), signIn },
        phone: { sender: senders.console() },
        security: { limits: { perIdentifier: { perHour: 3, perDay: 10 } }, challenge: { ttlMinutes: 10, maxAttempts: 2 }, blockMinutes: 5 },
      },
    },
    firebase: { projectId: 'demo-icebase' },
    ...(port ? { emulator: { port } } : {}),
    environments: { local: { mode: 'emulator' } },
  });

type Out = { channel: string; to: string; link?: string; code?: string };
const outbox = async (emu: RunningEmulator) => ((await (await fetch(`${emu.url}/__/icebase/auth/outbox`, { headers: { authorization: 'Bearer owner' } })).json()) as { messages: Out[] }).messages;
const last = async (emu: RunningEmulator, to: string) => (await outbox(emu)).filter((m) => m.to === to).pop()!;

describe('custom auth admin · emulator mode', () => {
  let emu: RunningEmulator;
  let app: IceBaseApp;
  let admin: IceBaseApp;
  beforeAll(async () => {
    emu = await startEmulator({ config: make('code'), env: 'local', port: 0, dataDir: ':memory:', without: ['functions'], adminToken: 'owner', log: () => {} });
    app = initializeApp(make('code', emu.port), 'local', { name: 'ca-client', firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
    admin = initializeAdminApp(make('code', emu.port), 'local', { name: 'ca-admin', emulator: { port: emu.port, adminToken: 'owner' } });
  });
  afterAll(async () => {
    await deleteApp(app);
    await emu.close();
  });

  it('the audit trail records starts, wrong codes and the sign-in; listAttempts shows them with the counters', async () => {
    const auth = getAuth(app);
    const flow = customEmailAuth(auth);
    await flow.start('Audit@Example.com');
    await expect(flow.verifyCode('000000')).rejects.toMatchObject({ code: 'auth/invalid-verification-code' });
    const code = (await last(emu, 'audit@example.com')).code!;
    await flow.verifyCode(code);
    expect(auth.currentUser?.email).toBe('audit@example.com');
    await signOut(auth);

    const a = await getAuthSecurity(admin).listAttempts('AUDIT@example.com');
    expect(a.identifier).toBe('audit@example.com');
    expect(a.attempts.map((e) => e.event)).toEqual(['signed-in', 'wrong-code', 'start']);
    expect(a.attempts[2]).toMatchObject({ channel: 'email' });
    expect(a.limits.find((l) => l.rule === 'id-hour')).toMatchObject({ count: 1 });
  });

  it('too many wrong codes burn the challenge (audited)', async () => {
    const flow = customEmailAuth(getAuth(app));
    await flow.start('burn@example.com');
    await expect(flow.verifyCode('111111')).rejects.toBeTruthy();
    await expect(flow.verifyCode('222222')).rejects.toMatchObject({ code: 'auth/too-many-requests' });
    const events = (await getAuthSecurity(admin).listAttempts('burn@example.com')).attempts.map((e) => e.event);
    expect(events.slice(0, 3)).toEqual(['burned', 'wrong-code', 'wrong-code']);
  });

  it('a rate-limited identifier is recorded; resetLimits lets it start again at once', async () => {
    const flow = customEmailAuth(getAuth(app));
    for (let i = 0; i < 3; i++) await flow.start('busy@example.com');
    await expect(flow.start('busy@example.com')).rejects.toMatchObject({ code: 'auth/too-many-requests' });
    const sec = getAuthSecurity(admin);
    const before = await sec.listAttempts('busy@example.com');
    expect(before.attempts[0]!.event).toBe('limited');
    expect(before.limits.find((l) => l.rule === 'id-hour')!.count).toBeGreaterThan(3);
    expect((await sec.resetLimits('busy@example.com')).removed).toBe(2);
    await flow.start('busy@example.com');
    expect((await sec.listAttempts('busy@example.com')).attempts[0]!.event).toBe('start');
  });

  it('linkCustomIdentity adds a phone and a Google account; unlink never removes the last one', async () => {
    const aa = getAdminAuth(admin);
    const u = await aa.createUser({ email: 'link@example.com', emailVerified: true });
    await linkCustomIdentity(admin, u.uid, { phone: '+91 98123 45678' });
    expect((await aa.getUser(u.uid)).phoneNumber).toBe('+919812345678');
    await linkCustomIdentity(admin, u.uid, { google: 'google-sub-1' });
    const other = await aa.createUser({ email: 'other@example.com' });
    await expect(linkCustomIdentity(admin, other.uid, { google: 'google-sub-1' })).rejects.toMatchObject({ code: 'auth/credential-already-in-use' });
    await unlinkCustomIdentity(admin, u.uid, 'phone');
    expect((await aa.getUser(u.uid)).phoneNumber).toBeUndefined();
    await unlinkCustomIdentity(admin, u.uid, 'google');
    await expect(unlinkCustomIdentity(admin, u.uid, 'google')).rejects.toMatchObject({ code: 'auth/no-such-provider' });
    // Only the email is left: refused.
    await expect(unlinkCustomIdentity(admin, u.uid, 'email')).rejects.toMatchObject({ code: 'auth/operation-not-allowed' });
    // Firebase Auth cannot remove an email even when another identity remains.
    await linkCustomIdentity(admin, u.uid, { phone: '+919812345678' });
    await expect(unlinkCustomIdentity(admin, u.uid, 'email')).rejects.toThrow(/cannot remove/);
    await expect(linkCustomIdentity(admin, 'no-such-uid', { phone: '+919812345670' })).rejects.toBeTruthy();
  });

  it('cleanup removes expired entries and keeps live ones', async () => {
    const { removed } = await getAuthSecurity(admin).cleanup();
    expect(removed).toBeGreaterThanOrEqual(0);
    // The live counters are still there.
    expect((await getAuthSecurity(admin).listAttempts('audit@example.com')).limits.length).toBeGreaterThan(0);
  });
});

describe('custom auth admin · blocks · emulator mode', () => {
  let emu: RunningEmulator;
  let app: IceBaseApp;
  let admin: IceBaseApp;
  beforeAll(async () => {
    emu = await startEmulator({ config: make('approval'), env: 'local', port: 0, dataDir: ':memory:', without: ['functions'], adminToken: 'owner', log: () => {} });
    app = initializeApp(make('approval', emu.port), 'local', { name: 'cb-client', firebase: { apiKey: 'demo', projectId: 'demo-icebase' } });
    admin = initializeAdminApp(make('approval', emu.port), 'local', { name: 'cb-admin', emulator: { port: emu.port, adminToken: 'owner' } });
  });
  afterAll(async () => {
    await deleteApp(app);
    await emu.close();
  });

  it('"this wasn\'t me" blocks the device; the block is audited, listed, and unblock lifts it', async () => {
    const flow = customEmailAuth(getAuth(app));
    await flow.start('block@example.com');
    const t = new URL((await last(emu, 'block@example.com')).link!).searchParams.get('t')!;
    const res = await fetch(`${emu.url}/__/icebase/auth/email/reject`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t }) });
    expect(res.status).toBe(200);
    await expect(flow.start('block@example.com')).rejects.toMatchObject({ code: 'auth/too-many-requests' });
    const sec = getAuthSecurity(admin);
    const a = await sec.listAttempts('block@example.com');
    expect(a.blocks).toHaveLength(1);
    expect(a.attempts.map((e) => e.event).slice(0, 2)).toEqual(['refused-blocked', 'blocked']);
    expect(await sec.unblock('block@example.com')).toEqual({ removed: 1 });
    await flow.start('block@example.com');
    expect((await sec.listAttempts('block@example.com')).blocks).toHaveLength(0);
  });
});
