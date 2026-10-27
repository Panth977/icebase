// emulator mode: the Realtime Database on the IceBase server (client and admin; admin sends
// the owner token). Child events are derived from ordered snapshots, as the SDK does.

import type { IceBaseApp } from '../app.ts';
import type { DatabaseDriver, DbQuery, RawDbSnapshot } from '../internal/database-driver.ts';
import { pushId } from '../internal/database-driver.ts';
import { nextId } from '../internal/rt-client.ts';
import { encode } from '../internal/wire.ts';
import { post, realtimeOf } from './firestore-emulator.ts';

/**
 * The instance a database URL names: ?ns=<id> (the emulator's form), else the host's first label
 * (https://<id>.firebaseio.com, https://<id>.<region>.firebasedatabase.app). None: the default.
 */
export function instanceOfUrl(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.searchParams.get('ns') ?? (/\.(firebaseio\.com|firebasedatabase\.app)$/.test(u.hostname) ? u.hostname.split('.')[0] : undefined);
  } catch {
    return undefined;
  }
}

export function emulatorDatabaseDriver(app: IceBaseApp, url?: string): DatabaseDriver {
  const ns = instanceOfUrl(url);
  const at = ns ? { ns } : {};
  const dbPost = <T = unknown>(path: string, body: Record<string, unknown>) => post<T>(app, path, { ...body, ...at });
  const get = (path: string, query: DbQuery | null) => dbPost<RawDbSnapshot>('/v1/db/get', { path, query });
  return {
    get,
    set: (path, value) => dbPost('/v1/db/set', { path, value: encode(value) }).then(() => undefined),
    update: (path, values) => dbPost('/v1/db/update', { path, values: encode(values) }).then(() => undefined),
    remove: (path) => dbPost('/v1/db/set', { path, value: null }).then(() => undefined),
    newKey: () => pushId(),
    listen(path, query, event, cb, cancel) {
      let prev: { key: string; value: string }[] | null = null;
      return realtimeOf(app).listen(
        'db',
        nextId(),
        { path, query, ...at },
        (m) => {
          const snap = m.snap as RawDbSnapshot;
          if (event === 'value') return cb(snap, null);
          const now = (snap.children ?? []).map((c) => ({ key: c.key, value: JSON.stringify(c.value) }));
          const before = prev ?? [];
          const old = new Map(before.map((c) => [c.key, c.value]));
          const cur = new Map(now.map((c) => [c.key, c.value]));
          const child = (key: string, json: string): RawDbSnapshot => {
            const value = JSON.parse(json) as unknown;
            return { key, value, children: value && typeof value === 'object' ? Object.entries(value).map(([k, v]) => ({ key: k, value: v })) : null };
          };
          if (event === 'child_removed') for (const c of before) if (!cur.has(c.key)) cb(child(c.key, c.value), null);
          now.forEach((c, i) => {
            const prevKey = i > 0 ? now[i - 1]!.key : null;
            if (event === 'child_added' && !old.has(c.key)) cb(child(c.key, c.value), prevKey);
            if (event === 'child_changed' && old.has(c.key) && old.get(c.key) !== c.value) cb(child(c.key, c.value), prevKey);
          });
          prev = now;
        },
        cancel,
      );
    },
    async transaction(path, fn) {
      for (let n = 0; n < 25; n++) {
        const cur = (await get(path, null)).value;
        const next = fn(cur);
        if (next === undefined) return { committed: false, snapshot: await get(path, null) };
        const r = await dbPost<{ committed: boolean; snap?: RawDbSnapshot }>('/v1/db/transaction', { path, expect: cur, value: encode(next) });
        if (r.committed) return { committed: true, snapshot: r.snap! };
      }
      throw new Error('runTransaction: too many retries');
    },
    onDisconnect(path) {
      const send = (op: string, value?: unknown) => realtimeOf(app).request('db', { t: 'onDisconnect', op, path, ...at, ...(value !== undefined ? { value: encode(value) } : {}) });
      return { set: (v) => send('set', v), update: (v) => send('update', v), remove: () => send('remove'), cancel: () => send('cancel') };
    },
  };
}
