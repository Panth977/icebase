// The conformance suites against a real Firebase project — the leg the emulators cannot prove.
//   ICEBASE_LIVE_PROJECT=icebase-test-p977 npx vitest run live/   (in packages/tests)
// Auth: a gcloud access token (gcloud auth print-access-token), no key files. Only icebase-test-*
// projects. Firestore through the web SDK (firebase-admin's Firestore needs a service account or
// application-default credentials), its rules opened for the run and locked again afterwards; the
// Realtime Database through firebase-admin. The web app's config is read from the project at start.
import { execSync } from 'node:child_process';
import { afterAll, beforeAll } from 'vitest';
import { initializeApp as nativeApp } from 'firebase/app';
import { doc as nativeDoc, getFirestore as nativeFirestore, setDoc as nativeSet } from 'firebase/firestore';
import { initializeApp } from '@panth977/icebase/app';
import { getFirestore } from '@panth977/icebase/firestore';
import { getAdminDatabase, initializeAdminApp } from '@panth977/icebase-server/admin';
import { manageDatabase, manageFirestore } from '@panth977/icebase-cli/manage';
import { databaseRulesJson } from '@panth977/icebase/database';
import { firestoreConfig, firestoreSuite } from '../suites/firestore.suite.js';
import { counter, databaseConfig, databaseSuite, messages, presence } from '../suites/database.suite.js';

const project = process.env.ICEBASE_LIVE_PROJECT ?? '';
if (!project.startsWith('icebase-test')) throw new Error('set ICEBASE_LIVE_PROJECT to an icebase-test-* project');
const token = () => execSync('gcloud auth print-access-token', { encoding: 'utf8' }).trim();
const credential = { getAccessToken: async () => ({ access_token: token(), expires_in: 3000 }) } as never;

const fsConfig = { ...firestoreConfig('firebase'), firebase: { projectId: project } };
const dbConfig = { ...databaseConfig('firebase'), firebase: { projectId: project, databaseURL: `https://${project}-default-rtdb.firebaseio.com` } };
const manager = initializeAdminApp({ ...fsConfig, schema: { ...fsConfig.schema, paths: dbConfig.schema.paths } } as typeof fsConfig, 'test', { name: 'live-manage', credential });
const rules = (allow: boolean) => `rules_version = '2';\nservice cloud.firestore { match /databases/{db}/documents { match /{d=**} { allow read, write: if ${allow}; } } }`;

// The project's first web app: its public config (apiKey, appId).
const mgmt = async (path: string) => (await (await fetch(`https://firebase.googleapis.com/v1beta1/projects/${project}/${path}`, { headers: { authorization: `Bearer ${token()}`, 'x-goog-user-project': project } })).json()) as Record<string, any>;
const web = await mgmt(`webApps/${(await mgmt('webApps')).apps[0].appId}/config`);

beforeAll(async () => {
  await manageFirestore(manager).setRules(rules(true));
  // A new ruleset takes up to a minute to reach every server.
  await new Promise((r) => setTimeout(r, 60_000));
  // Everything the schema implies (field overrides: collection-group scopes), then the composite
  // indexes, built before the queries run (minutes the first time).
  await manageFirestore(manager).setSchema(fsConfig.schema, { wait: true });
  await manageDatabase(manager).setRules(databaseRulesJson({ messages, presence, counter }, { rules: { '.read': false, '.write': false } }));
}, 2_000_000);
afterAll(async () => {
  await manageFirestore(manager).setRules(rules(false));
});

const raw = nativeFirestore(nativeApp({ apiKey: web.apiKey, appId: web.appId, projectId: project }, 'live-raw'));
firestoreSuite(`live ${project} · web SDK`, 'client', async (tag) => {
  const app = initializeApp(fsConfig, 'test', { name: tag, firebase: { apiKey: web.apiKey, appId: web.appId, projectId: project } });
  return { app, db: getFirestore(app), rawSet: async (path: string, data: Record<string, unknown>) => void (await nativeSet(nativeDoc(raw, path), data)) };
});

databaseSuite(`live ${project} · firebase-admin`, async (tag) => {
  const app = initializeAdminApp(dbConfig, 'test', { name: `db-${tag}`, credential });
  return { app, db: getAdminDatabase(app) };
});
