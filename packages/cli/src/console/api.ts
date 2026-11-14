// The IceBase console's API: one JSON operation per POST to /__/icebase/console/api/<op>. Built
// on IceBase's own admin APIs (firebase-admin-shaped Firestore, admin Auth / Database / Storage,
// icebase/manage), so the same console runs on the IceBase server (emulator / vm) and, through
// `icebase console --env X`, against Firebase. The caller checks that the request is the admin's.

import type { IceBaseApp } from '@panth977/icebase/app';
import { readEnv, resolveModes, SERVICES, type AnyConfig } from '@panth977/icebase/config';
import { describe, openApi } from '@panth977/icebase/describe';
import { schemaTypeScript } from './typescript.ts';
import { IceBaseError } from '@panth977/icebase/errors';
import { matchCollectionPath } from '@panth977/icebase/schema';
import { getAdminAuth, getAdminDatabase, getAdminMessaging, getAdminRemoteConfig, getAdminStorage } from '@panth977/icebase-server/admin';
import { allParameters, paramToString, templateValueType } from '@panth977/icebase/internal';
import type { RemoteConfigParams } from '@panth977/icebase/config';
import { getAuthSecurity } from '@panth977/icebase-server/auth';
import { getFirestore, GeoPoint, Timestamp, type Firestore } from '@panth977/icebase-server/compat';
import type { FirestoreDriver } from '@panth977/icebase/internal';
import { Buffer } from 'node:buffer';
import { firestoreIndexesJson } from '../internal/firebase-indexes.ts';
import { manageAppCheck, manageAuth, manageFirestore, manageHosting, manageRemoteConfig, manageStorage } from '../manage.ts';

export interface ConsoleOptions {
  config: AnyConfig;
  env: string;
  /** The admin app the console acts as. */
  app: IceBaseApp;
  /** On the IceBase server: its own management API (functions, SQL indexes, health). */
  server?: { manage(service: string, op: string, body: Record<string, unknown>): Promise<unknown>; health(): unknown; rules(service: string): string | null };
  /** Where the app's site answers (for config.console.openapi paths). */
  siteOrigin?: string;
  /** Firebase mode: rules as deployed, and Cloud Functions (needs the management credential). */
  firebase?: { rules(service: 'firestore' | 'storage' | 'database'): Promise<string | null>; functions(): Promise<unknown[]> };
}

// ─── values to and from the console's JSON ─────────────────────────────────────

/** Firestore values as JSON the console can show and edit: { __ts }, { __ref }, { __geo }, { __bytes }. */
export function toJson(v: unknown): unknown {
  if (v === null || v === undefined || typeof v !== 'object') return v ?? null;
  if (v instanceof Timestamp || (typeof (v as { toDate?: unknown }).toDate === 'function' && 'seconds' in (v as object))) return { __ts: (v as Timestamp).toDate().toISOString() };
  if (v instanceof GeoPoint || ('latitude' in (v as object) && 'longitude' in (v as object) && Object.keys(v as object).length <= 2)) return { __geo: [(v as GeoPoint).latitude, (v as GeoPoint).longitude] };
  if (v instanceof Uint8Array) return { __bytes: Buffer.from(v).toString('base64') };
  if (typeof (v as { path?: unknown }).path === 'string' && typeof (v as { id?: unknown }).id === 'string' && 'firestore' in (v as object)) return { __ref: (v as { path: string }).path };
  if (Array.isArray(v)) return v.map(toJson);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, toJson(x)]));
}

export function fromJson(db: Firestore, v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => fromJson(db, x));
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    if (typeof o.__ts === 'string') return Timestamp.fromDate(new Date(o.__ts));
    if (typeof o.__ref === 'string') return db.doc(o.__ref);
    if (Array.isArray(o.__geo)) return new GeoPoint(Number(o.__geo[0]), Number(o.__geo[1]));
    if (typeof o.__bytes === 'string') return new Uint8Array(Buffer.from(o.__bytes, 'base64'));
  }
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, fromJson(db, x)]));
}

const str = (v: unknown, what: string): string => {
  if (typeof v !== 'string' || !v) throw new IceBaseError('invalid-argument', `${what} is required`);
  return v;
};
const segs = (p: string) => p.split('/').filter(Boolean);
/** Driver data's references ({ type: 'document', path }) as toJson's { __ref }. */
const fromDriverRefs = (v: unknown): unknown => {
  if (v === null || typeof v !== 'object' || v instanceof Uint8Array || v instanceof Timestamp || v instanceof GeoPoint) return v;
  if ((v as { type?: unknown }).type === 'document' && typeof (v as { path?: unknown }).path === 'string') return { path: (v as { path: string }).path, id: (v as { path: string }).path.split('/').pop(), firestore: null };
  if (Array.isArray(v)) return v.map(fromDriverRefs);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, fromDriverRefs(x)]));
};

// ─── the operations ────────────────────────────────────────────────────────────

export function consoleApi(o: ConsoleOptions): (op: string, b: Record<string, unknown>) => Promise<unknown> {
  const { config, env, app } = o;
  const modes = resolveModes(config, env);
  let fs: Firestore | null = null;
  const db = () => (fs ??= getFirestore(app));
  const custom = config.auth?.custom;
  const rawDriver = (): FirestoreDriver => (db() as unknown as { _driver: FirestoreDriver })._driver;
  /** A document the console may write: one in a declared collection. */
  const writable = (p: string): string => {
    const path = segs(p).join('/');
    const coll = path.split('/').slice(0, -1).join('/');
    if (!matchCollectionPath(config.schema, coll)) throw new IceBaseError('invalid-argument', `'${coll}' is not a collection in the schema, so the console only reads it; declare it with collection(…) to edit its documents`, { reason: 'unknown-collection', collection: coll });
    return path;
  };
  /** The declared collections an undeclared collection path leads to (an in-between collection), e.g. auth → auth/{section}/emails. */
  const leadsTo = (p: string): string[] => {
    const a = p.split('/');
    return Object.values(config.schema.collections)
      .map((c) => (c as { path: string }).path)
      .filter((t) => {
        const b = t.split('/');
        return b.length > a.length && a.every((s, i) => /^\{.+\}$/.test(b[i]!) || s === b[i]);
      })
      .sort();
  };

  const ops: Record<string, (b: Record<string, unknown>) => Promise<unknown> | unknown> = {
    // ── project ──
    async overview() {
      const doc = describe(config);
      const secrets: { name: string; set: boolean }[] = [];
      const add = (x: unknown) => {
        if (x && typeof x === 'object') for (const [k, v] of Object.entries(x)) if (k.endsWith('Env') && typeof v === 'string') secrets.push({ name: v, set: readEnv(v) !== undefined });
      };
      add(custom?.email?.sender);
      add(custom?.phone?.sender);
      add(custom?.google);
      return {
        name: config.name,
        env,
        environments: Object.keys(config.environments),
        projectId: config.firebase?.projectId ?? null,
        modes: Object.fromEntries(SERVICES.map((s) => [s, modes[s]])),
        health: (await o.server?.health()) ?? null,
        counts: { collections: doc.collections.length, paths: doc.paths.length, files: doc.files.length, endpoints: doc.endpoints.length },
        rules: config.rules ?? {},
        hosting: config.hosting ? { public: config.hosting.public, site: config.hosting.site ?? config.firebase?.projectId ?? null } : null,
        customAuth: custom ? { email: custom.email?.sender ? (typeof custom.email.sender === 'string' ? custom.email.sender : custom.email.sender.kind) : null, phone: custom.phone?.sender ? (typeof custom.phone.sender === 'string' ? custom.phone.sender : custom.phone.sender.kind) : null, google: !!custom.google } : null,
        secrets,
        problems: doc.problems,
      };
    },
    schema: () => describe(config),
    // The schema as TypeScript (the Schema page).
    'schema.ts': () => ({ blocks: schemaTypeScript(config) }),
    async apis() {
      // Everything the project serves: IceBase-declared endpoints, the deployed functions, and the
      // app's own OpenAPI documents (config.console.openapi).
      const doc = describe(config);
      const fns = await Promise.resolve(ops['fn.list']!({})).then((r: unknown) => (r as { functions: unknown[] }).functions).catch((e: Error) => ({ error: e.message }));
      const openapi = await Promise.all(
        (config.console?.openapi ?? []).map(async (d) => {
          const url = /^https?:/.test(d.path) ? d.path : `${(o.siteOrigin ?? '').replace(/\/$/, '')}${d.path}`;
          try {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`${r.status} from ${url}`);
            const doc = (await r.json()) as { servers?: unknown[] };
            // "Try it" needs the app's address: the site's, when it is one a browser can reach.
            if (!doc.servers?.length && o.siteOrigin && !/\/\/(127\.|localhost|\[::1\])/.test(o.siteOrigin)) doc.servers = [{ url: new URL(o.siteOrigin).origin }];
            return { title: d.title, url, doc };
          } catch (e) {
            return { title: d.title, url, error: (e as Error).message };
          }
        }),
      );
      // The endpoints declared with icebase/api, as OpenAPI too (the API reference shows every document alike).
      if (doc.endpoints.length) openapi.unshift({ title: 'Declared endpoints (icebase/api)', url: 'icebase.config', doc: openApi(config, doc) as never });
      return { endpoints: doc.endpoints, functions: fns, openapi };
    },

    // ── Firestore ──
    async 'fs.collections'(b) {
      const path = typeof b.path === 'string' && b.path ? b.path : null;
      const cols = path ? await db().doc(path).listCollections() : await db().listCollections();
      return { ids: cols.map((c) => c.id).sort() };
    },
    async 'fs.list'(b) {
      const path = segs(str(b.path, 'path')).join('/');
      const limit = Math.min(Number(b.limit ?? 50), 500);
      const after = typeof b.after === 'string' && b.after ? b.after : null;
      const declared = matchCollectionPath(config.schema, path);
      if (declared) {
        let q = db().collection(path).orderBy('__name__').limit(limit);
        if (after) q = q.startAfter(after);
        const snap = await q.get();
        return { declared: declared.collection.path, docs: snap.docs.map((d) => ({ id: d.id, path: d.ref.path, data: toJson(d.data()) })) };
      }
      // Not declared: read it as it is stored, like the Firebase console. Every document id, also
      // those that only hold subcollections (missing), and the data of the ones that exist; no
      // schema check, and the console does not write here.
      const driver = rawDriver();
      if (!driver.listDocumentIds) throw new IceBaseError('unimplemented', `'${path}' is not in the schema, and this Firestore cannot list it`);
      const ids = await driver.listDocumentIds(path, { limit, ...(after ? { after } : {}) });
      const present = ids.filter((d) => d.exists).map((d) => db().doc(`${path}/${d.id}`));
      const snaps = present.length ? await db().getAll(...present) : [];
      const data = new Map(snaps.map((x) => [x.id, x.exists ? toJson(x.data()) : null]));
      return {
        declared: null,
        undeclared: true,
        leadsTo: leadsTo(path),
        docs: ids.map((d) => ({ id: d.id, path: `${path}/${d.id}`, data: data.get(d.id) ?? null, missing: !d.exists || !data.has(d.id) })),
      };
    },
    async 'fs.get'(b) {
      const path = segs(str(b.path, 'path')).join('/');
      const declared = matchCollectionPath(config.schema, path.split('/').slice(0, -1).join('/'))?.collection.path ?? null;
      let d: { exists: boolean; data: unknown } | null = null;
      try {
        const s = await db().doc(path).get();
        d = { exists: s.exists, data: s.exists ? toJson(s.data()) : null };
      } catch (e) {
        if ((e as IceBaseError).details?.reason !== 'unknown-collection') throw e;
        // Firestore wrappers that refuse undeclared paths: the raw driver reads anything.
        const r = await rawDriver().get(path);
        d = { exists: !!r.data, data: r.data ? toJson(fromDriverRefs(r.data)) : null };
      }
      return { exists: d.exists, path, data: d.data, declared, ...(declared ? {} : { undeclared: true }) };
    },
    async 'fs.set'(b) {
      // Through IceBase: the schema checks the document as it checks the app's writes.
      const path = writable(str(b.path, 'path'));
      await db().doc(path).set(fromJson(db(), b.data) as Record<string, unknown>, b.merge ? { merge: true } : {});
      return { ok: true };
    },
    async 'fs.delete'(b) {
      await db().doc(writable(str(b.path, 'path'))).delete();
      return { ok: true };
    },
    async 'fs.query'(b) {
      // Only what the declared indexes allow: IceBase refuses anything else, as it does for the app.
      const path = str(b.path, 'path');
      const group = !!b.group;
      let q = group ? db().collectionGroup(path) : db().collection(path);
      for (const f of (b.filters ?? []) as { field: string; op: string; value: unknown }[]) q = q.where(f.field, f.op as never, fromJson(db(), f.value));
      for (const ob of (b.orders ?? []) as { field: string; dir?: 'asc' | 'desc' }[]) q = q.orderBy(ob.field, ob.dir ?? 'asc');
      q = q.limit(Math.min(Number(b.limit ?? 50), 500));
      const snap = await q.get();
      return { docs: snap.docs.map((d) => ({ id: d.id, path: d.ref.path, data: toJson(d.data()) })) };
    },
    async 'fs.indexes'() {
      const declared = firestoreIndexesJson(config.schema);
      let built: unknown = null;
      if (o.server) built = await o.server.manage('firestore', 'sqlIndexes', {});
      else if (modes.firestore === 'firebase') built = await manageFirestore(app).listIndexes().catch((e: Error) => ({ error: e.message }));
      return { declared, built };
    },

    // ── Realtime Database ──
    async 'db.get'(b) {
      const path = segs(String(b.path ?? '')).join('/');
      const driver = (getAdminDatabase(app) as unknown as { _driver: { get(p: string, q: null): Promise<{ value: unknown }> } })._driver;
      const v = (await driver.get(path, null)).value ?? null;
      // A node's children with their sizes, not the whole subtree.
      if (b.shallow && v && typeof v === 'object') {
        return { path, children: Object.entries(v as Record<string, unknown>).map(([k, x]) => (x && typeof x === 'object' ? { key: k, size: Object.keys(x).length } : { key: k, value: x })) };
      }
      return { path, value: v };
    },
    async 'db.set'(b) {
      const path = segs(str(b.path, 'path')).join('/');
      const driver = (getAdminDatabase(app) as unknown as { _driver: { set(p: string, v: unknown): Promise<void> } })._driver;
      await driver.set(path, b.value ?? null);
      return { ok: true };
    },

    // ── Authentication ──
    async 'auth.list'(b) {
      const a = getAdminAuth(app);
      const q = String(b.q ?? '').trim().toLowerCase();
      if (q) {
        const one = await (q.includes('@') ? a.getUserByEmail(q) : q.startsWith('+') ? a.getUserByPhoneNumber(q) : a.getUser(q)).catch(() => null);
        return { users: one ? [userRow(one)] : [], next: null };
      }
      const page = await a.listUsers(Math.min(Number(b.limit ?? 50), 1000), typeof b.next === 'string' && b.next ? b.next : undefined);
      return { users: page.users.map(userRow), next: page.pageToken ?? null };
    },
    async 'auth.update'(b) {
      const a = getAdminAuth(app);
      const uid = str(b.uid, 'uid');
      if (typeof b.disabled === 'boolean') await a.updateUser(uid, { disabled: b.disabled });
      if (typeof b.password === 'string' && b.password) await a.updateUser(uid, { password: b.password });
      if (b.claims !== undefined) await a.setCustomUserClaims(uid, (b.claims as Record<string, unknown> | null) as never);
      if (b.revoke) await a.revokeRefreshTokens(uid);
      return userRow(await a.getUser(uid));
    },
    async 'auth.create'(b) {
      const u = await getAdminAuth(app).createUser({ ...(b.email ? { email: String(b.email) } : {}), ...(b.password ? { password: String(b.password) } : {}), ...(b.phone ? { phoneNumber: String(b.phone) } : {}), ...(b.displayName ? { displayName: String(b.displayName) } : {}) });
      return userRow(u);
    },
    async 'auth.delete'(b) {
      await getAdminAuth(app).deleteUser(str(b.uid, 'uid'));
      return { ok: true };
    },
    'auth.config': () => manageAuth(app).getConfig(),
    'auth.setProviders': (b) => manageAuth(app).setProviders(b as never).then(() => ({ ok: true })),
    'auth.setDomains': (b) => manageAuth(app).setAuthorizedDomains((b.domains as string[]) ?? []).then(() => ({ ok: true })),
    'auth.attempts': (b) => getAuthSecurity(app).listAttempts(str(b.identifier, 'identifier')),
    'auth.unblock': (b) => getAuthSecurity(app).unblock(str(b.identifier, 'identifier')),
    'auth.resetLimits': (b) => getAuthSecurity(app).resetLimits(str(b.identifier, 'identifier')),

    // ── Storage ──
    async 'st.buckets'() {
      const named = config.firebase?.storageBucket;
      const listed = await manageStorage(app).listBuckets().catch(() => [] as string[]);
      // Only buckets that exist. Without a named bucket, the old <project>.appspot.com guess is used only
      // when the project's buckets cannot be listed: projects made since late 2024 have
      // <project>.firebasestorage.app instead, and the guess showed up as a second, empty bucket.
      const guess = `${config.firebase?.projectId ?? `demo-${config.name}`}.appspot.com`;
      const def = named ?? (listed.includes(guess) || !listed.length ? guess : listed.find((n) => n.endsWith('.firebasestorage.app')) ?? listed[0]!);
      return { default: def, buckets: [...new Set(named || !listed.length ? [def, ...listed] : listed)] };
    },
    async 'st.list'(b) {
      const bucket = getAdminStorage(app).bucket(typeof b.bucket === 'string' && b.bucket ? b.bucket : undefined);
      const prefix = String(b.prefix ?? '');
      const [files, , resp] = (await bucket.getFiles({ prefix, delimiter: '/', autoPaginate: false, maxResults: 500 })) as unknown as [{ name: string; metadata: Record<string, unknown> }[], unknown, { prefixes?: string[] }];
      return { prefix, folders: resp?.prefixes ?? [], files: files.filter((f) => f.name !== prefix).map((f) => ({ name: f.name, size: Number(f.metadata.size ?? 0), contentType: f.metadata.contentType ?? null, updated: f.metadata.updated ?? null })) };
    },
    async 'st.read'(b) {
      const f = getAdminStorage(app).bucket(typeof b.bucket === 'string' && b.bucket ? b.bucket : undefined).file(str(b.name, 'name'));
      const [[data], [meta]] = await Promise.all([f.download(), f.getMetadata()]);
      if (data.length > 10 * 1024 * 1024) throw new IceBaseError('out-of-range', 'over 10 MB: download it with the admin SDK');
      return { name: f.name, contentType: meta.contentType ?? 'application/octet-stream', size: data.length, metadata: meta.metadata ?? {}, base64: data.toString('base64') };
    },
    async 'st.upload'(b) {
      const f = getAdminStorage(app).bucket(typeof b.bucket === 'string' && b.bucket ? b.bucket : undefined).file(str(b.name, 'name'));
      await f.save(Buffer.from(str(b.base64 ?? ' ', 'base64'), 'base64'), { contentType: String(b.contentType ?? 'application/octet-stream'), resumable: false });
      return { ok: true };
    },
    async 'st.delete'(b) {
      await getAdminStorage(app).bucket(typeof b.bucket === 'string' && b.bucket ? b.bucket : undefined).file(str(b.name, 'name')).delete();
      return { ok: true };
    },

    // ── Functions ──
    async 'fn.list'() {
      if (o.server) return o.server.manage('functions', 'list', {});
      if (o.firebase) return { functions: await o.firebase.functions() };
      return { functions: [] };
    },
    async 'fn.run'(b) {
      if (!o.server) throw new IceBaseError('unimplemented', 'run a scheduled function now: on the IceBase server (on Firebase, use Cloud Scheduler)');
      return o.server.manage('functions', 'run', { name: str(b.name, 'name') });
    },
    async 'fn.tasks'() {
      if (!o.server) return { tasks: [] };
      return o.server.manage('functions', 'tasks', {});
    },

    // ── Hosting ──
    'hosting.sites': async () => ({ sites: await manageHosting(app).listSites() }),
    'hosting.createSite': (b) => manageHosting(app).createSite(str(b.siteId, 'siteId')),
    'hosting.setDNS': (b) => manageHosting(app).setDNS(str(b.domain, 'domain'), typeof b.site === 'string' ? { site: b.site } : {}),

    // ── Remote Config ──
    async 'rc.get'() {
      const declared = (config.remoteConfig?.parameters ?? {}) as RemoteConfigParams;
      const rc = getAdminRemoteConfig(app);
      const t = await rc.getTemplate();
      const live = allParameters(t);
      const names = [...new Set([...Object.keys(declared), ...Object.keys(live)])];
      const versions = await rc.listVersions({ pageSize: 20 }).then((r) => r.versions).catch(() => []);
      return {
        version: t.version?.versionNumber ?? '0',
        conditions: t.conditions.map((c) => c.name),
        versions,
        parameters: names.map((name) => {
          const p = declared[name];
          const v = live[name]?.defaultValue;
          return {
            name,
            declared: !!p,
            valueType: p ? templateValueType(p) : (live[name]?.valueType ?? 'STRING'),
            defaultValue: p ? paramToString(p, p.defaultValue) : null,
            description: p?.description ?? live[name]?.description ?? null,
            value: v && 'value' in v ? v.value : null,
            useInAppDefault: !!(v && 'useInAppDefault' in v),
            conditional: Object.keys(live[name]?.conditionalValues ?? {}),
          };
        }),
      };
    },
    async 'rc.publish'(b) {
      // New values for some parameters ({ name: string | null }; null = the in-app default), on the current template.
      const rc = getAdminRemoteConfig(app);
      const t = await rc.getTemplate();
      const values = (b.values ?? {}) as Record<string, string | null>;
      for (const [k, v] of Object.entries(values)) {
        const cur = t.parameters[k] ?? {};
        t.parameters[k] = { ...cur, defaultValue: v === null ? { useInAppDefault: true } : { value: String(v) } };
      }
      const out = await rc.publishTemplate(t);
      return { version: out.version?.versionNumber ?? null };
    },
    'rc.rollback': async (b) => ({ version: (await getAdminRemoteConfig(app).rollback(str(String(b.version ?? ''), 'version'))).version?.versionNumber ?? null }),
    'rc.sync': () => manageRemoteConfig(app).setParameters(),

    // ── Cloud Messaging (the outbox, topics and tokens are the IceBase server's) ──
    async 'fcm.state'() {
      const kinds = Object.entries(config.messaging?.messages ?? {}).map(([kind, fields]) => ({ kind, fields: Object.entries(fields as Record<string, { def: { kind: string }; optional: boolean }>).map(([k, fd]) => ({ name: k, type: fd.def.kind, optional: fd.optional })) }));
      if (!o.server) return { server: false, kinds, outbox: [], topics: [], tokens: [] };
      const [outbox, topics, tokens] = await Promise.all([o.server.manage('messaging', 'outbox', { limit: 100 }), o.server.manage('messaging', 'topics', {}), o.server.manage('messaging', 'tokens', { limit: 100 })]);
      return { server: true, kinds, ...(outbox as object), ...(topics as object), ...(tokens as object) };
    },
    async 'fcm.send'(b) {
      const target = typeof b.token === 'string' && b.token ? { token: b.token } : { topic: str(b.topic, 'token or topic') };
      const title = typeof b.title === 'string' && b.title ? b.title : undefined;
      const body = typeof b.body === 'string' && b.body ? b.body : undefined;
      const kind = typeof b.kind === 'string' && b.kind ? b.kind : undefined;
      const message = { ...target, ...(title || body ? { notification: { ...(title ? { title } : {}), ...(body ? { body } : {}) } } : {}), ...(kind ? { kind, data: (b.data ?? {}) as never } : {}) };
      return { name: await getAdminMessaging(app).send(message as never) };
    },

    // ── App Check ──
    async 'ac.get'() {
      const tokens = await manageAppCheck(app).listDebugTokens().catch((e: Error) => ({ error: e.message }));
      return { enforce: config.appCheck?.enforce ?? [], mode: modes.appCheck, tokens };
    },
    'ac.createDebugToken': (b) => manageAppCheck(app).createDebugToken(str(b.name, 'name'), typeof b.token === 'string' && b.token ? b.token : undefined),
    'ac.deleteDebugToken': async (b) => (await manageAppCheck(app).deleteDebugToken(str(b.token, 'token')), { ok: true }),

    // ── Rules ──
    async rules(b) {
      const svc = String(b.service ?? 'firestore') as 'firestore' | 'storage' | 'database';
      const fromServer = o.server?.rules(svc) ?? null;
      const deployed = fromServer ?? (o.firebase ? await o.firebase.rules(svc).catch(() => null) : null);
      const file = config.rules?.[svc] ?? null;
      return { service: svc, file, text: deployed };
    },
  };

  return async (op, b) => {
    const fn = ops[op];
    if (!fn) throw new IceBaseError('not-found', `console: no operation '${op}'`);
    return fn(b);
  };
}

function userRow(u: { uid: string; email?: string; phoneNumber?: string; displayName?: string; disabled: boolean; emailVerified: boolean; customClaims?: Record<string, unknown>; providerData: { providerId: string }[]; metadata: { creationTime?: string; lastSignInTime?: string } }) {
  return {
    uid: u.uid,
    email: u.email ?? null,
    phone: u.phoneNumber ?? null,
    name: u.displayName ?? null,
    disabled: u.disabled,
    verified: u.emailVerified,
    claims: u.customClaims ?? {},
    providers: u.providerData.map((p) => p.providerId),
    created: u.metadata.creationTime ?? null,
    lastSignIn: u.metadata.lastSignInTime ?? null,
  };
}
