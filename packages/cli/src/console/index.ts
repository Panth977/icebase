// The IceBase console as a fetch handler under one base path: the page, its script and the API.
// The API answers the admin only (the caller says who that is).

import { IceBaseError } from '@panth977/icebase/errors';
import { consoleApi, type ConsoleOptions } from './api.ts';
import { CONSOLE_HTML, CONSOLE_JS } from './page.ts';

export type { ConsoleOptions } from './api.ts';

const SECURITY = {
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

export function consoleHandler(base: string, makeOptions: () => ConsoleOptions, isAdmin: (req: Request) => Promise<boolean>): (req: Request) => Promise<Response | null> {
  let api: ReturnType<typeof consoleApi> | null = null;
  let made: ConsoleOptions | null = null;
  const options = () => (made ??= makeOptions());
  const b = base.replace(/\/$/, '');
  return async (req) => {
    const path = new URL(req.url).pathname;
    if (path !== b && !path.startsWith(`${b}/`)) return null;
    if (path === b) return new Response(null, { status: 301, headers: { location: `${b}/` } });
    if (path === `${b}/` && req.method === 'GET') return new Response(CONSOLE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY } });
    if (path === `${b}/app.js` && req.method === 'GET') return new Response(CONSOLE_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', ...SECURITY } });
    // The deployments the page can switch to (config.console.targets): public, no data in it.
    if (path === `${b}/targets.json` && req.method === 'GET') return new Response(JSON.stringify({ targets: options().config.console?.targets ?? [] }), { headers: { 'content-type': 'application/json', ...SECURITY } });
    // Another deployment's console page calls this API across origins: only the listed ones.
    const origin = req.headers.get('origin');
    const allowed: Record<string, string> = origin && (options().config.console?.targets ?? []).some((t) => new URL(t.url).origin === origin) ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS' } : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: allowed });
    const m = /\/api\/([A-Za-z.]+)$/.exec(path);
    if (!m || req.method !== 'POST') return new Response('Not found', { status: 404 });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...SECURITY, ...allowed } });
    if (!(await isAdmin(req))) return json({ error: { code: 'permission-denied', message: 'the console is the admin\'s' } }, 403);
    try {
      api ??= consoleApi(options());
      return json(await api(m[1]!, ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>));
    } catch (e) {
      const code = e instanceof IceBaseError ? e.code : ((e as { code?: string }).code ?? 'internal');
      return json({ error: { code, message: (e as Error).message } }, code === 'not-found' ? 404 : code === 'permission-denied' ? 403 : 400);
    }
  };
}
