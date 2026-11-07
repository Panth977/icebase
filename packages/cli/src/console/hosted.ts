// The console on a Firebase project: a Cloud Function (`icebaseConsole`) that serves the same
// page and API as the IceBase server's /__/icebase/console, acting with the function's own
// service account. `icebase deploy` adds it, and Hosting's /__/icebase/console rewrite, when
// config.console.hosted is set. It opens with the console token (ICEBASE_CONSOLE_TOKEN), as on
// the IceBase server; without one set, every API call is refused.

import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';
import type { AnyConfig } from '@panth977/icebase/config';
import { readEnv } from '@panth977/icebase/config';
import { initializeAdminApp } from '@panth977/icebase-server/admin';
import { onRequest } from '@panth977/icebase-server/functions';
import { consoleHandler, firebaseConsoleExtras } from './index.ts';

export const CONSOLE_BASE = '/__/icebase/console';
/** A console token shorter than this is refused at deploy and ignored at run time. */
export const CONSOLE_TOKEN_MIN = 32;

export function consoleTokenEnv(config: AnyConfig): string {
  return config.console?.tokenEnv ?? 'ICEBASE_CONSOLE_TOKEN';
}

/** Whether a request carries the console token (constant time; refused when none is set). */
export function hasConsoleToken(req: Request, expected: string | undefined): boolean {
  if (!expected || expected.length < CONSOLE_TOKEN_MIN) return false;
  const a = req.headers.get('authorization') ?? '';
  const got = a.replace(/^Bearer\s+/i, '');
  const x = Buffer.from(got);
  const y = Buffer.from(expected);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The console as a fetch handler for a firebase-mode environment (what the function runs). */
export function hostedConsoleHandler(config: AnyConfig, env: string): (req: Request) => Promise<Response> {
  let route: ((req: Request) => Promise<Response | null>) | null = null;
  return async (req) => {
    if (!route) {
      const app = initializeAdminApp(config, env, { name: 'icebase-console' });
      const project = config.firebase?.projectId;
      const firebase = firebaseConsoleExtras(app, config);
      route = consoleHandler(
        CONSOLE_BASE,
        () => ({ config, env, app, ...(project ? { firebase, siteOrigin: `https://${config.hosting?.site ?? project}.web.app` } : {}) }),
        async (r) => hasConsoleToken(r, readEnv(consoleTokenEnv(config))),
      );
    }
    // Reached through Hosting the path is /__/icebase/console/…; on the function's own URL it may
    // be bare (/, /api/…): serve both.
    const url = new URL(req.url);
    if (!url.pathname.startsWith(CONSOLE_BASE)) {
      url.pathname = CONSOLE_BASE + (url.pathname === '/' ? '/' : url.pathname);
      req = new Request(url, req);
    }
    return (await route(req)) ?? new Response('Not found', { status: 404 });
  };
}

/** The `icebaseConsole` function. `icebase deploy` adds it when config.console.hosted is set. */
export function icebaseConsole(config: AnyConfig, env: string): ReturnType<typeof onRequest> {
  return onRequest({ cors: false, invoker: 'public' }, hostedConsoleHandler(config, env));
}
