// Cloud Messaging, emulator mode: server-issued tokens, typed kinds, topics and conditions,
// delivery over the realtime socket, the outbox.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '@panth977/icebase/app';
import { defineConfig } from '@panth977/icebase/config';
import { defineSchema, f } from '@panth977/icebase/schema';
import { deleteToken, getMessaging, getToken, onMessage, type MessagePayload } from '@panth977/icebase/messaging';
import { getAdminMessaging, initializeAdminApp } from '@panth977/icebase-server/admin';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';

const make = (port?: number) =>
  defineConfig({
    name: 'fcm-emu',
    schema: defineSchema({}),
    messaging: {
      messages: {
        orderShipped: { orderId: f.string(), eta: f.optional(f.number()), items: f.array(f.string()) },
        chat: { room: f.string(), urgent: f.boolean() },
      },
    },
    ...(port ? { emulator: { port } } : {}),
    environments: { local: { mode: 'emulator' } },
  });
type Cfg = ReturnType<typeof make>;

const inbox = (app: IceBaseApp<Cfg>) => {
  const got: MessagePayload<Cfg>[] = [];
  const off = onMessage(getMessaging(app), (p) => void got.push(p));
  const until = async (n: number) => {
    for (let i = 0; i < 100 && got.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    return got;
  };
  return { got, off, until };
};

describe('messaging · emulator mode', () => {
  let emu: RunningEmulator;
  let a: IceBaseApp<Cfg>;
  let b: IceBaseApp<Cfg>;
  let admin: IceBaseApp<Cfg>;
  beforeAll(async () => {
    emu = await startEmulator({ config: make(), port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
    a = initializeApp(make(emu.port), 'local', { name: 'fcm-a' });
    b = initializeApp(make(emu.port), 'local', { name: 'fcm-b' });
    admin = initializeAdminApp(make(emu.port), 'local', { name: 'fcm-admin' });
  });
  afterAll(async () => {
    for (const x of [a, b, admin]) await deleteApp(x);
    await emu.close();
  });

  it('getToken: issued by the server, stable for the app', async () => {
    const t = await getToken(getMessaging(a));
    expect(t).toMatch(/^ib-fcm:/);
    expect(await getToken(getMessaging(a))).toBe(t);
    expect(await getToken(getMessaging(b))).not.toBe(t);
  });

  it('send to a token: typed kind in, typed kind out (rawData keeps the FCM strings)', async () => {
    const box = inbox(a);
    const token = await getToken(getMessaging(a));
    const id = await getAdminMessaging(admin).send({ token, kind: 'orderShipped', data: { orderId: 'o1', eta: 3, items: ['hat'] }, notification: { title: 'Shipped' } });
    expect(id).toMatch(/^projects\/demo-fcm-emu\/messages\//);
    const [p] = await box.until(1);
    box.off();
    expect(p!.kind).toBe('orderShipped');
    if (p!.kind === 'orderShipped') {
      const eta: number | undefined = p!.data.eta;
      expect(eta).toBe(3);
      expect(p!.data.items).toEqual(['hat']);
    }
    expect(p!.rawData).toEqual({ icebaseKind: 'orderShipped', orderId: 'o1', eta: '3', items: '["hat"]' });
    expect(p!.notification).toEqual({ title: 'Shipped' });
    expect(p!.messageId).toBe(id);
  });

  it('sends are checked against the declared kinds, in the SDK and on the server', async () => {
    const m = getAdminMessaging(admin);
    const token = await getToken(getMessaging(a));
    // @ts-expect-error orderId must be a string
    await expect(m.send({ token, kind: 'orderShipped', data: { orderId: 1, items: [] } })).rejects.toThrow(/orderId: expected string/);
    // @ts-expect-error not a declared kind
    await expect(m.send({ token, kind: 'nope', data: {} })).rejects.toThrow(/not declared/);
    // Kinds are declared: raw data must name one.
    await expect(m.send({ token, data: { x: '1' } } as never)).rejects.toThrow(/names one/);
    await expect(m.send({ token: 'not-a-token', notification: { title: 'x' } })).rejects.toMatchObject({ code: 'not-found' });
    const raw = await fetch(`${emu.url}/__/icebase/messaging/send`, { method: 'POST', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: JSON.stringify({ message: { token, data: { icebaseKind: 'chat', room: 'r', urgent: 'maybe' } } }) });
    expect(raw.status).toBe(400);
    // Only the admin sends.
    const anon = await fetch(`${emu.url}/__/icebase/messaging/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: { token, notification: { title: 'x' } } }) });
    expect(anon.status).toBe(403);
  });

  it('topics and conditions; multicast; sendEach', async () => {
    const m = getAdminMessaging(admin);
    const ta = await getToken(getMessaging(a));
    const tb = await getToken(getMessaging(b));
    expect(await m.subscribeToTopic([ta, tb, 'bogus'], 'news')).toMatchObject({ successCount: 2, failureCount: 1, errors: [{ index: 2 }] });
    await m.subscribeToTopic(tb, '/topics/sports');
    const boxA = inbox(a);
    const boxB = inbox(b);
    await m.send({ topic: 'news', kind: 'chat', data: { room: 'all', urgent: false } });
    await m.send({ condition: "'news' in topics && 'sports' in topics", kind: 'chat', data: { room: 'fans', urgent: true } });
    await m.send({ condition: "'news' in topics && !('sports' in topics)", notification: { title: 'A only' } });
    expect((await boxA.until(2)).map((p) => (p.kind === 'chat' ? p.data.room : p.notification?.title))).toEqual(['all', 'A only']);
    expect((await boxB.until(2)).map((p) => (p.kind === 'chat' ? p.data.room : null))).toEqual(['all', 'fans']);
    await expect(m.send({ condition: "'a' in topics &&", notification: {} })).rejects.toThrow(/topic condition/);

    const r = await m.sendEachForMulticast({ tokens: [ta, 'gone'], kind: 'chat', data: { room: 'multi', urgent: false } });
    expect(r).toMatchObject({ successCount: 1, failureCount: 1 });
    const each = await m.sendEach([{ token: tb, notification: { title: '1' } }, { token: tb, notification: { title: '2' } }]);
    expect(each.successCount).toBe(2);
    await m.unsubscribeFromTopic([tb], 'news');
    await m.send({ topic: 'news', notification: { title: 'after' } });
    expect((await boxB.until(5)).map((p) => p.notification?.title ?? null)).toEqual([null, null, '1', '2']);
    boxA.off();
    boxB.off();
  });

  it('a device not listening gets its messages when it listens; deleteToken unregisters', async () => {
    const m = getAdminMessaging(admin);
    const msg = getMessaging(b);
    const tb = await getToken(msg);
    await m.send({ token: tb, notification: { title: 'while away' } });
    const box = inbox(b);
    expect((await box.until(1)).map((p) => p.notification?.title)).toEqual(['while away']);
    box.off();
    expect(await deleteToken(msg)).toBe(true);
    await expect(m.send({ token: tb, notification: { title: 'x' } })).rejects.toMatchObject({ code: 'not-found' });
    expect(await getToken(msg)).not.toBe(tb);
  });

  it('dry runs send nothing; the outbox has the rest', async () => {
    const m = getAdminMessaging(admin);
    const ta = await getToken(getMessaging(a));
    const before = (await (await fetch(`${emu.url}/__/icebase/messaging/outbox`, { headers: { authorization: 'Bearer owner' } })).json()) as { messages: unknown[] };
    await m.send({ token: ta, notification: { title: 'dry' } }, true);
    const after = (await (await fetch(`${emu.url}/__/icebase/messaging/outbox`, { headers: { authorization: 'Bearer owner' } })).json()) as { messages: { message: { notification?: { title: string } }; targets: number }[] };
    expect(after.messages.length).toBe(before.messages.length);
    expect(after.messages.some((x) => x.message.notification?.title === 'A only' && x.targets === 1)).toBe(true);
  });
});
