// App Check on the IceBase server, in the 'appcheck' store. The server issues App Check tokens
// (HS256 JWTs, key kept in the store) for debug tokens: any debug token on a server that does not
// sign its ID tokens (a developer's emulator), only registered ones (manageAppCheck) on one that
// does (`icebase serve`, vm). Services listed in config.appCheck.enforce refuse callers without a
// valid token (X-Firebase-AppCheck, or `appCheck` in the socket's auth message); admins are exempt.
//
//   POST /v1/appcheck/exchangeDebugToken { debugToken, appId } → { token, ttlMillis }
//   POST /__/icebase/admin/manage/appCheck/<op>   createToken, verifyToken, createDebugToken, listDebugTokens, deleteDebugToken

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { IceBaseError } from '@panth977/icebase/errors';
import { json, type EmulatorContext, type Service } from './server.ts';
import { appCheckTables } from './tables.ts';

const b64 = (x: Buffer | string) => Buffer.from(x).toString('base64url');

export interface AppCheckClaims {
  iss: string;
  sub: string;
  aud: string[];
  iat: number;
  exp: number;
  jti: string;
}

export async function appCheckService(ctx: EmulatorContext): Promise<Service> {
  const sql = await ctx.stores.open('appcheck');
  await appCheckTables(sql);
  let row = await sql.get<{ v: string }>(`SELECT v FROM meta WHERE k = 'key'`);
  if (!row) {
    await sql.run(`INSERT INTO meta (k, v) VALUES ('key', ?) ON CONFLICT DO NOTHING`, randomBytes(32).toString('base64'));
    row = await sql.get<{ v: string }>(`SELECT v FROM meta WHERE k = 'key'`);
  }
  const key = Buffer.from(row!.v, 'base64');
  const ttlDefault = (ctx.config.appCheck?.ttlMinutes ?? 60) * 60_000;
  const aud = [`projects/${ctx.projectId}`];

  const sign = (appId: string, ttlMillis = ttlDefault): { token: string; ttlMillis: number } => {
    if (!appId) throw new IceBaseError('invalid-argument', 'App Check: appId is required', { service: 'appCheck' });
    // Firebase: 30 minutes to 7 days.
    if (ttlMillis < 30 * 60_000 || ttlMillis > 7 * 24 * 3_600_000) throw new IceBaseError('invalid-argument', 'App Check: ttlMillis is between 30 minutes and 7 days', { service: 'appCheck' });
    const now = Math.floor(Date.now() / 1000);
    const claims: AppCheckClaims = { iss: `icebase:${ctx.projectId}`, sub: appId, aud, iat: now, exp: now + Math.floor(ttlMillis / 1000), jti: randomUUID() };
    const head = `${b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64(JSON.stringify(claims))}`;
    return { token: `${head}.${b64(createHmac('sha256', key).update(head).digest())}`, ttlMillis };
  };

  const verify = (token: string | null): AppCheckClaims | null => {
    if (!token) return null;
    const [h, p, s] = token.split('.');
    if (!h || !p || !s) return null;
    const want = createHmac('sha256', key).update(`${h}.${p}`).digest();
    const got = Buffer.from(s, 'base64url');
    if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
    try {
      const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as AppCheckClaims;
      if (c.exp * 1000 < Date.now() || !c.aud?.includes(aud[0]!)) return null;
      return c;
    } catch {
      return null;
    }
  };
  ctx.appCheck = { verify: async (t) => verify(t) };

  return {
    async handle(req, url) {
      if (url.pathname !== '/v1/appcheck/exchangeDebugToken') return null;
      if (req.method !== 'POST') return json({ error: { code: 'invalid-argument', message: 'POST' } }, 400);
      const b = (await req.json().catch(() => ({}))) as { debugToken?: string; appId?: string };
      if (typeof b.debugToken !== 'string' || !b.debugToken) throw new IceBaseError('invalid-argument', 'App Check: debugToken is required', { service: 'appCheck' });
      // A developer's emulator takes any debug token; a server others reach only registered ones.
      if (ctx.signingKey && !(await sql.get(`SELECT token FROM debug_tokens WHERE token = ?`, b.debugToken))) throw new IceBaseError('permission-denied', 'App Check: this debug token is not registered on the server (manageAppCheck(app).createDebugToken)', { service: 'appCheck' });
      return json(sign(String(b.appId ?? 'app')));
    },
    async manage(op, b) {
      switch (op) {
        case 'createToken':
          return sign(String(b.appId ?? ''), b.ttlMillis !== undefined ? Number(b.ttlMillis) : undefined);
        case 'verifyToken': {
          const c = verify(typeof b.token === 'string' ? b.token : null);
          if (!c) throw new IceBaseError('invalid-argument', 'app-check/invalid-argument: the App Check token is invalid or expired', { service: 'appCheck' });
          return { appId: c.sub, token: { ...c, app_id: c.sub, sub: c.sub } };
        }
        case 'createDebugToken': {
          const token = typeof b.token === 'string' && b.token ? b.token : randomUUID();
          await sql.run(`INSERT INTO debug_tokens (token, name, at) VALUES (?, ?, ?) ON CONFLICT (token) DO UPDATE SET name = excluded.name`, token, String(b.name ?? 'debug'), Date.now());
          return { token, name: String(b.name ?? 'debug') };
        }
        case 'listDebugTokens':
          return { tokens: (await sql.all<{ token: string; name: string; at: number }>(`SELECT token, name, at FROM debug_tokens ORDER BY at`)).map((r) => ({ name: r.name, token: r.token, at: Number(r.at) })) };
        case 'deleteDebugToken':
          await sql.run(`DELETE FROM debug_tokens WHERE token = ?`, String(b.token ?? ''));
          return {};
      }
      throw new IceBaseError('invalid-argument', `appCheck: no management operation '${op}'`);
    },
  };
}
