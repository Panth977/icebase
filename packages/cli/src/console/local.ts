// `icebase console --env X`: the console on this machine, acting with your Firebase login (or
// the IceBase server's admin token) on that environment. Listens on 127.0.0.1 only; the URL it
// prints carries a one-time token for this run.

import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AnyConfig } from '@panth977/icebase/config';
import { initializeAdminApp } from '@panth977/icebase-server/admin';
import { nodeListener } from '@panth977/icebase-server/internal';
import { googleClient } from '../internal/google-rest.ts';
import { consoleHandler } from './index.ts';

export async function startConsole(config: AnyConfig, env: string, port = 4600): Promise<{ url: string; close(): Promise<void> }> {
  const token = randomBytes(18).toString('base64url');
  const app = initializeAdminApp(config, env, { name: 'icebase-console' });
  const project = config.firebase?.projectId;
  // Firebase mode: what is deployed, read with the management credential.
  const firebase = {
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
  const route = consoleHandler('/__/icebase/console', () => ({ config, env, app, ...(project ? { firebase } : {}) }), async (req) => req.headers.get('authorization') === `Bearer ${token}`);
  const server = createServer(
    nodeListener(async (req) => (new URL(req.url).pathname === '/' ? new Response(null, { status: 302, headers: { location: '/__/icebase/console/' } }) : ((await route(req)) ?? new Response('Not found', { status: 404 })))),
  );
  await new Promise<void>((ok) => server.listen(port, '127.0.0.1', ok));
  const p = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${p}/__/icebase/console/#token=${token}`, close: () => new Promise((ok) => server.close(() => ok())) };
}
