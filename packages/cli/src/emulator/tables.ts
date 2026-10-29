// The tables of each store, in one place: the services create them when they start, and
// `icebase migrate` creates them in the store it copies into. Text keys compare bytewise on both
// dialects (Store.types.text); SQLite files made before Postgres existed keep their exact shape.

import type { Store } from './store.ts';

/** Firestore ('firestore', 'firestore-<db>'): documents and the commit version. Indexes come from the schema (FirestoreEngine). */
export async function firestoreTables(s: Store): Promise<void> {
  const { text, json, int } = s.types;
  if (s.dialect === 'sqlite') await s.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 10000;`);
  await s.exec(`
    CREATE TABLE IF NOT EXISTS docs (
      path ${text} PRIMARY KEY,
      coll ${text} NOT NULL,
      parent ${text} NOT NULL,
      id ${text} NOT NULL,
      data ${json} NOT NULL,
      ct_s ${int} NOT NULL, ct_n ${int} NOT NULL,
      ut_s ${int} NOT NULL, ut_n ${int} NOT NULL,
      version ${int} NOT NULL
    );
    CREATE INDEX IF NOT EXISTS docs_parent ON docs (parent, path);
    CREATE INDEX IF NOT EXISTS docs_coll ON docs (coll, path);
    CREATE TABLE IF NOT EXISTS meta (k ${text} PRIMARY KEY, v TEXT);
  `);
}

/** Auth ('auth'): users, refresh tokens, email action codes, phone codes. */
export async function authTables(s: Store): Promise<void> {
  const { text: T, int: I } = s.types;
  await s.exec(`
    CREATE TABLE IF NOT EXISTS users (uid ${T} PRIMARY KEY, email ${T}, phone ${T}, rec TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email) WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_phone ON users (phone) WHERE phone IS NOT NULL;
    CREATE TABLE IF NOT EXISTS refresh (token ${T} PRIMARY KEY, uid ${T} NOT NULL, provider TEXT NOT NULL${s.dialect === 'postgres' ? ', claims TEXT' : ''});
    CREATE TABLE IF NOT EXISTS oob (code ${T} PRIMARY KEY, email TEXT, kind TEXT NOT NULL, uid TEXT, link TEXT, at ${I} NOT NULL);
    CREATE TABLE IF NOT EXISTS phone_codes (session ${T} PRIMARY KEY, phone TEXT NOT NULL, code TEXT NOT NULL, at ${I} NOT NULL);
  `);
  // A session's own claims (a custom token's, beforeUserSignedIn's sessionClaims) ride on its
  // refreshed tokens too, and never on the user's other sessions. (Added after the first SQLite files.)
  if (s.dialect === 'sqlite' && !(await s.all<{ name: string }>(`PRAGMA table_info(refresh)`)).some((c) => c.name === 'claims')) await s.exec(`ALTER TABLE refresh ADD COLUMN claims TEXT`);
}

/** Storage ('storage'): object metadata and resumable uploads in progress (the bytes are blobs, outside). */
export async function storageTables(s: Store): Promise<void> {
  const { text: T, blob: B } = s.types;
  await s.exec(`CREATE TABLE IF NOT EXISTS objects (bucket ${T} NOT NULL, name ${T} NOT NULL, meta TEXT NOT NULL, PRIMARY KEY (bucket, name));
            CREATE TABLE IF NOT EXISTS uploads (id ${T} PRIMARY KEY, bucket TEXT NOT NULL, name TEXT NOT NULL, meta TEXT NOT NULL, data ${B})`);
}

/** Task queues ('tasks'). */
export async function taskTables(s: Store): Promise<void> {
  if (s.dialect === 'sqlite') await s.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;`);
  await s.exec(`CREATE TABLE IF NOT EXISTS tasks (id ${s.types.text} PRIMARY KEY, fn TEXT NOT NULL, data TEXT NOT NULL, run_at ${s.types.int} NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, scheduled TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS tasks_due ON tasks (run_at);`);
}

/** Realtime Database ('database', 'database-<instance>'): the whole tree as one JSON row. */
export async function treeTables(s: Store): Promise<void> {
  await s.exec(`CREATE TABLE IF NOT EXISTS tree (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL)`);
}

/** A store's tables by its name, and each table's key (the order rows are copied in). */
export function storeKind(name: string): { create(s: Store): Promise<void>; tables: Record<string, string[]> } | null {
  if (name === 'firestore' || name.startsWith('firestore-')) return { create: firestoreTables, tables: { docs: ['path'], meta: ['k'] } };
  if (name === 'auth') return { create: authTables, tables: { users: ['uid'], refresh: ['token'], oob: ['code'], phone_codes: ['session'] } };
  if (name === 'storage') return { create: storageTables, tables: { objects: ['bucket', 'name'], uploads: ['id'] } };
  if (name === 'tasks') return { create: taskTables, tables: { tasks: ['id'] } };
  if (name === 'database' || name.startsWith('database-')) return { create: treeTables, tables: { tree: ['id'] } };
  return null;
}
