// Cloud Storage on the IceBase server: the Firebase Storage REST API (/v0, used by
// firebase/storage) and the parts of the GCS JSON API that firebase-admin's bucket() uses
// (/storage/v1, /upload/storage/v1, /download/storage/v1). Blobs on disk (or in memory),
// metadata in SQLite, storage.rules for every caller that is not the owner.

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IceBaseError } from '@panth977/icebase/errors';
import { matchFilePath, type AnyFilePath } from '@panth977/icebase/schema';
import { loadRules, type RulesEngine } from './rules.ts';
import { json, type Caller, type EmulatorContext, type Service } from './server.ts';
import { Buffer } from 'node:buffer';

interface Meta {
  bucket: string;
  name: string;
  size: number;
  contentType: string;
  md5Hash: string;
  crc32c: string;
  generation: string;
  metageneration: string;
  timeCreated: string;
  updated: string;
  contentDisposition?: string;
  contentEncoding?: string;
  contentLanguage?: string;
  cacheControl?: string;
  /** Custom metadata (Firebase calls it customMetadata on the client). */
  metadata: Record<string, string>;
  downloadTokens: string;
}

/** CRC32C, base64 big-endian, like GCS reports it. */
function crc32c(buf: Uint8Array): string {
  let crc = 0xffffffff;
  for (const b of buf) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0x82f63b78 : crc >>> 1;
  }
  crc = (crc ^ 0xffffffff) >>> 0;
  const out = Buffer.alloc(4);
  out.writeUInt32BE(crc);
  return out.toString('base64');
}

/** multipart/related: a JSON metadata part, then the bytes. */
function parseMultipart(body: Buffer, contentType: string): { meta: Record<string, unknown>; data: Buffer; dataType?: string } {
  const boundary = /boundary=("?)([^";]+)\1/.exec(contentType)?.[2];
  if (!boundary) throw new IceBaseError('invalid-argument', 'multipart upload without a boundary');
  const sep = Buffer.from(`--${boundary}`);
  const parts: Buffer[] = [];
  let i = body.indexOf(sep);
  while (i >= 0) {
    const next = body.indexOf(sep, i + sep.length);
    if (next < 0) break;
    parts.push(body.subarray(i + sep.length, next));
    i = next;
  }
  const split = (p: Buffer) => {
    const at = p.indexOf('\r\n\r\n');
    const head = p.subarray(0, at).toString();
    let data = p.subarray(at + 4);
    if (data.subarray(-2).toString() === '\r\n') data = data.subarray(0, -2);
    return { head, data };
  };
  const [m, d] = parts.map(split);
  if (!m || !d) throw new IceBaseError('invalid-argument', 'multipart upload needs a metadata part and a data part');
  return { meta: JSON.parse(m.data.toString() || '{}') as Record<string, unknown>, data: Buffer.from(d.data), dataType: /content-type:\s*([^\r\n]+)/i.exec(d.head)?.[1] };
}

const loopback = (h: string): boolean => /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|0\.0\.0\.0)$/.test(h);

/**
 * The origin the caller reached this server on — for the upload URLs handed back, which the caller
 * fetches next. Behind a proxy that is not the server's own (loopback) address: the request URL
 * already carries X-Forwarded-Host/Proto or the Host header; a browser's Origin header fills in what
 * a proxy left out (the scheme behind TLS termination, or a Host rewritten to the upstream).
 */
export function callerOrigin(req: Request, fallback: string): string {
  const u = new URL(req.url);
  const o = req.headers.get('origin');
  let page: URL | null = null;
  try {
    page = o && o !== 'null' ? new URL(o) : null;
  } catch {
    page = null;
  }
  if (page && (page.host === u.host || (loopback(u.hostname) && !loopback(page.hostname)))) {
    return page.host === u.host && req.headers.get('x-forwarded-proto') ? u.origin : page.origin;
  }
  return u.host ? u.origin : fallback;
}

export function storageService(ctx: EmulatorContext): Service {
  const memory = ctx.dataDir === ':memory:';
  const blobs = new Map<string, Buffer>();
  const blobDir = memory ? '' : join(ctx.dataDir, 'storage');
  const sql = new DatabaseSync(memory ? ':memory:' : join(ctx.dataDir, 'storage.sqlite'));
  sql.exec(`CREATE TABLE IF NOT EXISTS objects (bucket TEXT NOT NULL, name TEXT NOT NULL, meta TEXT NOT NULL, PRIMARY KEY (bucket, name));
            CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, bucket TEXT NOT NULL, name TEXT NOT NULL, meta TEXT NOT NULL, data BLOB)`);
  const q = {
    get: sql.prepare(`SELECT meta FROM objects WHERE bucket = ? AND name = ?`),
    put: sql.prepare(`INSERT INTO objects (bucket, name, meta) VALUES (?, ?, ?) ON CONFLICT(bucket, name) DO UPDATE SET meta = excluded.meta`),
    del: sql.prepare(`DELETE FROM objects WHERE bucket = ? AND name = ?`),
    list: sql.prepare(`SELECT meta FROM objects WHERE bucket = ? AND name >= ? AND name < ? ORDER BY name`),
    upPut: sql.prepare(`INSERT INTO uploads (id, bucket, name, meta, data) VALUES (?, ?, ?, ?, ?)`),
    upGet: sql.prepare(`SELECT * FROM uploads WHERE id = ?`),
    upData: sql.prepare(`UPDATE uploads SET data = ? WHERE id = ?`),
    upDel: sql.prepare(`DELETE FROM uploads WHERE id = ?`),
  };
  const blobPath = (b: string, n: string) => join(blobDir, b, ...n.split('/'));
  const readBlob = (b: string, n: string) => (memory ? blobs.get(`${b}/${n}`) : readFileSync(blobPath(b, n)))!;
  const writeBlob = (b: string, n: string, d: Buffer) => {
    if (memory) blobs.set(`${b}/${n}`, d);
    else {
      mkdirSync(dirname(blobPath(b, n)), { recursive: true });
      writeFileSync(blobPath(b, n), d);
    }
  };
  const dropBlob = (b: string, n: string) => (memory ? blobs.delete(`${b}/${n}`) : rmSync(blobPath(b, n), { force: true }));
  const getMeta = (b: string, n: string) => {
    const r = q.get.get(b, n) as { meta: string } | undefined;
    return r ? (JSON.parse(r.meta) as Meta) : null;
  };

  let rules: RulesEngine | null = null;
  if (ctx.config.rules?.storage) rules = loadRules(readFileSync(resolve(ctx.root, ctx.config.rules.storage), 'utf8'), 'storage');
  // Rules released for one bucket with the management API (until restart); others use config.rules.storage.
  const bucketRules = new Map<string, RulesEngine>();
  const rulesFor = (bucket: string): RulesEngine | null => bucketRules.get(bucket) ?? rules;
  const defaultBucket = ctx.config.firebase?.storageBucket ?? `${ctx.projectId}.appspot.com`;
  const bucketsFile = ctx.dataDir === ':memory:' ? null : join(ctx.dataDir, 'storage-buckets.json');
  const buckets = new Set<string>([defaultBucket, ...(bucketsFile && existsSync(bucketsFile) ? (JSON.parse(readFileSync(bucketsFile, 'utf8')) as string[]) : [])]);
  const files = (ctx.config.schema.files ?? {}) as Record<string, AnyFilePath>;

  const ruleRes = (m: Meta | null) => (m ? { name: m.name, bucket: m.bucket, size: m.size, contentType: m.contentType, md5Hash: m.md5Hash, crc32c: m.crc32c, generation: m.generation, metageneration: m.metageneration, timeCreated: { __ib: 'ts', s: Math.floor(Date.parse(m.timeCreated) / 1000), n: 0, k: '' }, updated: m.updated, metadata: m.metadata, contentDisposition: m.contentDisposition ?? null, contentEncoding: m.contentEncoding ?? null, contentLanguage: m.contentLanguage ?? null, cacheControl: m.cacheControl ?? null } : null);
  const allow = async (c: Caller, method: 'get' | 'list' | 'create' | 'update' | 'delete', bucket: string, name: string, cur: Meta | null, next: Meta | null) => {
    if (c.admin) return;
    const rules = rulesFor(bucket);
    if (!rules && ctx.signingKey) throw new IceBaseError('permission-denied', 'storage: no rules file, so only the admin may read or write on this server');
    if (!rules) return;
    const ok = await rules.allows({
      method,
      path: `/b/${bucket}/o/${name}`,
      auth: c.auth,
      resource: ruleRes(cur),
      requestResource: ruleRes(next),
      get: (p) => {
        const d = ctx.firestore.get(p.replace(/^\/databases\/[^/]+\/documents\//, ''));
        return d ? { data: d.data, id: d.id, path: p } : null;
      },
    });
    if (!ok) throw new IceBaseError('permission-denied', `User does not have permission to access '${name}'.`);
  };
  const checkSchema = (name: string, size: number, contentType: string) => {
    if (!Object.keys(files).length) return;
    const fp = matchFilePath(files, name);
    if (!fp) throw new IceBaseError('invalid-argument', `upload to '${name}': the path matches no filePath(…) in the schema`, { reason: 'schema' });
    if (fp.maxBytes !== undefined && size > fp.maxBytes) throw new IceBaseError('invalid-argument', `upload to '${name}': ${size} bytes is over the ${fp.maxBytes} allowed`, { reason: 'schema' });
    if (fp.contentTypes.length && !fp.contentTypes.some((p) => (p.endsWith('/*') ? contentType.startsWith(p.slice(0, -1)) : contentType === p))) throw new IceBaseError('invalid-argument', `upload to '${name}': content type ${contentType} is not allowed`, { reason: 'schema' });
  };

  const store = async (c: Caller, bucket: string, name: string, data: Buffer, given: Record<string, unknown>) => {
    const cur = getMeta(bucket, name);
    const now = new Date().toISOString();
    const contentType = String(given.contentType ?? 'application/octet-stream');
    const custom = (given.metadata ?? given.customMetadata ?? {}) as Record<string, string>;
    const meta: Meta = {
      bucket,
      name,
      size: data.length,
      contentType,
      md5Hash: createHash('md5').update(data).digest('base64'),
      crc32c: crc32c(data),
      generation: String(Date.now() * 1000),
      metageneration: '1',
      timeCreated: now,
      updated: now,
      metadata: Object.fromEntries(Object.entries(custom).filter(([k]) => k !== 'firebaseStorageDownloadTokens')),
      downloadTokens: (custom.firebaseStorageDownloadTokens as string | undefined) ?? cur?.downloadTokens ?? randomUUID(),
      ...(given.contentDisposition ? { contentDisposition: String(given.contentDisposition) } : {}),
      ...(given.contentEncoding ? { contentEncoding: String(given.contentEncoding) } : {}),
      ...(given.contentLanguage ? { contentLanguage: String(given.contentLanguage) } : {}),
      ...(given.cacheControl ? { cacheControl: String(given.cacheControl) } : {}),
    };
    checkSchema(name, data.length, contentType);
    await allow(c, cur ? 'update' : 'create', bucket, name, cur, meta);
    writeBlob(bucket, name, data);
    q.put.run(bucket, name, JSON.stringify(meta));
    emit('finalized', meta);
    return meta;
  };

  /** Storage events for functions (onObjectFinalized …), in Cloud Storage's object shape. */
  const emit = (event: 'finalized' | 'deleted' | 'metadataUpdated', m: Meta) => {
    if (!ctx.hooks.storage.length) return;
    const object = { name: m.name, bucket: m.bucket, contentType: m.contentType, size: String(m.size), md5Hash: m.md5Hash, crc32c: m.crc32c, generation: m.generation, metageneration: m.metageneration, timeCreated: m.timeCreated, updated: m.updated, metadata: m.metadata, storageClass: 'STANDARD', id: `${m.bucket}/${m.name}/${m.generation}`, kind: 'storage#object' };
    for (const h of ctx.hooks.storage) h({ event, object });
  };

  /** Firebase's view (v0) and GCS's view (v1) of the same metadata. */
  const v0 = (m: Meta) => ({ name: m.name, bucket: m.bucket, generation: m.generation, metageneration: m.metageneration, contentType: m.contentType, timeCreated: m.timeCreated, updated: m.updated, storageClass: 'STANDARD', size: String(m.size), md5Hash: m.md5Hash, crc32c: m.crc32c, etag: m.md5Hash, contentEncoding: m.contentEncoding ?? 'identity', contentDisposition: m.contentDisposition ?? `inline; filename*=utf-8''${encodeURIComponent(m.name.split('/').pop()!)}`, ...(m.cacheControl ? { cacheControl: m.cacheControl } : {}), ...(m.contentLanguage ? { contentLanguage: m.contentLanguage } : {}), metadata: m.metadata, downloadTokens: m.downloadTokens });
  const v1 = (m: Meta) => ({ kind: 'storage#object', id: `${m.bucket}/${m.name}/${m.generation}`, selfLink: `${ctx.origin}/storage/v1/b/${m.bucket}/o/${encodeURIComponent(m.name)}`, mediaLink: `${ctx.origin}/download/storage/v1/b/${m.bucket}/o/${encodeURIComponent(m.name)}?generation=${m.generation}&alt=media`, name: m.name, bucket: m.bucket, generation: m.generation, metageneration: m.metageneration, contentType: m.contentType, storageClass: 'STANDARD', size: String(m.size), md5Hash: m.md5Hash, crc32c: m.crc32c, etag: m.md5Hash, timeCreated: m.timeCreated, updated: m.updated, metadata: { ...m.metadata, firebaseStorageDownloadTokens: m.downloadTokens }, ...(m.contentDisposition ? { contentDisposition: m.contentDisposition } : {}), ...(m.cacheControl ? { cacheControl: m.cacheControl } : {}) });

  const list = (bucket: string, prefix: string, delimiter: string | null, max: number, after: string | null) => {
    const rows = (q.list.all(bucket, prefix, `${prefix}￿`) as { meta: string }[]).map((r) => JSON.parse(r.meta) as Meta);
    const items: Meta[] = [];
    const prefixes = new Set<string>();
    for (const m of rows) {
      if (after && m.name <= after) continue;
      const rest = m.name.slice(prefix.length);
      const cut = delimiter ? rest.indexOf(delimiter) : -1;
      if (cut >= 0) prefixes.add(prefix + rest.slice(0, cut + 1));
      else items.push(m);
    }
    const page = items.slice(0, max);
    return { items: page, prefixes: [...prefixes], next: items.length > max ? page[page.length - 1]!.name : null };
  };

  /** The object's bytes; a Range request (bytes=a-b, a-, -n) gets its part (206). */
  const media = (m: Meta, req?: Request) => {
    const all = readBlob(m.bucket, m.name);
    // Stored objects are people's uploads, served from this server's (the app's) own origin — not a
    // storage origin of their own, as on Firebase: never sniffed, and anything but a PDF in a
    // sandbox (an opaque origin), so an uploaded page cannot act as the app.
    const base = {
      'content-type': m.contentType,
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
      ...(m.contentType.startsWith('application/pdf') ? {} : { 'content-security-policy': 'sandbox' }),
      ...(m.contentDisposition ? { 'content-disposition': m.contentDisposition } : {}),
      ...(m.cacheControl ? { 'cache-control': m.cacheControl } : {}),
    };
    const r = /^bytes=(\d*)-(\d*)$/.exec(req?.headers.get('range') ?? '');
    if (r && (r[1] || r[2])) {
      const size = all.length;
      let start = r[1] ? Number(r[1]) : Math.max(0, size - Number(r[2]));
      let end = r[1] && r[2] ? Math.min(Number(r[2]), size - 1) : size - 1;
      if (!r[1]) end = size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      start = Math.max(0, start);
      return new Response(new Uint8Array(all.subarray(start, end + 1)), { status: 206, headers: { ...base, 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/${size}` } });
    }
    return new Response(new Uint8Array(all), { headers: { ...base, 'content-length': String(m.size) } });
  };

  // ── signed URLs (GCS's getSignedUrl, which needs a service account the server does not have) ──
  const signKey = ctx.signingKey ?? randomBytes(32);
  const signature = (action: string, bucket: string, name: string, expires: number, contentType: string) =>
    createHmac('sha256', signKey).update(`icebase-storage\n${action}\n${bucket}\n${name}\n${expires}\n${contentType}`).digest('base64url');
  const signedPath = (action: 'read' | 'write', bucket: string, name: string, expires: number, contentType = '') =>
    `/__/icebase/storage/signed/${encodeURIComponent(bucket)}/${name.split('/').map(encodeURIComponent).join('/')}?action=${action}&expires=${expires}${contentType ? `&contentType=${encodeURIComponent(contentType)}` : ''}&sig=${signature(action, bucket, name, expires, contentType)}`;
  const notFound = (name: string) => json({ error: { code: 404, message: `Not Found. Could not get object ${name}`, status: 'NOT_FOUND' } }, 404);

  return {
    manage(op, b) {
      switch (op) {
        case 'listBuckets':
          return { buckets: [...buckets] };
        case 'createBucket': {
          const name = typeof b.name === 'string' && b.name ? b.name : defaultBucket;
          if (name === defaultBucket) return { name };
          if (!/^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/.test(name)) throw new IceBaseError('invalid-argument', `createBucket('${name}'): not a valid bucket name`);
          if (buckets.has(name)) throw new IceBaseError('already-exists', `bucket '${name}' already exists`);
          buckets.add(name);
          if (bucketsFile) writeFileSync(bucketsFile, JSON.stringify([...buckets].filter((x) => x !== defaultBucket)));
          return { name };
        }
        case 'setRules': {
          const bucket = typeof b.bucket === 'string' ? b.bucket : defaultBucket;
          const source = String(b.source ?? '');
          bucketRules.set(bucket, loadRules(source, 'storage'));
          ctx.deployedRules.set(`storage:${bucket}`, source);
          return { ruleset: `projects/${ctx.projectId}/rulesets/icebase-${Date.now()}`, release: `projects/${ctx.projectId}/releases/firebase.storage/${bucket}` };
        }
      }
      throw new IceBaseError('invalid-argument', `storage: no management operation '${op}'`);
    },
    async handle(req, url, caller) {
      const path = url.pathname;
      // ── signed URLs ─────────────────────────────────────────────────────────
      if (path === '/__/icebase/storage/sign' && req.method === 'POST') {
        if (!caller.admin) return json({ error: { code: 403, message: 'signing URLs is admin only' } }, 403);
        const b = (await req.json()) as { bucket: string; name: string; action: 'read' | 'write'; expires: number; contentType?: string };
        return json({ path: signedPath(b.action === 'write' ? 'write' : 'read', b.bucket, b.name, Math.floor(Number(b.expires)), b.contentType ?? '') });
      }
      const sm = /^\/__\/icebase\/storage\/signed\/([^/]+)\/(.+)$/.exec(path);
      if (sm) {
        const bucket = decodeURIComponent(sm[1]!);
        const name = sm[2]!.split('/').map(decodeURIComponent).join('/');
        const action = url.searchParams.get('action') === 'write' ? 'write' : 'read';
        const expires = Number(url.searchParams.get('expires'));
        const contentType = url.searchParams.get('contentType') ?? '';
        const want = Buffer.from(signature(action, bucket, name, expires, contentType));
        const got = Buffer.from(url.searchParams.get('sig') ?? '');
        if (got.length !== want.length || !timingSafeEqual(got, want)) return json({ error: { code: 403, message: 'The request signature does not match.' } }, 403);
        if (!(expires > Date.now())) return json({ error: { code: 400, message: 'The signed URL has expired.' } }, 400);
        const admin = { admin: true, auth: null };
        if (action === 'read') {
          if (req.method !== 'GET' && req.method !== 'HEAD') return json({ error: { code: 405, message: 'a read URL takes GET' } }, 405);
          const cur = getMeta(bucket, name);
          return cur ? media(cur, req) : notFound(name);
        }
        if (req.method !== 'PUT') return json({ error: { code: 405, message: 'a write URL takes PUT' } }, 405);
        const ct = req.headers.get('content-type') ?? 'application/octet-stream';
        if (contentType && ct !== contentType) return json({ error: { code: 403, message: `this URL is signed for ${contentType}` } }, 403);
        return json(v1(await store(admin, bucket, name, Buffer.from(await req.arrayBuffer()), { contentType: ct })));
      }
      // ── Firebase Storage REST (v0) ──────────────────────────────────────────
      let m = /^\/v0\/b\/([^/]+)\/o\/?(.*)$/.exec(path);
      if (m) {
        const bucket = decodeURIComponent(m[1]!);
        const name = m[2] ? decodeURIComponent(m[2]) : (url.searchParams.get('name') ?? '');
        if (!m[2] && req.method === 'GET') {
          const prefix = url.searchParams.get('prefix') ?? '';
          await allow(caller, 'list', bucket, `${prefix}`, null, null);
          const r = list(bucket, prefix, url.searchParams.get('delimiter'), Number(url.searchParams.get('maxResults') ?? 1000), url.searchParams.get('pageToken'));
          return json({ prefixes: r.prefixes, items: r.items.map((x) => ({ name: x.name, bucket })), ...(r.next ? { nextPageToken: r.next } : {}) });
        }
        if (req.method === 'POST' && !m[2]) {
          const proto = req.headers.get('x-goog-upload-protocol');
          const command = req.headers.get('x-goog-upload-command') ?? '';
          if (proto === 'multipart') {
            const p = parseMultipart(Buffer.from(await req.arrayBuffer()), req.headers.get('content-type') ?? '');
            return json(v0(await store(caller, bucket, String(p.meta.name ?? name), p.data, { ...p.meta, contentType: p.meta.contentType ?? p.dataType })));
          }
          if (proto === 'resumable' && command === 'start') {
            const meta = (await req.json().catch(() => ({}))) as Record<string, unknown>;
            const id = randomUUID();
            q.upPut.run(id, bucket, String(meta.name ?? name), JSON.stringify(meta), Buffer.alloc(0));
            const uploadUrl = `${callerOrigin(req, ctx.origin)}/v0/b/${encodeURIComponent(bucket)}/o?name=${encodeURIComponent(String(meta.name ?? name))}&upload_id=${id}&upload_protocol=resumable`;
            return new Response(null, { status: 200, headers: { 'x-goog-upload-url': uploadUrl, 'x-goog-upload-status': 'active', 'x-goog-upload-chunk-granularity': '262144' } });
          }
          const uploadId = url.searchParams.get('upload_id');
          if (uploadId) {
            const up = q.upGet.get(uploadId) as { bucket: string; name: string; meta: string; data: Uint8Array } | undefined;
            if (!up) return json({ error: { code: 404, message: 'upload not found' } }, 404);
            if (command.includes('query')) return new Response(null, { headers: { 'x-goog-upload-status': 'active', 'x-goog-upload-size-received': String(up.data.length) } });
            if (command.includes('cancel')) {
              q.upDel.run(uploadId);
              return new Response(null, { headers: { 'x-goog-upload-status': 'cancelled' } });
            }
            const chunk = Buffer.from(await req.arrayBuffer());
            const data = Buffer.concat([Buffer.from(up.data), chunk]);
            if (!command.includes('finalize')) {
              q.upData.run(data, uploadId);
              return new Response(null, { headers: { 'x-goog-upload-status': 'active', 'x-goog-upload-size-received': String(data.length) } });
            }
            q.upDel.run(uploadId);
            const meta = await store(caller, up.bucket, up.name, data, JSON.parse(up.meta) as Record<string, unknown>);
            return json(v0(meta), 200, { 'x-goog-upload-status': 'final' });
          }
          // A simple upload (raw body).
          return json(v0(await store(caller, bucket, name, Buffer.from(await req.arrayBuffer()), { contentType: req.headers.get('content-type') ?? undefined })));
        }
        const cur = getMeta(bucket, name);
        if (req.method === 'GET') {
          if (!cur) return notFound(name);
          await allow(caller, 'get', bucket, name, cur, null);
          if (url.searchParams.get('alt') === 'media') {
            // A download URL's token stands in for rules, as in Firebase.
            return media(cur, req);
          }
          return json(v0(cur));
        }
        if (req.method === 'PATCH') {
          if (!cur) return notFound(name);
          const patch = (await req.json()) as Record<string, unknown>;
          const next: Meta = { ...cur, metageneration: String(Number(cur.metageneration) + 1), updated: new Date().toISOString() };
          for (const k of ['contentType', 'contentDisposition', 'contentEncoding', 'contentLanguage', 'cacheControl'] as const) if (k in patch) (next as unknown as Record<string, unknown>)[k] = patch[k] ?? undefined;
          if ('metadata' in patch) next.metadata = Object.fromEntries(Object.entries((patch.metadata ?? {}) as Record<string, string | null>).filter(([, v]) => v !== null)) as Record<string, string>;
          checkSchema(name, next.size, next.contentType);
          await allow(caller, 'update', bucket, name, cur, next);
          q.put.run(bucket, name, JSON.stringify(next));
          emit('metadataUpdated', next);
          return json(v0(next));
        }
        if (req.method === 'DELETE') {
          if (!cur) return notFound(name);
          await allow(caller, 'delete', bucket, name, cur, null);
          q.del.run(bucket, name);
          emit('deleted', cur);
          dropBlob(bucket, name);
          return new Response(null, { status: 204 });
        }
      }

      // ── GCS JSON API (firebase-admin's bucket()) ────────────────────────────
      // firebase-admin's emulator mode drops the /storage/v1 prefix; the real API keeps it.
      m = /^\/(upload\/|download\/)?(storage\/v1\/)?b\/([^/]+)(?:\/o(?:\/(.+))?)?$/.exec(path);
      // With hosting on the same port, a bare /b/… is the app's page unless a Google client library asks.
      if (m && !m[2] && ctx.hosting && !req.headers.get('x-goog-api-client')) m = null;
      if (m) {
        // The GCS JSON API is the admin's (firebase-admin's bucket()): on a signed server, only with the admin token.
        // A resumable upload's later requests carry its session id instead (made by the admin; GCS works the same).
        if (ctx.signingKey && !caller.admin && !url.searchParams.get('upload_id')) return json({ error: { code: 403, message: 'storage: the GCS API is admin only on this server' } }, 403);
        if (!caller.admin && !rules) caller = { admin: true, auth: null };
        m = [m[0], m[1], m[3], m[4]] as unknown as RegExpExecArray;
        const bucket = decodeURIComponent(m[2]!);
        const name = m[3] ? decodeURIComponent(m[3]) : (url.searchParams.get('name') ?? '');
        if (m[1] === 'upload/') {
          const type = url.searchParams.get('uploadType');
          if (type === 'multipart') {
            const p = parseMultipart(Buffer.from(await req.arrayBuffer()), req.headers.get('content-type') ?? '');
            return json(v1(await store(caller, bucket, String(p.meta.name ?? name), p.data, { ...p.meta, contentType: p.meta.contentType ?? p.dataType })));
          }
          if (type === 'resumable') {
            const id = url.searchParams.get('upload_id');
            if (!id) {
              const meta = (await req.json().catch(() => ({}))) as Record<string, unknown>;
              const nid = randomUUID();
              q.upPut.run(nid, bucket, String(meta.name ?? name), JSON.stringify(meta), Buffer.alloc(0));
              return new Response(null, { status: 200, headers: { location: `${callerOrigin(req, ctx.origin)}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o?uploadType=resumable&name=${encodeURIComponent(String(meta.name ?? name))}&upload_id=${nid}` } });
            }
            const up = q.upGet.get(id) as { bucket: string; name: string; meta: string; data: Uint8Array } | undefined;
            if (!up) return json({ error: { code: 404, message: 'upload not found' } }, 404);
            const data = Buffer.concat([Buffer.from(up.data), Buffer.from(await req.arrayBuffer())]);
            // 'bytes 0-*/*': one request streams it all (done when it ends); 'bytes 0-262143/*' is one
            // chunk of more; 'bytes 0-4/5' or 'bytes */5' names the total.
            const range = /bytes (?:\d+|\*)(?:-(\d+|\*))?\/(\d+|\*)/.exec(req.headers.get('content-range') ?? '');
            const end = range?.[1];
            const total = range ? range[2] : String(data.length);
            const more = total === '*' ? end !== undefined && end !== '*' : Number(total) > data.length;
            if (more) {
              q.upData.run(data, id);
              // Nothing received yet: a 308 without a range (GCS's answer to a status check).
              return new Response(null, { status: 308, headers: data.length ? { range: `bytes=0-${data.length - 1}` } : {} });
            }
            q.upDel.run(id);
            return json(v1(await store(caller, up.bucket, up.name, data, JSON.parse(up.meta) as Record<string, unknown>)));
          }
          return json(v1(await store(caller, bucket, name, Buffer.from(await req.arrayBuffer()), { contentType: req.headers.get('content-type') ?? undefined })));
        }
        // Copy: POST …/o/{src}/rewriteTo/b/{bucket}/o/{dst} (or copyTo), as file.copy() sends it.
        const cp = req.method === 'POST' && m[3] ? /^(.+?)\/(rewriteTo|copyTo)\/b\/([^/]+)\/o\/(.+)$/.exec(m[3]) : null;
        if (cp) {
          const srcName = decodeURIComponent(cp[1]!);
          const dstBucket = decodeURIComponent(cp[3]!);
          const dstName = decodeURIComponent(cp[4]!);
          const src = getMeta(bucket, srcName);
          if (!src) return notFound(srcName);
          const patch = (await req.json().catch(() => ({}))) as { contentType?: string; metadata?: Record<string, string> };
          const meta = await store(caller, dstBucket, dstName, readBlob(bucket, srcName), { contentType: patch.contentType ?? src.contentType, metadata: { ...src.metadata, ...(patch.metadata ?? {}) }, ...(src.cacheControl ? { cacheControl: src.cacheControl } : {}), ...(src.contentDisposition ? { contentDisposition: src.contentDisposition } : {}) });
          if (cp[2] === 'copyTo') return json(v1(meta));
          return json({ kind: 'storage#rewriteResponse', totalBytesRewritten: String(meta.size), objectSize: String(meta.size), done: true, resource: v1(meta) });
        }
        if (!m[3] && req.method === 'GET' && path.includes('/o')) {
          const r = list(bucket, url.searchParams.get('prefix') ?? '', url.searchParams.get('delimiter'), Number(url.searchParams.get('maxResults') ?? 1000), url.searchParams.get('pageToken'));
          return json({ kind: 'storage#objects', items: r.items.map(v1), prefixes: r.prefixes, ...(r.next ? { nextPageToken: r.next } : {}) });
        }
        if (!m[3] && !path.includes('/o')) return json({ kind: 'storage#bucket', name: bucket, id: bucket });
        const cur = getMeta(bucket, name);
        if (req.method === 'GET') {
          if (!cur) return notFound(name);
          if (m[1] === 'download/' || url.searchParams.get('alt') === 'media') return media(cur, req);
          return json(v1(cur));
        }
        if (req.method === 'PATCH' || req.method === 'PUT') {
          if (!cur) return notFound(name);
          const patch = (await req.json()) as Record<string, unknown>;
          const meta = { ...((patch.metadata ?? {}) as Record<string, string | null>) };
          const next: Meta = { ...cur, metageneration: String(Number(cur.metageneration) + 1), updated: new Date().toISOString(), ...(patch.contentType ? { contentType: String(patch.contentType) } : {}) };
          if ('metadata' in patch) {
            if (typeof meta.firebaseStorageDownloadTokens === 'string') next.downloadTokens = meta.firebaseStorageDownloadTokens;
            delete meta.firebaseStorageDownloadTokens;
            next.metadata = Object.fromEntries(Object.entries({ ...cur.metadata, ...meta }).filter(([, v]) => v !== null)) as Record<string, string>;
          }
          q.put.run(bucket, name, JSON.stringify(next));
          emit('metadataUpdated', next);
          return json(v1(next));
        }
        if (req.method === 'DELETE') {
          if (!cur) return notFound(name);
          q.del.run(bucket, name);
          emit('deleted', cur);
          dropBlob(bucket, name);
          return new Response(null, { status: 204 });
        }
      }
      return null;
    },
    close: () => sql.close(),
  };
}
