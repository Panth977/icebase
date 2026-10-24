// Custom auth on the IceBase server (emulator mode): the same handler `icebase deploy` ships
// as the icebaseAuth function, at /__/icebase/auth. Users go to the emulator's auth service;
// 'handler' senders come from the functions source (sendEmail / sendPhoneCode exports).

import { initializeAdminApp } from '../admin.js';
import { createAuthHandler, outbox, type EmailSendFn, type PhoneSendFn } from '../auth-server.js';
import { resolveModes } from '../config.js';
import { memoryStore } from '../internal/custom-auth/store.js';
import { json, type EmulatorContext, type Service } from './server.js';

export function customAuthService(ctx: EmulatorContext): Service {
  const config = ctx.config;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  const store = memoryStore();
  const make = () => {
    const env = ctx.env ?? Object.keys(config.environments).find((e) => resolveModes(config, e).auth === 'emulator') ?? Object.keys(config.environments)[0]!;
    const u = new URL(ctx.origin);
    const app = initializeAdminApp(config, env, { name: `icebase-custom-auth-${u.port}`, emulator: { host: u.hostname, port: Number(u.port) } });
    const senders = {
      email: (async (m) => {
        const f = ctx.functionExports.sendEmail as EmailSendFn | undefined;
        if (!f) throw new Error("config.auth.custom.email.sender is 'handler' but the functions source exports no sendEmail");
        return f(m);
      }) as EmailSendFn,
      phone: (async (m) => {
        const f = ctx.functionExports.sendPhoneCode as PhoneSendFn | undefined;
        if (!f) throw new Error("config.auth.custom.phone.sender is 'handler' but the functions source exports no sendPhoneCode");
        return f(m);
      }) as PhoneSendFn,
    };
    return createAuthHandler(config, env, { app, store, senders: { ...(config.auth?.custom?.email?.sender === 'handler' ? { email: senders.email } : {}), ...(config.auth?.custom?.phone?.sender === 'handler' ? { phone: senders.phone } : {}) } });
  };
  return {
    async handle(req, url, caller) {
      if (!url.pathname.startsWith('/__/icebase/auth')) return null;
      if (url.pathname === '/__/icebase/auth/outbox') return caller.admin ? json({ messages: outbox }) : json({ error: { code: 'permission-denied', message: 'admin only' } }, 403);
      if (!config.auth?.custom) return json({ error: { code: 'auth/operation-not-allowed', message: 'config.auth.custom is not set' } }, 400);
      handler ??= make();
      return handler(req);
    },
  };
}
