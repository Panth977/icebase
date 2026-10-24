import { describe, expect, it } from 'vitest';
import { loadRules, type RulesDoc, type RulesRequest } from '@panth977/icebase-cli/internal';
import { tsKey } from '@panth977/icebase/internal';

// The PRD's example firestore.rules (appendix), verbatim.
const FIRESTORE = `rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    function signedIn() { return request.auth != null; }
    function isAdmin() { return signedIn() && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == 'admin'; }

    match /users/{uid} {
      allow read: if signedIn() && (request.auth.uid == uid || isAdmin());
      allow create: if request.auth.uid == uid && request.resource.data.role == 'member';
      allow update: if request.auth.uid == uid && !request.resource.data.diff(resource.data).affectedKeys().hasAny(['role']);

      match /orders/{orderId} {
        allow read: if request.auth.uid == uid || isAdmin();
        allow create: if request.auth.uid == uid && request.resource.data.status == 'pending';
        allow update, delete: if isAdmin();
      }
    }
    match /products/{id} {
      allow read: if true;
      allow write: if isAdmin();
    }
  }
}`;

const STORAGE = `rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /avatars/{uid}/{file} {
      allow read: if true;
      allow write: if request.auth.uid == uid && request.resource.size < 2 * 1024 * 1024
        && request.resource.contentType.matches('image/.*');
    }
    match /products/{file} {
      allow read: if true;
      allow write: if firestore.get(/databases/(default)/documents/users/$(request.auth.uid)).data.role == 'admin';
    }
  }
}`;

const docs: Record<string, Record<string, unknown>> = {
  'users/admin1': { role: 'admin', email: 'a@x' },
  'users/u1': { role: 'member', email: 'u@x' },
};
const get = (p: string): RulesDoc | null => {
  const k = p.replace('/databases/(default)/documents/', '');
  return docs[k] ? { data: docs[k]!, id: k.split('/').pop()!, path: p } : null;
};
const D = '/databases/(default)/documents';
const as = (uid: string | null) => (uid ? { uid, token: { email: `${uid}@x` } } : null);
const rq = (r: Partial<RulesRequest> & Pick<RulesRequest, 'method' | 'path'>): RulesRequest => ({ auth: null, resource: null, requestResource: null, get, ...r });
const doc = (path: string, data: Record<string, unknown>): RulesDoc => ({ data, id: path.split('/').pop()!, path: `${D}/${path}` });

describe('firestore.rules', () => {
  const rules = loadRules(FIRESTORE, 'firestore');
  const allows = (r: RulesRequest) => rules.explain(r).allowed;

  it('signed-in users read themselves, admins read anyone, strangers nobody', () => {
    expect(allows(rq({ method: 'get', path: `${D}/users/u1`, auth: as('u1') }))).toBe(true);
    expect(allows(rq({ method: 'get', path: `${D}/users/u1`, auth: as('admin1') }))).toBe(true);
    expect(allows(rq({ method: 'get', path: `${D}/users/u1`, auth: as('u2') }))).toBe(false);
    expect(allows(rq({ method: 'get', path: `${D}/users/u1` }))).toBe(false);
  });
  it('create checks request.resource', () => {
    expect(allows(rq({ method: 'create', path: `${D}/users/u3`, auth: as('u3'), requestResource: doc('users/u3', { role: 'member' }) }))).toBe(true);
    expect(allows(rq({ method: 'create', path: `${D}/users/u3`, auth: as('u3'), requestResource: doc('users/u3', { role: 'admin' }) }))).toBe(false);
  });
  it('update cannot touch role (diff().affectedKeys())', () => {
    const before = doc('users/u1', { role: 'member', email: 'u@x' });
    expect(allows(rq({ method: 'update', path: `${D}/users/u1`, auth: as('u1'), resource: before, requestResource: doc('users/u1', { role: 'member', email: 'new@x' }) }))).toBe(true);
    expect(allows(rq({ method: 'update', path: `${D}/users/u1`, auth: as('u1'), resource: before, requestResource: doc('users/u1', { role: 'admin', email: 'u@x' }) }))).toBe(false);
  });
  it('nested match and write = create/update/delete', () => {
    expect(allows(rq({ method: 'create', path: `${D}/users/u1/orders/o1`, auth: as('u1'), requestResource: doc('users/u1/orders/o1', { status: 'pending' }) }))).toBe(true);
    expect(allows(rq({ method: 'delete', path: `${D}/users/u1/orders/o1`, auth: as('u1') }))).toBe(false);
    expect(allows(rq({ method: 'delete', path: `${D}/users/u1/orders/o1`, auth: as('admin1') }))).toBe(true);
    expect(allows(rq({ method: 'list', path: `${D}/products/p1` }))).toBe(true);
    expect(allows(rq({ method: 'update', path: `${D}/products/p1`, auth: as('u1') }))).toBe(false);
  });
  it('errors deny, and say why', () => {
    // get() of a missing user document errors → denied
    const r = rules.explain(rq({ method: 'update', path: `${D}/products/p1`, auth: as('ghost') }));
    expect(r.allowed).toBe(false);
    expect(r.errors[0]).toMatch(/no such document/);
  });
  it('nothing matches → denied', () => {
    expect(allows(rq({ method: 'get', path: `${D}/secrets/s1`, auth: as('admin1') }))).toBe(false);
  });
});

describe('expression language', () => {
  const one = (cond: string, extra: Partial<RulesRequest> = {}) =>
    loadRules(`rules_version = '2'; service cloud.firestore { match /databases/{db}/documents { match /{doc=**} { allow read: if ${cond}; } } }`, 'firestore').explain(rq({ method: 'get', path: `${D}/a/b/c/d`, auth: as('u1'), ...extra }));
  const t = (cond: string, extra?: Partial<RulesRequest>) => expect(one(cond, extra).allowed, cond).toBe(true);
  const f = (cond: string) => expect(one(cond).allowed, cond).toBe(false);
  it('operators and literals', () => {
    t('1 + 2 * 3 == 7');
    t('7 / 2 == 3');
    t('7 % 4 == 3');
    t("'ab' + 'c' == 'abc'");
    t('[1, 2] + [3] == [1, 2, 3]');
    t('2 in [1, 2, 3]');
    t("'k' in {'k': 1}");
    t('!(1 > 2)');
    t('1 < 2 ? true : false');
    t("{'a': {'b': 1}}.a.b == 1");
    t('[1, 2, 3][1] == 2');
    t('-1 < 0');
    f('1 == 2 || 2 == 3');
  });
  it('types', () => {
    t('1 is int && 1.5 is float && 1 is number');
    t("'x' is string && [1] is list && {'a': 1} is map && null == null");
    t('request.time is timestamp');
    t('request.auth.uid is string');
  });
  it('strings, lists, maps', () => {
    t("'Hello'.size() == 5");
    t("'image/png'.matches('image/.*')");
    f("'text/html'.matches('image/.*')");
    t("'a,b'.split(',') == ['a', 'b']");
    t("'AbC'.lower() == 'abc'");
    t('[1, 2, 3].hasAll([1, 3]) && [1, 2].hasAny([2, 9]) && [1, 2].hasOnly([1, 2, 3])');
    t("{'a': 1, 'b': 2}.keys().hasAll(['a', 'b'])");
    t("{'a': 1}.get('z', 5) == 5");
    t("{'a': 1, 'b': 2}.diff({'a': 1, 'b': 3}).changedKeys() == ['b']");
    t('[1, 1, 2].toSet().size() == 2');
  });
  it('wildcards and paths', () => {
    t("doc == /a/b/c/d && doc[0] == 'a'");
    t("db == '(default)'");
    t("/databases/$(db)/documents/users/$(request.auth.uid) == path('/databases/(default)/documents/users/u1')");
  });
  it('timestamps and durations', () => {
    const now = Date.now();
    const ts = (ms: number) => ({ __ib: 'ts', s: Math.floor(ms / 1000), n: (ms % 1000) * 1e6, k: tsKey(Math.floor(ms / 1000), (ms % 1000) * 1e6) });
    t('request.time > timestamp.value(0)');
    t('request.time + duration.value(1, "h") > request.time');
    t('timestamp.value(86400000).day() == 2');
    t('resource.data.at < request.time', { resource: doc('a/b/c/d', { at: ts(now - 1000) }) });
    t('request.time - resource.data.at < duration.value(1, "m")', { resource: doc('a/b/c/d', { at: ts(now - 1000) }) });
  });
  it('|| ignores an error on one side when the other is true', () => {
    t('request.resource.data.x == 1 || true');
    f('request.resource.data.x == 1 || false');
  });
});

describe('storage.rules', () => {
  const rules = loadRules(STORAGE, 'storage');
  const P = '/b/demo.appspot.com/o';
  it('size and contentType on request.resource', () => {
    expect(rules.explain(rq({ method: 'create', path: `${P}/avatars/u1/me.png`, auth: as('u1'), requestResource: { size: 1000, contentType: 'image/png', name: 'avatars/u1/me.png' } })).allowed).toBe(true);
    expect(rules.explain(rq({ method: 'create', path: `${P}/avatars/u1/me.exe`, auth: as('u1'), requestResource: { size: 1000, contentType: 'application/x-msdownload' } })).allowed).toBe(false);
    expect(rules.explain(rq({ method: 'create', path: `${P}/avatars/u2/me.png`, auth: as('u1'), requestResource: { size: 1000, contentType: 'image/png' } })).allowed).toBe(false);
  });
  it('firestore.get() from storage rules', () => {
    expect(rules.explain(rq({ method: 'create', path: `${P}/products/p.png`, auth: as('admin1'), requestResource: { size: 1, contentType: 'image/png' } })).allowed).toBe(true);
    expect(rules.explain(rq({ method: 'create', path: `${P}/products/p.png`, auth: as('u1'), requestResource: { size: 1, contentType: 'image/png' } })).allowed).toBe(false);
  });
  it('refuses rules for the wrong service', () => {
    expect(() => loadRules(STORAGE, 'firestore')).toThrow(/expected `service cloud.firestore`/);
  });
});
