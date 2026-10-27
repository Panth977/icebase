// Custom auth on the IceBase server (emulator mode): the same handler `icebase deploy` ships
// as the icebaseAuth function, at /__/icebase/auth. Users go to the emulator's auth service;
// 'handler' senders come from the functions source (sendEmail / sendPhoneCode exports).

import { authSecurityOps, createAuthHandler, outbox, type AuthDirectory, type CustomIdentity, type EmailSendFn, type PhoneSendFn } from '@panth977/icebase-server/auth';
import { initializeAdminApp as adminApp, getAdminAuth } from '@panth977/icebase-server/admin';
import { resolveModes } from '@panth977/icebase/config';
import { memoryStore } from '@panth977/icebase-server/internal';
import { IceBaseError } from '@panth977/icebase/errors';
import { json, type EmulatorContext, type Service } from './server.ts';

export function customAuthService(ctx: EmulatorContext): Service {
  const config = ctx.config;
  let handler: ((req: Request) => Promise<Response>) | null = null;
  const store = memoryStore();
  const envOf = () => ctx.env ?? Object.keys(config.environments).find((e) => resolveModes(config, e).auth === 'emulator') ?? Object.keys(config.environments)[0]!;
  let admin: ReturnType<typeof adminApp> | null = null;
  const app = () => {
    const u = new URL(ctx.origin);
    return (admin ??= adminApp(config, envOf(), { name: `icebase-custom-auth-${u.port}`, emulator: { host: u.hostname, port: Number(u.port), adminToken: ctx.adminToken } }));
  };
  // The admin's security operations (getAuthSecurity, linkCustomIdentity) over this server's store.
  const ops = () => authSecurityOps(config, store, async () => getAdminAuth(app()) as unknown as AuthDirectory);
  // Expired challenges, counters, blocks and old audit entries go every hour (icebaseAuthCleanup on Firebase).
  const sweep = setInterval(() => void ops().cleanup().catch(() => {}), 3_600_000);
  sweep.unref?.();
  const make = () => {
    const env = envOf();
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
    return createAuthHandler(config, env, { app: app(), store, senders: { ...(config.auth?.custom?.email?.sender === 'handler' ? { email: senders.email } : {}), ...(config.auth?.custom?.phone?.sender === 'handler' ? { phone: senders.phone } : {}) } });
  };
  const manageOp = async (op: string, b: Record<string, unknown>): Promise<unknown> => {
    const o = ops();
    switch (op) {
      case 'unblock':
      case 'listAttempts':
      case 'resetLimits':
        return o[op](String(b.identifier ?? ''));
      case 'cleanup':
        return o.cleanup();
      case 'link':
        return o.link(String(b.uid ?? ''), b.identity as CustomIdentity);
      case 'unlink':
        return o.unlink(String(b.uid ?? ''), b.kind as 'email' | 'phone' | 'google');
    }
    throw new IceBaseError('invalid-argument', `customAuth: no management operation '${op}'`);
  };
  return {
    async manage(op, b) {
      try {
        return await manageOp(op, b);
      } catch (e) {
        // The handler's errors carry an auth/… code and an HTTP status: keep both.
        const f = e as { code?: string; status?: number; message: string };
        if (!f.code?.startsWith('auth/')) throw e;
        const code = f.status === 404 || f.code === 'auth/user-not-found' ? 'not-found' : f.status === 409 ? 'already-exists' : f.status === 429 ? 'resource-exhausted' : 'failed-precondition';
        throw new IceBaseError(code, f.message, { authCode: f.code });
      }
    },
    close() {
      clearInterval(sweep);
    },
    async handle(req, url, caller) {
      if (!url.pathname.startsWith('/__/icebase/auth')) return null;
      if (url.pathname === '/__/icebase/auth/outbox') return caller.admin ? json({ messages: outbox }) : json({ error: { code: 'permission-denied', message: 'admin only' } }, 403);
      if (!config.auth?.custom) return json({ error: { code: 'auth/operation-not-allowed', message: 'config.auth.custom is not set' } }, 400);
      handler ??= make();
      return handler(req);
    },
  };
}
