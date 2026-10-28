// `icebase console --env X`: the console on this machine, acting with your Firebase login (or
// the IceBase server's admin token) on that environment. Listens on 127.0.0.1 only; the URL it
// prints carries a one-time token for this run.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AnyConfig } from '@panth977/icebase/config';
import { initializeAdminApp } from '@panth977/icebase-server/admin';
import { nodeListener } from '@panth977/icebase-server/internal';
import { consoleHandler, firebaseConsoleExtras } from './index.ts';

export async function startConsole(config: AnyConfig, env: string, port = 4600): Promise<{ url: string; close(): Promise<void> }> {
  const token = randomBytes(18).toString('base64url');
  const app = initializeAdminApp(config, env, { name: 'icebase-console' });
  const project = config.firebase?.projectId;
  const firebase = firebaseConsoleExtras(app, config);
  const route = consoleHandler('/__/icebase/console', () => ({ config, env, app, ...(project ? { firebase, siteOrigin: `https://${config.hosting?.site ?? project}.web.app` } : {}) }), async (req) => req.headers.get('authorization') === `Bearer ${token}`);
  const server = createServer(
    nodeListener(async (req) => (new URL(req.url).pathname === '/' ? new Response(null, { status: 302, headers: { location: '/__/icebase/console/' } }) : ((await route(req)) ?? new Response('Not found', { status: 404 })))),
  );
  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok));
  const p = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${p}/__/icebase/console/#token=${token}`, close: () => new Promise((ok) => server.close(() => ok())) };
}
