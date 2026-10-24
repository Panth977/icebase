// The Realtime Database conformance suite: Firebase's emulator and the IceBase emulator.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, type IceBaseApp } from '../../src/app.js';
import { defineConfig, type Mode } from '../../src/config.js';
import {
  child,
  databaseRulesJson,
  equalTo,
  get,
  increment,
  limitToLast,
  onChildAdded,
  onDisconnect,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  remove,
  runTransaction,
  serverTimestamp,
  set,
  update,
  type Database,
} from '../../src/database.js';
import { dbPath, defineSchema, f } from '../../src/schema.js';

export const messages = dbPath('rooms/{roomId}/messages/{msgId}', f.map({ text: f.string({ max: 200 }), at: f.number(), by: f.string(), likes: f.optional(f.number({ int: true })) }), { indexOn: ['at'] });
export const presence = dbPath('presence/{uid}', f.map({ online: f.boolean(), seen: f.number() }));
export const counter = dbPath('counters/{name}', f.number({ int: true }));

export const databaseConfig = (mode: Mode, port?: number) =>
  defineConfig({
    name: 'db-test',
    schema: defineSchema({}, { paths: { messages, presence, counter } }),
    firebase: { projectId: 'demo-icebase', databaseURL: 'https://demo-icebase-default-rtdb.firebaseio.com' },
    ...(port ? { emulator: { port } } : {}),
    environments: { test: { mode } },
  });

const run = Math.random().toString(36).slice(2, 8);

export function databaseSuite(name: string, setup: (tag: string) => Promise<{ app: IceBaseApp; db: Database; close?(): Promise<void> }>): void {
  describe(`database · ${name}`, () => {
    let app: IceBaseApp;
    let db: Database;
    const room = `${name.replace(/\W+/g, '-')}-${run}`;
    let close: (() => Promise<void>) | undefined;
    beforeAll(async () => {
      const s = await setup(room);
      app = s.app;
      db = s.db;
      close = s.close;
    });
    afterAll(async () => {
      await deleteApp(app);
      await close?.();
    });

    it('push, get and typed values', async () => {
      const list = ref(db, messages, room);
      const a = await push(list, { text: 'hi', at: 1, by: 'u1' });
      expect(a.key).toHaveLength(20);
      await push(list, { text: 'yo', at: 2, by: 'u2' });
      const s = await get(child(list, a.key!));
      expect(s.val()).toEqual({ text: 'hi', at: 1, by: 'u1' });
      expect((await get(list)).size).toBe(2);
    });

    it('validates writes against the path schema', async () => {
      const list = ref(db, messages, room);
      await expect(push(list, { text: 'x', at: 'later', by: 'u' } as never)).rejects.toThrow(/at: expected number/);
      await expect(set(ref(db, messages, room, 'm1'), { text: 'x'.repeat(201), at: 1, by: 'u' })).rejects.toThrow(/text: expected string/);
      await expect(update(ref(db, messages, room, 'm1'), { nope: 1 } as never)).rejects.toThrow(/not in the schema/);
    });

    it('update, increment and serverTimestamp', async () => {
      const m = ref(db, messages, room, 'm-upd');
      await set(m, { text: 'a', at: serverTimestamp(), by: 'u1' });
      await update(m, { likes: increment(2) });
      await update(m, { likes: increment(1), text: 'b' });
      const v = (await get(m)).val()!;
      expect(v.likes).toBe(3);
      expect(v.text).toBe('b');
      expect(v.at).toBeGreaterThan(1_600_000_000_000);
      await remove(m);
      expect((await get(m)).exists()).toBe(false);
    });

    it('queries by an indexed child, and refuses one that is not (IDX-6)', async () => {
      const list = ref(db, messages, room);
      const s = await get(query(list, orderByChild('at'), limitToLast(1)));
      const seen: string[] = [];
      s.forEach((c) => void seen.push(c.val()!.text));
      expect(seen.length).toBe(1);
      const eq = await get(query(list, orderByChild('at'), equalTo(1)));
      expect(eq.size).toBe(1);
      expect(() => query(list, orderByChild('by'))).toThrow(/needs 'by' in its indexOn/);
    });

    it('transactions', async () => {
      const c = ref(db, counter, room);
      await Promise.all([1, 2, 3].map(() => runTransaction(c, (cur) => (cur ?? 0) + 1)));
      expect((await get(c)).val()).toBe(3);
      const aborted = await runTransaction(c, () => undefined);
      expect(aborted.committed).toBe(false);
    });

    it('listeners', async () => {
      const list = ref(db, messages, `${room}-live`);
      const added: string[] = [];
      const un = onChildAdded(list, (s) => void added.push(s.val()!.text));
      let values = 0;
      const un2 = onValue(list, () => void values++);
      await push(list, { text: 'one', at: 1, by: 'u' });
      await push(list, { text: 'two', at: 2, by: 'u' });
      await new Promise((r) => setTimeout(r, 300));
      un();
      un2();
      expect(added).toEqual(['one', 'two']);
      expect(values).toBeGreaterThanOrEqual(2);
    });

    it('onDisconnect is validated and accepted', async () => {
      const p = ref(db, presence, `${room}-u1`);
      await set(p, { online: true, seen: Date.now() });
      await onDisconnect(p).update({ online: false, seen: serverTimestamp() });
      await onDisconnect(p).cancel();
      expect(() => onDisconnect(p).set({ online: 'no' } as never)).toThrow(/online: expected boolean/);
    });
  });
}

describe('database.rules.json', () => {
  it('merges indexOn under $params', () => {
    expect(databaseRulesJson({ messages, presence })).toEqual({ rules: { rooms: { $roomId: { messages: { '.indexOn': ['at'] } } } } });
  });
});
