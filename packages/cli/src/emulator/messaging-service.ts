// Cloud Messaging on the IceBase server, in the 'messaging' store: registration tokens the server
// issues to apps (icebase/messaging getToken), topic subscriptions, an outbox of everything sent
// (the console and tests read it) and delivery to the apps that listen on the realtime socket
// ({ s: 'fcm', t: 'listen', token }). A message for a device that is not listening waits in its
// inbox (the newest 100) until it does. Nothing leaves the machine: Web Push / APNs / Android
// delivery is firebase mode's.
//
//   POST /v1/fcm/register, /v1/fcm/unregister          the app's token
//   POST /__/icebase/messaging/send  { message, dryRun } (admin)
//   GET  /__/icebase/messaging/outbox                   (admin)
//   POST /__/icebase/admin/manage/messaging/<op>        send, subscribe, unsubscribe, outbox, topics, tokens

import { randomBytes, randomUUID } from 'node:crypto';
import type { MessageKinds } from '@panth977/icebase/config';
import { IceBaseError } from '@panth977/icebase/errors';
import { checkMessage, matchCondition, normalizeTopic, parseCondition } from '@panth977/icebase/internal';
import { json, type Caller, type EmulatorContext, type Live, type Service } from './server.ts';
import { messagingTables } from './tables.ts';

type Msg = Record<string, unknown> & { token?: string; topic?: string; condition?: string; notification?: Record<string, string>; data?: Record<string, string>; webpush?: { notification?: Record<string, unknown>; data?: Record<string, string>; fcmOptions?: Record<string, string> } };

const INBOX_MAX = 100;
const OUTBOX_MAX = 1000;

export async function messagingService(ctx: EmulatorContext): Promise<Service> {
  const sql = await ctx.stores.open('messaging');
  await messagingTables(sql);
  const kinds = (ctx.config.messaging?.messages ?? {}) as MessageKinds;
  const from = ctx.config.firebase?.webConfig?.messagingSenderId ?? ctx.projectId;
  /** token → the sockets listening on it (socket, listen id). */
  const live = new Map<string, Map<Live, string>>();

  const tokenExists = async (token: string) => !!(await sql.get(`SELECT token FROM tokens WHERE token = ?`, token));
  const notRegistered = (token: string) => new IceBaseError('not-found', `messaging/registration-token-not-registered: '${token.slice(0, 24)}' is not a registration token of this server`, { service: 'messaging' });

  /** The tokens a message goes to. */
  const targets = async (m: Msg): Promise<string[]> => {
    if (m.token !== undefined) {
      if (!(await tokenExists(m.token))) throw notRegistered(m.token);
      return [m.token];
    }
    if (m.topic !== undefined) return (await sql.all<{ token: string }>(`SELECT token FROM topics WHERE topic = ?`, normalizeTopic(m.topic))).map((r) => r.token);
    const cond = parseCondition(String(m.condition));
    const rows = await sql.all<{ token: string; topic: string }>(`SELECT token, topic FROM topics`);
    const byToken = new Map<string, Set<string>>();
    for (const r of rows) (byToken.get(r.token) ?? byToken.set(r.token, new Set()).get(r.token)!).add(r.topic);
    return [...byToken].filter(([, t]) => matchCondition(cond, t)).map(([k]) => k);
  };

  /** What onMessage gets (firebase/messaging's MessagePayload). */
  const payloadOf = (m: Msg, messageId: string) => {
    const notification = { ...(m.notification ?? {}), ...pick(m.webpush?.notification ?? {}, ['title', 'body', 'image', 'icon']) };
    const data = { ...(m.data ?? {}), ...(m.webpush?.data ?? {}) };
    return { messageId, from, collapseKey: from, ...(Object.keys(notification).length ? { notification } : {}), ...(Object.keys(data).length ? { data } : {}), ...(m.webpush?.fcmOptions ? { fcmOptions: m.webpush.fcmOptions } : {}) };
  };

  const send = async (m: Msg, dryRun = false): Promise<string> => {
    checkMessage(kinds, m);
    const to = await targets(m);
    const id = randomUUID();
    const name = `projects/${ctx.projectId}/messages/${id}`;
    if (dryRun) return name;
    const payload = payloadOf(m, name);
    let delivered = 0;
    for (const token of to) {
      const socks = live.get(token);
      if (socks?.size) {
        for (const [l, lid] of socks) l.send({ s: 'fcm', id: lid, t: 'message', payload });
        delivered++;
      } else {
        await sql.run(`INSERT INTO inbox (id, token, at, payload) VALUES (?, ?, ?, ?)`, `${id}:${token}`, token, Date.now(), JSON.stringify(payload));
        const n = await sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM inbox WHERE token = ?`, token);
        if (Number(n?.n ?? 0) > INBOX_MAX) await sql.run(`DELETE FROM inbox WHERE id IN (SELECT id FROM inbox WHERE token = ? ORDER BY at, id LIMIT ?)`, token, Number(n!.n) - INBOX_MAX);
      }
    }
    await sql.run(`INSERT INTO outbox (id, at, message, delivered) VALUES (?, ?, ?, ?)`, name, Date.now(), JSON.stringify({ message: m, targets: to.length }), delivered);
    const n = await sql.get<{ n: number }>(`SELECT COUNT(*) AS n FROM outbox`);
    if (Number(n?.n ?? 0) > OUTBOX_MAX) await sql.run(`DELETE FROM outbox WHERE id IN (SELECT id FROM outbox ORDER BY at, id LIMIT ?)`, Number(n!.n) - OUTBOX_MAX);
    return name;
  };

  const topicOp = async (op: 'subscribe' | 'unsubscribe', tokens: unknown, topic: unknown) => {
    if (!Array.isArray(tokens) || tokens.length === 0 || tokens.length > 1000) throw new IceBaseError('invalid-argument', 'tokens: 1 to 1000 registration tokens', { service: 'messaging' });
    const t = normalizeTopic(String(topic ?? ''));
    const errors: { index: number; error: { code: string; message: string } }[] = [];
    for (const [index, token] of tokens.entries()) {
      if (typeof token !== 'string' || !(await tokenExists(token))) {
        errors.push({ index, error: { code: 'messaging/registration-token-not-registered', message: 'not a registration token of this server' } });
        continue;
      }
      if (op === 'subscribe') await sql.run(`INSERT INTO topics (topic, token) VALUES (?, ?) ON CONFLICT DO NOTHING`, t, token);
      else await sql.run(`DELETE FROM topics WHERE topic = ? AND token = ?`, t, token);
    }
    return { successCount: tokens.length - errors.length, failureCount: errors.length, errors };
  };

  const outbox = async (limit = 100) =>
    (await sql.all<{ id: string; at: number; message: string; delivered: number }>(`SELECT id, at, message, delivered FROM outbox ORDER BY at DESC, id DESC LIMIT ?`, Math.min(limit, OUTBOX_MAX)))
      .reverse()
      .map((r) => {
        const x = JSON.parse(r.message) as { message: Msg; targets: number };
        return { name: r.id, at: Number(r.at), message: x.message, targets: x.targets, delivered: Number(r.delivered) };
      });

  const adminOnly = (caller: Caller) => {
    if (!caller.admin) throw new IceBaseError('permission-denied', 'sending messages and managing topics is the admin\'s', { service: 'messaging' });
  };

  const ops: Record<string, (b: Record<string, unknown>) => Promise<unknown>> = {
    send: async (b) => ({ name: await send(b.message as Msg, !!b.dryRun) }),
    subscribe: (b) => topicOp('subscribe', b.tokens, b.topic),
    unsubscribe: (b) => topicOp('unsubscribe', b.tokens, b.topic),
    outbox: async (b) => ({ messages: await outbox(Number(b.limit ?? 100)) }),
    topics: async () => ({ topics: (await sql.all<{ topic: string; n: number }>(`SELECT topic, COUNT(*) AS n FROM topics GROUP BY topic ORDER BY topic`)).map((r) => ({ topic: r.topic, subscribers: Number(r.n) })) }),
    tokens: async (b) => {
      const rows = await sql.all<{ token: string; uid: string | null; at: number }>(`SELECT token, uid, at FROM tokens ORDER BY at DESC LIMIT ?`, Math.min(Number(b.limit ?? 100), 1000));
      const subs = await sql.all<{ token: string; topic: string }>(`SELECT token, topic FROM topics`);
      return { tokens: rows.map((r) => ({ token: r.token, uid: r.uid, at: Number(r.at), topics: subs.filter((s) => s.token === r.token).map((s) => s.topic), listening: (live.get(r.token)?.size ?? 0) > 0 })) };
    },
  };

  return {
    async handle(req, url, caller) {
      const p = url.pathname;
      if (p === '/v1/fcm/register' && req.method === 'POST') {
        const token = `ib-fcm:${randomBytes(24).toString('base64url')}`;
        await sql.run(`INSERT INTO tokens (token, uid, at) VALUES (?, ?, ?)`, token, caller.auth?.uid ?? null, Date.now());
        return json({ token });
      }
      if (p === '/v1/fcm/unregister' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) as { token?: string };
        if (typeof b.token === 'string') {
          await sql.transaction(async (tx) => {
            await tx.run(`DELETE FROM tokens WHERE token = ?`, b.token);
            await tx.run(`DELETE FROM topics WHERE token = ?`, b.token);
            await tx.run(`DELETE FROM inbox WHERE token = ?`, b.token);
          });
          for (const [l, lid] of live.get(b.token) ?? []) l.send({ s: 'fcm', id: lid, t: 'error', error: { code: 'not-found', message: 'the token was deleted' } });
          live.delete(b.token);
        }
        return json({});
      }
      if (!p.startsWith('/__/icebase/messaging/')) return null;
      adminOnly(caller);
      if (p === '/__/icebase/messaging/outbox') return json({ messages: await outbox(Number(url.searchParams.get('limit') ?? 100)) });
      if (p === '/__/icebase/messaging/send' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) as { message?: Msg; dryRun?: boolean };
        return json({ name: await send(b.message as Msg, !!b.dryRun) });
      }
      return null;
    },
    async socket(l, msg) {
      const id = String(msg.id);
      const token = String(msg.token ?? '');
      if (msg.t === 'listen') {
        if (!(await tokenExists(token))) throw notRegistered(token);
        let socks = live.get(token);
        if (!socks) live.set(token, (socks = new Map()));
        socks.set(l, id);
        l.onClose(() => {
          const s = live.get(token);
          s?.delete(l);
          if (s && s.size === 0) live.delete(token);
        });
        // What waited for this device.
        const waiting = await sql.all<{ id: string; payload: string }>(`SELECT id, payload FROM inbox WHERE token = ? ORDER BY at, id`, token);
        for (const w of waiting) l.send({ s: 'fcm', id, t: 'message', payload: JSON.parse(w.payload) });
        if (waiting.length) await sql.run(`DELETE FROM inbox WHERE token = ?`, token);
      } else if (msg.t === 'unlisten') {
        for (const [t, socks] of live) if (socks.get(l) === id) socks.delete(l), socks.size === 0 && live.delete(t);
      }
    },
    async manage(op, b) {
      const fn = ops[op];
      if (!fn) throw new IceBaseError('invalid-argument', `messaging: no management operation '${op}'`);
      return fn(b);
    },
  };
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, string> {
  return Object.fromEntries(keys.filter((k) => typeof o[k] === 'string').map((k) => [k, o[k] as string]));
}
