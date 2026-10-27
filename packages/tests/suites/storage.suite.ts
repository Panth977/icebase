// The Storage conformance suite: client SDK wrapper + admin, Firebase's emulator and IceBase's.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, type IceBaseApp } from '@panth977/icebase/app';
import { getAdminStorage } from '@panth977/icebase-server/admin';
import { defineConfig, type Mode } from '@panth977/icebase/config';
import { defineSchema, filePath } from '@panth977/icebase/schema';
import { deleteObject, getBytes, getDownloadURL, getMetadata, listAll, ref, updateMetadata, uploadBytes, uploadBytesResumable, uploadString, type FirebaseStorage } from '@panth977/icebase/storage';

const PROJECT = 'demo-icebase';
export const BUCKET = `${PROJECT}.appspot.com`;

const avatars = filePath('avatars/{uid}/{file}', { contentTypes: ['image/*'], maxMb: 0.01 });
const docs = filePath('docs/{file}', { contentTypes: ['application/pdf', 'text/plain'] });
export const storageConfig = (mode: Mode, port?: number) =>
  defineConfig({
    name: 'storage-test',
    schema: defineSchema({}, { files: { avatars, docs } }),
    firebase: { projectId: PROJECT, storageBucket: BUCKET },
    ...(port ? { emulator: { port } } : {}),
    environments: { test: { mode } },
  });

export interface StorageSetup {
  app: IceBaseApp;
  admin: IceBaseApp;
  storage: FirebaseStorage;
  close?(): Promise<void>;
}

export function storageSuite(name: string, setup: () => Promise<StorageSetup>): void {
describe(`storage · ${name}`, () => {
  let app: IceBaseApp;
  let admin: IceBaseApp;
  let s: FirebaseStorage;
  let close: (() => Promise<void>) | undefined;
  const run = Math.random().toString(36).slice(2, 8);
  beforeAll(async () => {
    const x = await setup();
    app = x.app;
    admin = x.admin;
    s = x.storage;
    close = x.close;
  });
  afterAll(async () => {
    await deleteApp(app);
    await deleteApp(admin);
    await close?.();
  });

  it('uploads to a declared path and reads it back', async () => {
    const r = ref(s, avatars, run, 'me.png');
    expect(r.fullPath).toBe(`avatars/${run}/me.png`);
    const res = await uploadBytes(r, new Uint8Array([137, 80, 78, 71, 1, 2, 3]), { contentType: 'image/png', customMetadata: { by: 'test' } });
    expect(res.metadata.size).toBe(7);
    expect(new Uint8Array(await getBytes(r))).toEqual(new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    expect((await getMetadata(r)).customMetadata).toEqual({ by: 'test' });
    expect(await getDownloadURL(r)).toContain(encodeURIComponent(`avatars/${run}/me.png`));
  });

  it('checks content type, size and path before the upload leaves', async () => {
    await expect(() => uploadBytes(ref(s, avatars, run, 'x.exe'), new Uint8Array([1]), { contentType: 'application/x-msdownload' })).toThrow(/content type application\/x-msdownload is not one of image\/\*/);
    expect(() => uploadBytes(ref(s, avatars, run, 'big.png'), new Uint8Array(20_000), { contentType: 'image/png' })).toThrow(/20000 bytes is over the 10485 allowed/);
    expect(() => uploadString(ref(s, 'random/place.txt'), 'hi', 'raw', { contentType: 'text/plain' })).toThrow(/matches no filePath/);
    expect(() => updateMetadata(ref(s, avatars, run, 'me.png'), { contentType: 'text/html' })).toThrow(/content type text\/html/);
  });

  it('strings, listing and delete', async () => {
    await uploadString(ref(s, docs, `${run}-a.txt`), 'hello', 'raw', { contentType: 'text/plain' });
    await uploadString(ref(s, docs, `${run}-b.txt`), 'aGk=', 'base64', { contentType: 'text/plain' });
    const all = await listAll(ref(s, 'docs'));
    expect(all.items.map((i) => i.name)).toEqual(expect.arrayContaining([`${run}-a.txt`, `${run}-b.txt`]));
    await deleteObject(ref(s, docs, `${run}-a.txt`));
    expect((await listAll(ref(s, 'docs'))).items.map((i) => i.name)).not.toContain(`${run}-a.txt`);
  });

  it('admin storage sees the same bucket', async () => {
    const [exists] = await getAdminStorage(admin).bucket(BUCKET).file(`avatars/${run}/me.png`).exists();
    expect(exists).toBe(true);
  });

  it('a resumable upload in several chunks, with progress', async () => {
    const data = new Uint8Array(700_000).map((_, i) => i % 251);
    const task = uploadBytesResumable(ref(s, docs, `${run}-big.txt`), data, { contentType: 'text/plain' });
    const progress: number[] = [];
    task.on('state_changed', (snap) => void progress.push(snap.bytesTransferred));
    const done = await task;
    expect(done.totalBytes).toBe(700_000);
    expect(progress.at(-1)).toBe(700_000);
    const back = new Uint8Array(await getBytes(ref(s, docs, `${run}-big.txt`)));
    expect(back.length).toBe(700_000);
    expect(back[699_999]).toBe(699_999 % 251);
  });

  it('admin getFiles lists by prefix', async () => {
    const [files] = await getAdminStorage(admin).bucket(BUCKET).getFiles({ prefix: `docs/${run}-` });
    expect(files.map((f) => f.name)).toEqual(expect.arrayContaining([`docs/${run}-b.txt`, `docs/${run}-big.txt`]));
    expect(files.map((f) => f.name)).not.toContain(`avatars/${run}/me.png`);
  });
});
}
