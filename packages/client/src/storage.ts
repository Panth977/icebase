// icebase/storage — same names as firebase/storage. Uploads are checked against the schema's
// filePath() declarations (content type, size) before they leave, in every mode.
//
// firebase mode: the Firebase JS SDK. emulator mode: the same SDK pointed at the IceBase
// server, which speaks the Firebase Storage REST API like the official emulator.

import * as st from 'firebase/storage';
import { emulatorOrigin, service, type IceBaseApp } from './app.ts';
import { IceBaseError } from './errors.ts';
import { nativeWebApp } from './internal/firebase-web-app.ts';
import { matchFilePath, type AnyFilePath, type FilePath } from './schema.ts';

export type StorageReference = st.StorageReference;
export type UploadMetadata = st.UploadMetadata;
export type SettableMetadata = st.SettableMetadata;
export type FullMetadata = st.FullMetadata;
export type UploadResult = st.UploadResult;
export type UploadTask = st.UploadTask;
export type ListResult = st.ListResult;
export type ListOptions = st.ListOptions;
export type StringFormat = st.StringFormat;
export const StringFormat = st.StringFormat;

export class FirebaseStorage {
  constructor(
    readonly app: IceBaseApp,
    /** @internal */ readonly _native: st.FirebaseStorage,
  ) {}
  get maxUploadRetryTime(): number {
    return this._native.maxUploadRetryTime;
  }
  get maxOperationRetryTime(): number {
    return this._native.maxOperationRetryTime;
  }
}

export function getStorage(app: IceBaseApp, bucketUrl?: string): FirebaseStorage {
  if (app.kind === 'admin') throw new IceBaseError('invalid-argument', 'This is an admin app: use getAdminStorage(app) from icebase/admin', { reason: 'config' });
  return service(app, `storage:${bucketUrl ?? ''}`, () => {
    const mode = app.modes.storage;
    const native = st.getStorage(nativeWebApp(app), bucketUrl);
    if (mode === 'emulator') {
      const u = new URL(emulatorOrigin(app));
      st.connectStorageEmulator(native, u.hostname, Number(u.port));
    }
    return new FirebaseStorage(app, native);
  });
}

export function connectStorageEmulator(storage: FirebaseStorage, host: string, port: number, options?: { mockUserToken?: string }): void {
  st.connectStorageEmulator(storage._native, host, port, options);
}

type Params<P extends string> = P extends `${string}{${string}}${infer R}` ? [string, ...Params<R>] : [];
const owner = new WeakMap<st.StorageReference, FirebaseStorage>();

/** ref(storage, 'avatars/u1/me.png') · ref(storage, avatars, uid, 'me.png') · ref(parentRef, 'child') */
export function ref(storage: FirebaseStorage, path?: string): StorageReference;
export function ref<P extends string>(storage: FirebaseStorage, file: FilePath<P>, ...params: Params<P>): StorageReference;
export function ref(parent: StorageReference, path?: string): StorageReference;
export function ref(base: FirebaseStorage | StorageReference, pathOrFile?: string | AnyFilePath, ...params: string[]): StorageReference {
  if (base instanceof FirebaseStorage) {
    let path = pathOrFile as string | undefined;
    if (pathOrFile && typeof pathOrFile === 'object') {
      const fp = pathOrFile;
      if (!Object.values(base.app.config.schema.files ?? {}).includes(fp)) throw new IceBaseError('invalid-argument', `filePath('${fp.path}') is not in this app's schema (defineSchema(…, { files }))`, { reason: 'unknown-collection', service: 'storage' });
      if (params.length !== fp.params.length) throw new IceBaseError('invalid-argument', `ref(storage, '${fp.path}'): needs ${fp.params.length} path parameter(s), got ${params.length}`, { reason: 'schema', service: 'storage' });
      let i = 0;
      path = fp.path
        .split('/')
        .map((s) => {
          if (!/^\{.+\}$/.test(s)) return s;
          const v = params[i++]!;
          if (!v || v.includes('/')) throw new IceBaseError('invalid-argument', `ref(storage, '${fp.path}'): parameter ${s} must be a non-empty string without '/'`, { reason: 'schema', service: 'storage' });
          return v;
        })
        .join('/');
    }
    const r = st.ref(base._native, path);
    owner.set(r, base);
    return r;
  }
  const r = st.ref(base, pathOrFile as string | undefined);
  const o = owner.get(base);
  if (o) owner.set(r, o);
  return r;
}

/** The upload check: the path must be declared (when any are) and the content fit it. */
function checkUpload(r: StorageReference, size: number | null, contentType: string | undefined): void {
  const s = owner.get(r);
  const files = s?.app.config.schema.files as Record<string, AnyFilePath> | undefined;
  if (!files || Object.keys(files).length === 0) return;
  const fp = matchFilePath(files, r.fullPath);
  if (!fp) throw new IceBaseError('invalid-argument', `upload to '${r.fullPath}': the path matches no filePath(…) in the schema (${Object.values(files).map((f) => `'${f.path}'`).join(', ')})`, { reason: 'schema', service: 'storage' });
  if (fp.maxBytes !== undefined && size !== null && size > fp.maxBytes) throw new IceBaseError('invalid-argument', `upload to '${r.fullPath}': ${size} bytes is over the ${fp.maxBytes} allowed for '${fp.path}'`, { reason: 'schema', service: 'storage' });
  if (fp.contentTypes.length) {
    const ok = !!contentType && fp.contentTypes.some((p) => (p.endsWith('/*') ? contentType.startsWith(p.slice(0, -1)) : contentType === p));
    if (!ok) throw new IceBaseError('invalid-argument', `upload to '${r.fullPath}': content type ${contentType ?? '(none)'} is not one of ${fp.contentTypes.join(', ')}`, { reason: 'schema', service: 'storage' });
  }
}

const sizeOf = (d: Blob | Uint8Array | ArrayBuffer): number => (d instanceof Uint8Array || d instanceof ArrayBuffer ? d.byteLength : d.size);
const typeOf = (d: Blob | Uint8Array | ArrayBuffer, meta?: UploadMetadata) => meta?.contentType ?? (typeof Blob !== 'undefined' && d instanceof Blob && d.type ? d.type : undefined);

export function uploadBytes(r: StorageReference, data: Blob | Uint8Array | ArrayBuffer, metadata?: UploadMetadata): Promise<UploadResult> {
  checkUpload(r, sizeOf(data), typeOf(data, metadata));
  return st.uploadBytes(r, data, metadata);
}
export function uploadBytesResumable(r: StorageReference, data: Blob | Uint8Array | ArrayBuffer, metadata?: UploadMetadata): UploadTask {
  checkUpload(r, sizeOf(data), typeOf(data, metadata));
  return st.uploadBytesResumable(r, data, metadata);
}
export function uploadString(r: StorageReference, value: string, format?: StringFormat, metadata?: UploadMetadata): Promise<UploadResult> {
  const approx = format === 'base64' || format === 'base64url' ? Math.floor((value.length * 3) / 4) : format === 'data_url' ? Math.floor(((value.split(',')[1] ?? '').length * 3) / 4) : new TextEncoder().encode(value).byteLength;
  const type = metadata?.contentType ?? (format === 'data_url' ? /^data:([^;,]+)/.exec(value)?.[1] : undefined);
  checkUpload(r, approx, type);
  return st.uploadString(r, value, format, metadata);
}

export const getDownloadURL = (r: StorageReference): Promise<string> => st.getDownloadURL(r);
export const getBytes = (r: StorageReference, maxDownloadSizeBytes?: number): Promise<ArrayBuffer> => st.getBytes(r, maxDownloadSizeBytes);
export const getBlob = (r: StorageReference, maxDownloadSizeBytes?: number): Promise<Blob> => st.getBlob(r, maxDownloadSizeBytes);
export const getMetadata = (r: StorageReference): Promise<FullMetadata> => st.getMetadata(r);
export const updateMetadata = (r: StorageReference, metadata: SettableMetadata): Promise<FullMetadata> => {
  if (metadata.contentType) checkUpload(r, null, metadata.contentType);
  return st.updateMetadata(r, metadata);
};
export const deleteObject = (r: StorageReference): Promise<void> => st.deleteObject(r);
export const list = (r: StorageReference, options?: ListOptions): Promise<ListResult> => st.list(r, options);
export const listAll = (r: StorageReference): Promise<ListResult> => st.listAll(r);
