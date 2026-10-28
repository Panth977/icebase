// The IceBase console as a fetch handler under one base path: the page, its script and the API.
// The API answers the admin only (the caller says who that is).

import type { IceBaseApp } from '@panth977/icebase/app';
import type { AnyConfig } from '@panth977/icebase/config';
import { IceBaseError } from '@panth977/icebase/errors';
import { googleClient } from '../internal/google-rest.ts';
import { consoleApi, type ConsoleOptions } from './api.ts';
import { CONSOLE_CSS, CONSOLE_HTML, CONSOLE_JS, REFERENCE_HTML, REFERENCE_JS } from './page.ts';

export type { ConsoleOptions } from './api.ts';
export { consoleApi } from './api.ts';

/** Firebase mode: the rules as deployed and the Cloud Functions, read with the management credential. */
export function firebaseConsoleExtras(app: IceBaseApp, config: AnyConfig): NonNullable<ConsoleOptions['firebase']> {
  const project = config.firebase?.projectId;
  return {
    async rules(svc: 'firestore' | 'storage' | 'database') {
      if (svc === 'database') {
        const g = googleClient(app, 'database');
        const url = (config.firebase?.databaseURL ?? `https://${project}-default-rtdb.firebaseio.com`).replace(/\/$/, '');
        return JSON.stringify(await g.call('GET', `${url}/.settings/rules.json`), null, 2);
      }
      const g = googleClient(app, svc);
      const release = svc === 'firestore' ? 'cloud.firestore' : `firebase.storage/${config.firebase?.storageBucket ?? `${project}.appspot.com`}`;
      const r = await g.call<{ rulesetName: string }>('GET', `https://firebaserules.googleapis.com/v1/projects/${project}/releases/${release}`, undefined, { allow404: true });
      if (!r) return null;
      const rs = await g.call<{ source: { files: { content: string }[] } }>('GET', `https://firebaserules.googleapis.com/v1/${r.rulesetName}`);
      return rs.source.files.map((f) => f.content).join('\n');
    },
    async functions() {
      const g = googleClient(app, 'functions');
      const r = await g.call<{ functions?: { name: string; environment?: string; eventTrigger?: { eventType: string }; serviceConfig?: { uri?: string } }[] }>('GET', `https://cloudfunctions.googleapis.com/v2/projects/${project}/locations/-/functions`);
      return (r.functions ?? []).map((f) => ({ name: f.name.split('/').pop(), kind: f.eventTrigger ? 'event' : 'https', trigger: f.eventTrigger?.eventType ?? f.serviceConfig?.uri ?? '' }));
    },
  };
}

/** The page talks to this deployment only: the server serving it. */
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";
const SECURITY = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // no-transform: a CDN in front (Cloudflare) must not rewrite or inject scripts into the console.
  'cache-control': 'no-store, no-transform',
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
    if (path === `${b}/` && req.method === 'GET') return new Response(CONSOLE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY, 'content-security-policy': CSP } });
    // The API reference (Scalar, pinned by hash), shown in a frame of the console.
    if (path === `${b}/api-reference.html` && req.method === 'GET') {
      const o = options();
      const site = o.siteOrigin && !/\/\/(127\.|localhost|\[::1\])/.test(o.siteOrigin) ? ` ${new URL(o.siteOrigin).origin}` : '';
      return new Response(REFERENCE_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          ...SECURITY,
          'content-security-policy': `default-src 'self'; script-src 'self' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'${site}; frame-ancestors 'self'`,
        },
      });
    }
    if (path === `${b}/api-reference.js` && req.method === 'GET') return new Response(REFERENCE_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', ...SECURITY } });
    if (path === `${b}/app.js` && req.method === 'GET') return new Response(CONSOLE_JS, { headers: { 'content-type': 'text/javascript; charset=utf-8', ...SECURITY } });
    if (path === `${b}/app.css` && req.method === 'GET') return new Response(CONSOLE_CSS, { headers: { 'content-type': 'text/css; charset=utf-8', ...SECURITY } });
    // No CORS: only this deployment's own console page may call its API.
    if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
    const m = /\/api\/([A-Za-z.]+)$/.exec(path);
    if (!m || req.method !== 'POST') return new Response('Not found', { status: 404 });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...SECURITY } });
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
