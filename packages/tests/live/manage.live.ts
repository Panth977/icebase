// Management APIs against a real Firebase project (not part of the normal test run).
//   ICEBASE_LIVE_PROJECT=icebase-test-p977 npx tsx test/live/manage.live.ts
// Auth: a gcloud access token (gcloud auth print-access-token), no key files.
import { execSync } from 'node:child_process';
import { initializeAdminApp } from '@panth977/icebase-server/admin';
import { defineConfig } from '@panth977/icebase/config';
import { manageAuth, manageDatabase, manageFirestore, manageHosting, manageStorage } from '@panth977/icebase-cli/manage';
import { collection, contains, dbPath, defineSchema, desc, f, index } from '@panth977/icebase/schema';

const project = process.env.ICEBASE_LIVE_PROJECT;
if (!project?.startsWith('icebase-test')) throw new Error('set ICEBASE_LIVE_PROJECT to an icebase-test-* project');
const token = () => execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const credential = { getAccessToken: async () => ({ access_token: token(), expires_in: 3000 }) };

const products = collection('products', { fields: { category: f.string(), price: f.number(), tags: f.array(f.string()), blob: f.optional(f.string()) }, indexes: [index('category'), index('category', desc('price')), index(contains('tags'), 'price')] });
const messages = dbPath('rooms/{roomId}/messages/{id}', f.map({ text: f.string(), at: f.number() }), { indexOn: ['at'] });
const config = defineConfig({
  name: 'live',
  schema: defineSchema({ products }, { paths: { messages } }),
  auth: { providers: ['password', 'anonymous'], authorizedDomains: ['localhost', `${project}.web.app`, `${project}.firebaseapp.com`] },
  hosting: { public: '/tmp/icebase-site', spa: true, headers: [{ source: '**/*.css', headers: { 'cache-control': 'max-age=60' } }] },
  firebase: { projectId: project, databaseURL: `https://${project}-default-rtdb.firebaseio.com` },
  environments: { live: { mode: 'firebase' } },
});
const app = initializeAdminApp(config, 'live', { credential: credential as never });

const step = async (name: string, fn: () => Promise<unknown>) => {
  try {
    const r = await fn();
    console.log(`ok   ${name}`, typeof r === 'object' ? JSON.stringify(r).slice(0, 300) : (r ?? ''));
  } catch (e) {
    console.log(`FAIL ${name}: ${(e as Error).message.slice(0, 400)}`);
  }
};

const fsm = manageFirestore(app);
await step('firestore.listDbs', () => fsm.listDbs());
await step('firestore.createDb (default)', async () => ((await fsm.listDbs()).some((d) => d.id === '(default)') ? 'exists' : fsm.createDb('(default)', { location: 'nam5' })));
await step('firestore.setSchema', () => fsm.setSchema());
await step('firestore.setIndexes again (idempotent)', () => fsm.setIndexes());
await step('firestore.setRules', () => fsm.setRules("rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} { allow read, write: if false; }\n  }\n}\n"));

const db = manageDatabase(app);
await step('database.listDbs', () => db.listDbs());
await step('database.createDb (default)', async () => ((await db.listDbs()).length ? 'exists' : db.createDb()));
await step('database.setRules', () => db.setRules({ rules: { '.read': false, '.write': false } }));

const auth = manageAuth(app);
await step('auth.enable', () => auth.enable());
await step('auth.setProviders', () => auth.setProviders());
await step('auth.setAuthorizedDomains', () => auth.setAuthorizedDomains(config.auth!.authorizedDomains!));
await step('auth.getConfig', async () => {
  const c = (await auth.getConfig()) as { signIn?: unknown; authorizedDomains?: unknown };
  return { signIn: c.signIn, authorizedDomains: c.authorizedDomains };
});

const st = manageStorage(app);
await step('storage.listBuckets', () => st.listBuckets());

const h = manageHosting(app);
await step('hosting.listSites', () => h.listSites());
await step('hosting.deploy', () => h.deploy({ message: 'icebase live test' }));
await step('hosting.fetch', async () => {
  const r = await fetch(`https://${project}.web.app/some/spa/route`);
  return { status: r.status, body: (await r.text()).slice(0, 60) };
});
await step('hosting.setDNS', () => h.setDNS(`live-${Date.now() % 100000}.icebase-test.example.com`));
