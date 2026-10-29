// icebase/manage — set a project up from code instead of the Firebase console: create
// databases and buckets, deploy the schema's indexes and the rules files. New in IceBase
// (not a Firebase SDK module). Needs an admin app (initializeAdminApp).
//
// firebase mode calls Google's management REST APIs with the admin credential. emulator mode
// calls the IceBase server's management API (/__/icebase/admin/manage/…, the admin token):
// named databases and buckets are kept with its data; rules and the schema set this way replace
// the config's until the server restarts; a hosting release is served by `icebase serve`.

import type { IceBaseApp } from '@panth977/icebase/app';
import type { Service } from '@panth977/icebase/config';
import { IceBaseError } from '@panth977/icebase/errors';
import { collectionIndexes, collectionOverrides, firestoreIndexesJson, indexKey, type IndexesFile, type IndexJson } from './internal/firebase-indexes.ts';
import { googleClient, type GoogleClient } from './internal/google-rest.ts';
import type { AnyCollection, Schema } from '@panth977/icebase/schema';
import { Buffer } from 'node:buffer';

export { firestoreIndexesJson } from './internal/firebase-indexes.ts';
export type { IndexesFile } from './internal/firebase-indexes.ts';

function adminOnly(app: IceBaseApp, what: string, svc: Service): 'firebase' | 'emulator' {
  if (app.kind !== 'admin') throw new IceBaseError('invalid-argument', `${what} needs an admin app (initializeAdminApp from icebase/admin)`, { reason: 'config' });
  // vm services read 'emulator' on an app: the IceBase server either way.
  return app.modes[svc] === 'firebase' ? 'firebase' : 'emulator';
}

/** emulator mode: the IceBase server's management API, POST /__/icebase/admin/manage/<service>/<op> with the admin token. */
async function onServer<T>(app: IceBaseApp, svc: string, op: string, body: Record<string, unknown> = {}): Promise<T> {
  const { emulatorFetch, emulatorOrigin } = await import('@panth977/icebase/app');
  const token = app.options.emulator?.adminToken ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ICEBASE_ADMIN_TOKEN ?? 'owner';
  const res = await emulatorFetch(`${emulatorOrigin(app)}/__/icebase/admin/manage/${svc}/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { error?: { code: IceBaseError['code']; message: string } } & T;
  if (!res.ok || j.error) throw new IceBaseError(j.error?.code ?? 'internal', j.error?.message ?? `manage ${svc}.${op}: ${res.status}`, { reason: 'management', service: svc });
  return j;
}

// ─── rules (shared by Firestore and Storage) ───────────────────────────────────

const RULES = 'https://firebaserules.googleapis.com/v1';

/** Create a ruleset from one file and point a release at it (what `firebase deploy --only firestore:rules` does). */
async function releaseRules(g: GoogleClient, release: string, fileName: string, content: string): Promise<{ ruleset: string; release: string }> {
  const ruleset = await g.call<{ name: string }>('POST', `${RULES}/projects/${g.projectId}/rulesets`, { source: { files: [{ name: fileName, content }] } });
  const name = `projects/${g.projectId}/releases/${release}`;
  const existing = await g.call('GET', `${RULES}/${name}`, undefined, { allow404: true });
  if (existing) await g.call('PATCH', `${RULES}/${name}`, { release: { name, rulesetName: ruleset.name } });
  else await g.call('POST', `${RULES}/projects/${g.projectId}/releases`, { name, rulesetName: ruleset.name });
  return { ruleset: ruleset.name, release: name };
}

async function loadRules(source: string | { file: string }): Promise<string> {
  if (typeof source === 'string') return source;
  const { readFile } = await import('node:fs/promises');
  return readFile(source.file, 'utf8');
}

// ─── Firestore ─────────────────────────────────────────────────────────────────

const FIRESTORE = 'https://firestore.googleapis.com/v1';

export interface FirestoreDatabaseInfo {
  name: string;
  id: string;
  locationId: string;
  type: string;
}

export interface IndexSync {
  created: IndexJson[];
  deleted: string[];
  unchanged: number;
  fieldOverrides: number;
}

export interface FirestoreManager {
  /** Create a Firestore database (Native mode). '(default)' is the default database. */
  createDb(id?: string, opts?: { location?: string }): Promise<FirestoreDatabaseInfo>;
  listDbs(): Promise<FirestoreDatabaseInfo[]>;
  /** Deploy everything the schema implies: composite indexes, noIndex exemptions, TTL, collection-group scopes. */
  setSchema(schema?: Schema<Record<string, AnyCollection>, any, any>, opts?: { database?: string; prune?: boolean; wait?: boolean }): Promise<IndexSync>;
  /** Deploy composite indexes only (from the schema, or the given file). `prune` deletes indexes that are not declared. `wait`: until every declared index is READY (including ones an earlier call started). */
  setIndexes(indexes?: IndexesFile | Schema<Record<string, AnyCollection>, any, any>, opts?: { database?: string; prune?: boolean; wait?: boolean }): Promise<IndexSync>;
  /** Deploy firestore.rules (source text, or { file }). Default: config.rules.firestore. */
  setRules(source?: string | { file: string }, opts?: { database?: string }): Promise<{ ruleset: string; release: string }>;
  /** The indexes as built: on Firebase each composite with its state (CREATING / READY); on the IceBase server the SQL indexes made from the schema. */
  listIndexes(opts?: { database?: string }): Promise<{ collectionGroup: string; queryScope?: string; fields: string; state: string }[]>;
}

export function manageFirestore(app: IceBaseApp): FirestoreManager {
  const mode = adminOnly(app, 'manageFirestore', 'firestore');
  if (mode === 'emulator') {
    const schemaBody = async (x?: Schema<Record<string, AnyCollection>, any, any>) => {
      const { schemaToJson } = await import('@panth977/icebase/schema');
      return { schema: schemaToJson(x ?? app.config.schema) };
    };
    return {
      createDb: (id = '(default)') => onServer(app, 'firestore', 'createDb', { id }),
      async listIndexes(opts = {}) {
        const r = await onServer<{ databases: { id: string; sqlIndexes: string[] }[] }>(app, 'firestore', 'sqlIndexes');
        const d = r.databases.find((x) => x.id === (opts.database ?? '(default)'));
        return (d?.sqlIndexes ?? []).map((line) => ({ collectionGroup: line.split(':')[0]!, fields: line.split(':').slice(1).join(':').trim(), state: 'READY' }));
      },
      listDbs: async () => (await onServer<{ databases: FirestoreDatabaseInfo[] }>(app, 'firestore', 'listDbs')).databases,
      setSchema: async (schema) => onServer(app, 'firestore', 'setSchema', await schemaBody(schema)),
      setIndexes: async (indexes) => onServer(app, 'firestore', 'setIndexes', !indexes || 'collections' in indexes ? await schemaBody(indexes as Schema<Record<string, AnyCollection>, any, any> | undefined) : { indexes }),
      async setRules(source, opts = {}) {
        const src = source ?? (app.config.rules?.firestore ? { file: app.config.rules.firestore } : undefined);
        if (!src) throw new IceBaseError('invalid-argument', 'setRules(): no rules given and config.rules.firestore is not set');
        return onServer(app, 'firestore', 'setRules', { source: await loadRules(src), ...(opts.database ? { database: opts.database } : {}) });
      },
    };
  }
  const g = googleClient(app, 'firestore');
  const dbPath = (id = '(default)') => `projects/${g.projectId}/databases/${id}`;
  const info = (d: { name: string; locationId: string; type: string }): FirestoreDatabaseInfo => ({ name: d.name, id: d.name.split('/').pop()!, locationId: d.locationId, type: d.type });

  const syncIndexes = async (file: IndexesFile, database: string | undefined, prune: boolean, wait: boolean, withOverrides: boolean): Promise<IndexSync> => {
    const base = `${FIRESTORE}/${dbPath(database)}/collectionGroups`;
    type Listed = { name: string; queryScope: string; state?: string; fields: { fieldPath: string; order?: string; arrayConfig?: string }[] };
    const list = async () => {
      const listed: Listed[] = [];
      let pageToken: string | undefined;
      do {
        const page = await g.call<{ indexes?: Listed[]; nextPageToken?: string }>('GET', `${base}/-/indexes${pageToken ? `?pageToken=${pageToken}` : ''}`);
        listed.push(...(page.indexes ?? []));
        pageToken = page.nextPageToken;
      } while (pageToken);
      return listed.map((ix) => ({ ...ix, key: indexKey({ collectionGroup: ix.name.split('/')[ix.name.split('/').indexOf('collectionGroups') + 1]!, queryScope: ix.queryScope, fields: ix.fields as IndexJson['fields'] }) }));
    };
    const listed = await list();
    const existing = new Map(listed.map((ix) => [ix.key, ix.name]));
    const wanted = new Set(file.indexes.map(indexKey));
    const created: IndexJson[] = [];
    const ops: Promise<unknown>[] = [];
    for (const ix of file.indexes) {
      if (existing.has(indexKey(ix))) continue;
      created.push(ix);
      ops.push(
        g.call<{ name: string; done?: boolean }>('POST', `${base}/${ix.collectionGroup}/indexes`, { queryScope: ix.queryScope, fields: ix.fields }).then((op) => (wait ? g.wait(FIRESTORE, op, 900_000) : op)),
      );
    }
    const deleted: string[] = [];
    if (prune) {
      for (const [key, name] of existing) {
        if (wanted.has(key)) continue;
        deleted.push(name);
        ops.push(g.call('DELETE', `${FIRESTORE}/${name}`));
      }
    }
    if (withOverrides) {
      for (const o of file.fieldOverrides) {
        const url = `${base}/${o.collectionGroup}/fields/${encodeURIComponent(o.fieldPath)}?updateMask=indexConfig,ttlConfig`;
        ops.push(
          g.call('PATCH', url, {
            indexConfig: { indexes: o.indexes.map((i) => ({ queryScope: i.queryScope, fields: [{ fieldPath: o.fieldPath, ...(i.order ? { order: i.order } : { arrayConfig: i.arrayConfig }) }] })) },
            ...(o.ttl ? { ttlConfig: {} } : {}),
          }),
        );
      }
    }
    await Promise.all(ops);
    // Until every declared index serves queries: the new ones and any still building from before.
    if (wait) {
      const until = Date.now() + 1_800_000;
      for (;;) {
        const state = new Map((await list()).map((ix) => [ix.key, ix.state]));
        let pending = file.indexes.filter((ix) => state.get(indexKey(ix)) !== 'READY').length;
        if (withOverrides) {
          for (const o of file.fieldOverrides) {
            const fld = await g.call<{ indexConfig?: { indexes?: { state?: string }[] } }>('GET', `${base}/${o.collectionGroup}/fields/${encodeURIComponent(o.fieldPath)}`);
            if ((fld.indexConfig?.indexes ?? []).some((i) => i.state && i.state !== 'READY')) pending++;
          }
        }
        if (!pending) break;
        if (Date.now() > until) throw new IceBaseError('deadline-exceeded', `${pending} index(es) are still building after 30 minutes`, { reason: 'management', service: 'firestore' });
        await new Promise((r) => setTimeout(r, 10_000));
      }
    }
    return { created, deleted, unchanged: file.indexes.length - created.length, fieldOverrides: withOverrides ? file.fieldOverrides.length : 0 };
  };

  const toFile = (x: IndexesFile | Schema<Record<string, AnyCollection>, any, any> | undefined): IndexesFile => {
    if (!x) return firestoreIndexesJson(app.config.schema);
    if ('collections' in x) return firestoreIndexesJson(x);
    return x;
  };

  return {
    async createDb(id = '(default)', opts = {}) {
      const op = await g.call<{ name: string; done?: boolean }>('POST', `${FIRESTORE}/projects/${g.projectId}/databases?databaseId=${encodeURIComponent(id)}`, {
        locationId: opts.location ?? 'nam5',
        type: 'FIRESTORE_NATIVE',
      });
      const created = await g.wait<{ name: string; locationId: string; type: string }>(FIRESTORE, op);
      return info(created ?? (await g.call('GET', `${FIRESTORE}/${dbPath(id)}`)));
    },
    async listDbs() {
      const r = await g.call<{ databases?: { name: string; locationId: string; type: string }[] }>('GET', `${FIRESTORE}/projects/${g.projectId}/databases`);
      return (r.databases ?? []).map(info);
    },
    setSchema: (schema, opts = {}) => syncIndexes(toFile(schema), opts.database, opts.prune ?? false, opts.wait ?? false, true),
    async listIndexes(opts = {}) {
      const out: { collectionGroup: string; queryScope: string; fields: string; state: string }[] = [];
      let pageToken: string | undefined;
      do {
        const page = await g.call<{ indexes?: { name: string; queryScope: string; state: string; fields: { fieldPath: string; order?: string; arrayConfig?: string }[] }[]; nextPageToken?: string }>('GET', `${FIRESTORE}/${dbPath(opts.database)}/collectionGroups/-/indexes${pageToken ? `?pageToken=${pageToken}` : ''}`);
        for (const ix of page.indexes ?? []) {
          const parts = ix.name.split('/');
          out.push({ collectionGroup: parts[parts.indexOf('collectionGroups') + 1]!, queryScope: ix.queryScope, state: ix.state, fields: ix.fields.filter((f) => f.fieldPath !== '__name__').map((f) => `${f.fieldPath} ${(f.order ?? f.arrayConfig ?? '').toLowerCase()}`).join(', ') });
        }
        pageToken = page.nextPageToken;
      } while (pageToken);
      return out;
    },
    setIndexes: (indexes, opts = {}) => {
      const file = toFile(indexes);
      return syncIndexes(file, opts.database, opts.prune ?? false, opts.wait ?? false, false);
    },
    async setRules(source, opts = {}) {
      const src = source ?? (app.config.rules?.firestore ? { file: app.config.rules.firestore } : undefined);
      if (!src) throw new IceBaseError('invalid-argument', 'setRules(): no rules given and config.rules.firestore is not set');
      const db = opts.database && opts.database !== '(default)' ? `cloud.firestore/${opts.database}` : 'cloud.firestore';
      return releaseRules(g, db, 'firestore.rules', await loadRules(src));
    },
  };
}

/** @internal for tests: the per-collection pieces of the generated file. */
export const _indexParts = { collectionIndexes, collectionOverrides };
/** @internal */
export const _rules = { releaseRules, loadRules };

// ─── Auth ──────────────────────────────────────────────────────────────────────

const IDTK = 'https://identitytoolkit.googleapis.com/admin/v2';

export interface ProviderSettings {
  password?: boolean;
  /** Passwordless email link (Firebase's own sender; leave off when config.auth.custom.email is set). */
  emailLink?: boolean;
  phone?: boolean;
  anonymous?: boolean;
  /** Google through Firebase. With config.auth.custom.google IceBase uses your OAuth client instead and this can stay off. */
  google?: false | { clientIdEnv: string; clientSecretEnv: string } | { clientId: string; clientSecret: string };
}

export interface AuthManager {
  /** Turn Authentication on for a project that has never used it (what "Get started" does in the console). Safe to call again. */
  enable(): Promise<void>;
  /** Enable / disable sign-in methods from code (what Authentication › Sign-in method does in the console). */
  setProviders(p?: ProviderSettings): Promise<void>;
  /** Domains allowed for OAuth redirects and email links. */
  setAuthorizedDomains(domains: string[]): Promise<void>;
  getConfig(): Promise<unknown>;
}

export function manageAuth(app: IceBaseApp): AuthManager {
  const mode = adminOnly(app, 'manageAuth', 'auth');
  const fromConfig = (): ProviderSettings => {
    const ps = app.config.auth?.providers ?? [];
    const custom = app.config.auth?.custom;
    return {
      password: ps.includes('password'),
      // A method IceBase has taken over stays off in Firebase, so Firebase never sends its own email/SMS.
      emailLink: ps.includes('emailLink') && !custom?.email,
      phone: ps.includes('phone') && !custom?.phone,
      anonymous: ps.includes('anonymous'),
      google: false,
    };
  };
  if (mode === 'emulator') {
    return {
      // Auth is always on on an IceBase server.
      enable: async () => {},
      // Google sign-in there is your OAuth client (config.auth.custom.google); the rest is stored and enforced.
      setProviders: async (p = fromConfig()) => void (await onServer(app, 'auth', 'setProviders', { ...p, google: undefined })),
      setAuthorizedDomains: async (domains) => void (await onServer(app, 'auth', 'setAuthorizedDomains', { domains })),
      getConfig: () => onServer(app, 'auth', 'getConfig'),
    };
  }
  const g = googleClient(app, 'auth');
  const cfgUrl = `${IDTK}/projects/${g.projectId}/config`;
  return {
    async enable() {
      if (await g.call('GET', cfgUrl, undefined, { allow404: true })) return;
      try {
        await g.call('POST', `https://identitytoolkit.googleapis.com/v2/projects/${g.projectId}/identityPlatform:initializeAuth`, {});
      } catch (e) {
        // Google only lets code turn Auth on for projects with billing; on Spark it is one click in the console.
        if (/BILLING_NOT_ENABLED/.test((e as Error).message)) {
          throw new IceBaseError('failed-precondition', `Authentication is not set up on ${g.projectId} yet, and Google only allows that from code on the Blaze plan. Open https://console.firebase.google.com/project/${g.projectId}/authentication and press "Get started" once, then run this again.`, { reason: 'management', service: 'auth' });
        }
        throw e;
      }
    },
    async setProviders(p = fromConfig()) {
      const signIn: Record<string, unknown> = {};
      const mask: string[] = [];
      if (p.password !== undefined || p.emailLink !== undefined) {
        signIn.email = { enabled: !!(p.password || p.emailLink), passwordRequired: !p.emailLink };
        mask.push('signIn.email.enabled', 'signIn.email.passwordRequired');
      }
      if (p.phone !== undefined) {
        signIn.phoneNumber = { enabled: p.phone };
        mask.push('signIn.phoneNumber.enabled');
      }
      if (p.anonymous !== undefined) {
        signIn.anonymous = { enabled: p.anonymous };
        mask.push('signIn.anonymous.enabled');
      }
      if (mask.length) await g.call('PATCH', `${cfgUrl}?updateMask=${mask.join(',')}`, { signIn });
      if (p.google !== undefined) {
        const name = `projects/${g.projectId}/defaultSupportedIdpConfigs/google.com`;
        if (p.google === false) {
          const existing = await g.call('GET', `${IDTK}/${name}`, undefined, { allow404: true });
          if (existing) await g.call('PATCH', `${IDTK}/${name}?updateMask=enabled`, { enabled: false });
        } else {
          const { readEnv } = await import('@panth977/icebase/config');
          const clientId = 'clientId' in p.google ? p.google.clientId : readEnv(p.google.clientIdEnv);
          const clientSecret = 'clientSecret' in p.google ? p.google.clientSecret : readEnv(p.google.clientSecretEnv);
          if (!clientId || !clientSecret) throw new IceBaseError('failed-precondition', 'setProviders: the Google client id / secret env vars are not set', { reason: 'config' });
          const body = { enabled: true, clientId, clientSecret };
          const existing = await g.call('GET', `${IDTK}/${name}`, undefined, { allow404: true });
          if (existing) await g.call('PATCH', `${IDTK}/${name}?updateMask=enabled,clientId,clientSecret`, body);
          else await g.call('POST', `${IDTK}/projects/${g.projectId}/defaultSupportedIdpConfigs?idpId=google.com`, body);
        }
      }
    },
    async setAuthorizedDomains(domains) {
      await g.call('PATCH', `${cfgUrl}?updateMask=authorizedDomains`, { authorizedDomains: domains });
    },
    getConfig: () => g.call('GET', cfgUrl),
  };
}

// ─── Realtime Database ─────────────────────────────────────────────────────────

const RTDB_MGMT = 'https://firebasedatabase.googleapis.com/v1beta';

export interface DatabaseInstanceInfo {
  name: string;
  id: string;
  databaseUrl: string;
  type: string;
  state: string;
}

export interface DatabaseManager {
  /** Create a Realtime Database instance. The project's first one is its default database. */
  createDb(id?: string, opts?: { location?: string; default?: boolean }): Promise<DatabaseInstanceInfo>;
  listDbs(): Promise<DatabaseInstanceInfo[]>;
  /** Deploy database.rules.json: config.rules.database (or `rules`), plus .indexOn from the schema and the custom-auth store rules. */
  setRules(rules?: { rules: Record<string, unknown> }, opts?: { url?: string }): Promise<{ rules: Record<string, unknown> }>;
}

export function manageDatabase(app: IceBaseApp): DatabaseManager {
  const mode = adminOnly(app, 'manageDatabase', 'database');
  // database.rules.json as deployed: the given (or config) rules, .indexOn from the schema, the custom-auth store's rules.
  const rulesJson = async (rules?: { rules: Record<string, unknown> }) => {
    const { databaseRulesJson } = await import('@panth977/icebase/database');
    const { customAuthDatabaseRules } = await import('@panth977/icebase-server/auth');
    let base = rules;
    if (!base) {
      if (app.config.rules?.database) {
        const { readFile } = await import('node:fs/promises');
        base = JSON.parse(await readFile(app.config.rules.database, 'utf8')) as { rules: Record<string, unknown> };
      } else base = { rules: {} };
    }
    let out = databaseRulesJson(app.config.schema.paths ?? {}, base);
    if (app.config.auth?.custom) out = { rules: deepMerge(out.rules, customAuthDatabaseRules(app.config)) };
    return out;
  };
  if (mode === 'emulator') {
    return {
      createDb: (id, _opts) => onServer(app, 'database', 'createDb', id ? { id } : {}),
      listDbs: async () => (await onServer<{ instances: DatabaseInstanceInfo[] }>(app, 'database', 'listDbs')).instances,
      async setRules(rules, opts = {}) {
        const { instanceOfUrl } = await import('@panth977/icebase/internal');
        const out = await rulesJson(rules);
        const instance = instanceOfUrl(opts.url ?? app.config.firebase?.databaseURL);
        await onServer(app, 'database', 'setRules', { rules: out, ...(instance ? { instance } : {}) });
        return out;
      },
    };
  }
  const g = googleClient(app, 'database');
  const info = (d: { name: string; databaseUrl: string; type: string; state: string }): DatabaseInstanceInfo => ({ ...d, id: d.name.split('/').pop()! });
  return {
    async createDb(id = `${g.projectId}-default-rtdb`, opts = {}) {
      const loc = opts.location ?? 'us-central1';
      const type = opts.default ?? id === `${g.projectId}-default-rtdb` ? 'DEFAULT_DATABASE' : 'USER_DATABASE';
      return info(await g.call('POST', `${RTDB_MGMT}/projects/${g.projectId}/locations/${loc}/instances?databaseId=${encodeURIComponent(id)}`, { type }));
    },
    async listDbs() {
      const r = await g.call<{ instances?: { name: string; databaseUrl: string; type: string; state: string }[] }>('GET', `${RTDB_MGMT}/projects/${g.projectId}/locations/-/instances`);
      return (r.instances ?? []).map(info);
    },
    async setRules(rules, opts = {}) {
      const out = await rulesJson(rules);
      const url = (opts.url ?? app.config.firebase?.databaseURL ?? `https://${g.projectId}-default-rtdb.firebaseio.com`).replace(/\/$/, '');
      await g.call('PUT', `${url}/.settings/rules.json`, undefined, { raw: JSON.stringify(out), headers: { 'content-type': 'application/json' } });
      return out;
    },
  };
}

function deepMerge(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const cur = out[k];
    out[k] = cur && typeof cur === 'object' && !Array.isArray(cur) && v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(cur as Record<string, unknown>, v as Record<string, unknown>) : v;
  }
  return out;
}

// ─── Cloud Storage ─────────────────────────────────────────────────────────────

const FB_STORAGE = 'https://firebasestorage.googleapis.com';

export interface StorageManager {
  /** Create a bucket and link it to Firebase. Without a name: the project's default bucket (<project>.firebasestorage.app). */
  createBucket(name?: string, opts?: { location?: string }): Promise<{ name: string }>;
  listBuckets(): Promise<string[]>;
  /** Deploy storage.rules (source text, or { file }) to a bucket. Default: config.rules.storage, default bucket. */
  setRules(source?: string | { file: string }, opts?: { bucket?: string }): Promise<{ ruleset: string; release: string }>;
}

export function manageStorage(app: IceBaseApp): StorageManager {
  const mode = adminOnly(app, 'manageStorage', 'storage');
  if (mode === 'emulator') {
    return {
      createBucket: (name) => onServer(app, 'storage', 'createBucket', name ? { name } : {}),
      listBuckets: async () => (await onServer<{ buckets: string[] }>(app, 'storage', 'listBuckets')).buckets,
      async setRules(source, opts = {}) {
        const src = source ?? (app.config.rules?.storage ? { file: app.config.rules.storage } : undefined);
        if (!src) throw new IceBaseError('invalid-argument', 'setRules(): no rules given and config.rules.storage is not set');
        return onServer(app, 'storage', 'setRules', { source: await loadRules(src), ...(opts.bucket ? { bucket: opts.bucket } : {}) });
      },
    };
  }
  const g = googleClient(app, 'storage');
  const defaultBucket = () => app.config.firebase?.storageBucket ?? `${g.projectId}.firebasestorage.app`;
  return {
    async createBucket(name, opts = {}) {
      const location = opts.location ?? 'US-CENTRAL1';
      if (!name) {
        const r = await g.call<{ bucket?: { name: string }; name?: string }>('POST', `${FB_STORAGE}/v1alpha/projects/${g.projectId}/defaultBucket`, { location, storageClass: 'STANDARD' });
        return { name: r.bucket?.name?.split('/').pop() ?? defaultBucket() };
      }
      await g.call('POST', `https://storage.googleapis.com/storage/v1/b?project=${g.projectId}`, { name, location });
      await g.call('POST', `${FB_STORAGE}/v1beta/projects/${g.projectId}/buckets/${name}:addFirebase`, {});
      return { name };
    },
    async listBuckets() {
      const r = await g.call<{ buckets?: { name: string }[] }>('GET', `${FB_STORAGE}/v1beta/projects/${g.projectId}/buckets`);
      return (r.buckets ?? []).map((b) => b.name.split('/').pop()!);
    },
    async setRules(source, opts = {}) {
      const src = source ?? (app.config.rules?.storage ? { file: app.config.rules.storage } : undefined);
      if (!src) throw new IceBaseError('invalid-argument', 'setRules(): no rules given and config.rules.storage is not set');
      return releaseRules(g, `firebase.storage/${opts.bucket ?? defaultBucket()}`, 'storage.rules', await loadRules(src));
    },
  };
}

// ─── Hosting ───────────────────────────────────────────────────────────────────

const HOSTING = 'https://firebasehosting.googleapis.com/v1beta1';

export interface HostingConfigJson {
  rewrites?: ({ glob: string; path: string } | { glob: string; run: { serviceId: string; region: string } })[];
  redirects?: { glob: string; location: string; statusCode: number }[];
  headers?: { glob: string; headers: Record<string, string> }[];
  cleanUrls?: boolean;
  trailingSlashBehavior?: 'ADD' | 'REMOVE';
}

/** config.hosting (firebase.json shape) → the Hosting API's version config. */
export function hostingVersionConfig(h: NonNullable<IceBaseApp['config']['hosting']>, region = 'us-central1', customAuth = false): HostingConfigJson {
  const rewrites: NonNullable<HostingConfigJson['rewrites']> = [];
  // Custom auth's endpoint on the site's own origin too (custom-auth.html §4), as on the IceBase server.
  if (customAuth) rewrites.push({ glob: '/__/icebase/auth/**', run: { serviceId: 'icebaseauth', region } });
  for (const r of h.rewrites ?? []) {
    if ('function' in r) {
      const fn = typeof r.function === 'string' ? { functionId: r.function, region: r.region } : r.function;
      rewrites.push({ glob: r.source, run: { serviceId: fn.functionId.toLowerCase(), region: fn.region ?? r.region ?? region } });
    } else rewrites.push({ glob: r.source, path: r.destination });
  }
  if (h.spa) rewrites.push({ glob: '**', path: '/index.html' });
  return {
    ...(rewrites.length ? { rewrites } : {}),
    ...(h.redirects?.length ? { redirects: h.redirects.map((r) => ({ glob: r.source, location: r.destination, statusCode: r.type ?? 301 })) } : {}),
    ...(h.headers?.length ? { headers: h.headers.map((x) => ({ glob: x.source, headers: x.headers })) } : {}),
    ...(h.cleanUrls !== undefined ? { cleanUrls: h.cleanUrls } : {}),
    ...(h.trailingSlash !== undefined ? { trailingSlashBehavior: h.trailingSlash ? 'ADD' : 'REMOVE' } : {}),
  };
}

export interface DnsRecord {
  domainName: string;
  type: string;
  rdata: string;
  requiredAction?: string;
}

export interface HostingManager {
  /** Create a Hosting site (<siteId>.web.app). */
  createSite(siteId: string): Promise<{ name: string; defaultUrl: string }>;
  listSites(): Promise<{ name: string; defaultUrl: string }[]>;
  /** Upload a directory as a new version and release it. Default: config.hosting.public to config.hosting.site (or the project's default site). */
  deploy(opts?: { site?: string; dir?: string; message?: string }): Promise<{ version: string; release: string; files: number; uploaded: number; url: string }>;
  /** Connect a custom domain; returns the DNS records to set at your registrar and the current state. */
  setDNS(domain: string, opts?: { site?: string; redirectTarget?: string }): Promise<{ domain: string; hostState?: string; ownershipState?: string; records: DnsRecord[] }>;
}

export function manageHosting(app: IceBaseApp): HostingManager {
  const mode = adminOnly(app, 'manageHosting', 'hosting');
  if (mode === 'emulator') {
    return {
      createSite: (siteId) => onServer(app, 'hosting', 'createSite', { siteId }),
      listSites: async () => (await onServer<{ sites: { name: string; defaultUrl: string }[] }>(app, 'hosting', 'listSites')).sites,
      async deploy(opts = {}) {
        const dir = opts.dir ?? app.config.hosting?.public;
        if (!dir) throw new IceBaseError('invalid-argument', 'deploy(): no directory given and config.hosting.public is not set');
        const [{ readdir, readFile }, { join, relative, sep }] = await Promise.all([import('node:fs/promises'), import('node:path')]);
        const walk = async (d: string): Promise<string[]> => (await Promise.all((await readdir(d, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])))).flat();
        const files: Record<string, string> = {};
        for (const f of await walk(dir)) files[relative(dir, f).split(sep).join('/')] = (await readFile(f)).toString('base64');
        return onServer(app, 'hosting', 'deploy', { files, ...(opts.site ? { site: opts.site } : {}), ...(opts.message ? { message: opts.message } : {}) });
      },
      setDNS: (domain, opts = {}) => onServer(app, 'hosting', 'setDNS', { domain, ...(opts.site ? { site: opts.site } : {}) }),
    };
  }
  const g = googleClient(app, 'hosting');
  const siteOf = (s?: string) => s ?? app.config.hosting?.site ?? g.projectId;
  return {
    async createSite(siteId) {
      return g.call('POST', `${HOSTING}/projects/${g.projectId}/sites?siteId=${encodeURIComponent(siteId)}`, {});
    },
    async listSites() {
      const r = await g.call<{ sites?: { name: string; defaultUrl: string }[] }>('GET', `${HOSTING}/projects/${g.projectId}/sites`);
      return r.sites ?? [];
    },
    async deploy(opts = {}) {
      const site = siteOf(opts.site);
      const h = app.config.hosting;
      const dir = opts.dir ?? h?.public;
      if (!dir) throw new IceBaseError('invalid-argument', 'deploy(): no directory given and config.hosting.public is not set');
      const [{ readdir, readFile }, { join, relative, sep }, { gzipSync }, { createHash }] = await Promise.all([import('node:fs/promises'), import('node:path'), import('node:zlib'), import('node:crypto')]);
      const walk = async (d: string): Promise<string[]> => (await Promise.all((await readdir(d, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])))).flat();
      const files = await walk(dir);
      const gz = new Map<string, Buffer>();
      const manifest: Record<string, string> = {};
      for (const f of files) {
        const z = gzipSync(await readFile(f), { level: 9 });
        const hash = createHash('sha256').update(z).digest('hex');
        gz.set(hash, z);
        manifest[`/${relative(dir, f).split(sep).join('/')}`] = hash;
      }
      const version = await g.call<{ name: string }>('POST', `${HOSTING}/sites/${site}/versions`, { config: h ? hostingVersionConfig(h, app.config.functions?.region, !!app.config.auth?.custom && !app.config.auth.custom.endpoint) : {} });
      const pop = await g.call<{ uploadRequiredHashes?: string[]; uploadUrl: string }>('POST', `${HOSTING}/${version.name}:populateFiles`, { files: manifest });
      const need = pop.uploadRequiredHashes ?? [];
      for (let i = 0; i < need.length; i += 8) {
        await Promise.all(need.slice(i, i + 8).map((hash) => g.call('POST', `${pop.uploadUrl}/${hash}`, undefined, { raw: new Uint8Array(gz.get(hash)!), headers: { 'content-type': 'application/octet-stream' } })));
      }
      await g.call('PATCH', `${HOSTING}/${version.name}?update_mask=status`, { status: 'FINALIZED' });
      const release = await g.call<{ name: string }>('POST', `${HOSTING}/sites/${site}/releases?versionName=${encodeURIComponent(version.name)}`, opts.message ? { message: opts.message } : {});
      return { version: version.name, release: release.name, files: files.length, uploaded: need.length, url: `https://${site}.web.app` };
    },
    async setDNS(domain, opts = {}) {
      const site = siteOf(opts.site);
      const base = `${HOSTING}/projects/${g.projectId}/sites/${site}/customDomains`;
      let cd = await g.call<{ hostState?: string; ownershipState?: string; requiredDnsUpdates?: { desired?: { domainName: string; records?: DnsRecord[] }[] } }>('GET', `${base}/${domain}`, undefined, { allow404: true });
      if (!cd) {
        const op = await g.call<{ name: string; done?: boolean }>('POST', `${base}?customDomainId=${encodeURIComponent(domain)}`, opts.redirectTarget ? { redirectTarget: opts.redirectTarget } : {});
        void op;
        // The records appear on the custom domain as soon as it exists; the operation itself runs until DNS is live.
        for (let i = 0; i < 10 && !cd?.requiredDnsUpdates; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          cd = await g.call('GET', `${base}/${domain}`, undefined, { allow404: true });
        }
      }
      const records = (cd?.requiredDnsUpdates?.desired ?? []).flatMap((d) => (d.records ?? []).map((r) => ({ ...r, domainName: r.domainName ?? d.domainName })));
      return { domain, ...(cd?.hostState ? { hostState: cd.hostState } : {}), ...(cd?.ownershipState ? { ownershipState: cd.ownershipState } : {}), records };
    },
  };
}
