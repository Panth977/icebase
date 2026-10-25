// Cloud Messaging on the IceBase server: admin sends land in an outbox (the console and tests
// read it). Nothing leaves the machine — real delivery is firebase mode's job.

import { randomUUID } from 'node:crypto';
import { json, type EmulatorContext, type Service } from './server.ts';

export function messagingService(ctx: EmulatorContext): Service {
  const outbox: { name: string; at: number; message: Record<string, unknown> }[] = [];
  return {
    async handle(req, url, caller) {
      if (!url.pathname.startsWith('/__/icebase/messaging/')) return null;
      if (!caller.admin) return json({ error: { code: 'permission-denied', message: 'messaging is admin only' } }, 403);
      if (url.pathname === '/__/icebase/messaging/outbox') return json({ messages: outbox });
      if (url.pathname === '/__/icebase/messaging/send' && req.method === 'POST') {
        const b = (await req.json().catch(() => ({}))) as { message?: Record<string, unknown> };
        const m = b.message;
        if (!m || typeof m !== 'object' || !(m.token || m.topic || m.condition)) return json({ error: { code: 'invalid-argument', message: 'a message needs a token, a topic or a condition' } }, 400);
        const name = `projects/${ctx.projectId}/messages/${randomUUID()}`;
        outbox.push({ name, at: Date.now(), message: m });
        if (outbox.length > 1000) outbox.shift();
        return json({ name });
      }
      return null;
    },
  };
}
