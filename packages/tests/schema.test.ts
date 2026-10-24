import { describe, expect, it } from 'vitest';
import { collection, contains, defineSchema, desc, f, fillPath, index, matchCollectionPath, readIssues, validateQueryValue, validateUpdate, validateWrite } from '@panth977/icebase/schema';
import { FieldValue, GeoPoint, Timestamp } from '@panth977/icebase/internal';
import { IceBaseError } from '@panth977/icebase/errors';

const products = collection('products', {
  fields: {
    name: f.string({ min: 1, max: 20 }),
    priceCents: f.number({ int: true, min: 0 }),
    category: f.enum(['shoes', 'shirts']),
    tags: f.array(f.string(), { max: 3 }),
    active: f.boolean(),
    at: f.optional(f.timestamp()),
    where: f.optional(f.geopoint()),
    dims: f.optional(f.map({ w: f.number(), h: f.number(), note: f.optional(f.string()) })),
  },
  indexes: [index('category', desc('priceCents'))],
});
const orders = collection('users/{uid}/orders', {
  fields: { product: f.ref(products), qty: f.number({ int: true, min: 1 }) },
  indexes: [],
  group: true,
});
const schema = defineSchema({ products, orders });

const good = { name: 'Boot', priceCents: 100, category: 'shoes', tags: ['a'], active: true };
const issuesOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(IceBaseError);
    return ((e as IceBaseError).details.issues as { path: string }[]).map((i) => i.path);
  }
  throw new Error('expected a schema error');
};

describe('collection()', () => {
  it('parses path, params, id and composite indexes', () => {
    expect(orders.id).toBe('orders');
    expect(orders.params).toEqual(['uid']);
    expect(products.indexes[0]!.fields).toEqual([
      { path: ['category'], mode: 'asc' },
      { path: ['priceCents'], mode: 'desc' },
    ]);
  });
  it('refuses bad declarations', () => {
    expect(() => collection('users/{uid}', { fields: {}, indexes: [] })).toThrow(/odd number of segments/);
    expect(() => collection('users/uid/orders', { fields: {}, indexes: [] })).toThrow(/must be a \{param\}/);
    expect(() => collection('p', { fields: { a: f.string() }, indexes: [index('z' as never)] })).toThrow(/'z' is not in the schema/);
    expect(() => collection('p', { fields: { a: f.string(), b: f.string() }, indexes: [index('a', contains('b'))] })).toThrow(/needs an array field/);
    expect(() => collection('p', { fields: { a: f.string() }, indexes: [['a']] as never })).toThrow(/index\(…\) declarations/);
    expect(() => collection('p', { fields: { a: f.string() }, indexes: [], ttl: 'a' })).toThrow(/timestamp field/);
  });
  it('allows collections that share an id', () => {
    const a = collection('orders', { fields: {}, indexes: [] });
    expect(() => defineSchema({ a, orders })).not.toThrow();
  });
});

describe('paths', () => {
  it('fills and matches path templates', () => {
    expect(fillPath(orders, ['u1'])).toBe('users/u1/orders');
    expect(() => fillPath(orders, [])).toThrow(/needs 1 path parameter/);
    expect(() => fillPath(orders, ['a/b'])).toThrow(/without '\/'/);
    expect(matchCollectionPath(schema, 'users/u9/orders')).toEqual({ collection: orders, params: { uid: 'u9' } });
    expect(matchCollectionPath(schema, 'nope')).toBeNull();
  });
});

describe('validateWrite', () => {
  it('accepts a complete document and normalises Date and geopoint', () => {
    const d = new Date('2026-01-01T00:00:00Z');
    const out = validateWrite(products, { ...good, at: d, where: { latitude: 1, longitude: 2 } }, 'set');
    expect(out.at).toBeInstanceOf(Timestamp);
    expect((out.at as Timestamp).toMillis()).toBe(d.getTime());
    expect(out.where).toBeInstanceOf(GeoPoint);
  });
  it('names every bad field', () => {
    const paths = issuesOf(() => validateWrite(products, { name: '', priceCents: 1.5, category: 'socks', tags: ['a', 'b', 'c', 'd'], colour: 'x' }, 'set'));
    expect(paths).toEqual(expect.arrayContaining(['name', 'priceCents', 'category', 'tags', 'colour', 'active']));
  });
  it('checks nested maps and array elements', () => {
    expect(issuesOf(() => validateWrite(products, { ...good, tags: ['a', 3], dims: { w: 1 } }, 'set'))).toEqual(['tags[1]', 'dims.h']);
  });
  it('merge and update check only what is given', () => {
    expect(validateWrite(products, { active: false }, 'merge')).toEqual({ active: false });
    expect(validateUpdate(products, [[['dims', 'w'], 3]])).toEqual([[['dims', 'w'], 3]]);
    expect(issuesOf(() => validateUpdate(products, [[['dims', 'nope'], 3]]))).toEqual(["['dims', 'nope']"]);
    // A key with a dot is one key, never a path.
    expect(issuesOf(() => validateUpdate(products, [[['dims.w'], 3]]))).toEqual(["'dims.w'"]);
  });
  it('places sentinels only where they fit', () => {
    expect(() => validateUpdate(products, Object.entries({ priceCents: new FieldValue('increment', 2) }).map(([k, v]) => [[k], v] as const))).not.toThrow();
    expect(issuesOf(() => validateUpdate(products, [[['priceCents'], new FieldValue('increment', 0.5)]]))).toEqual(['priceCents']);
    expect(issuesOf(() => validateUpdate(products, Object.entries({ name: new FieldValue('serverTimestamp') }).map(([k, v]) => [[k], v] as const)))).toEqual(['name']);
    expect(() => validateUpdate(products, Object.entries({ at: new FieldValue('serverTimestamp') }).map(([k, v]) => [[k], v] as const))).not.toThrow();
    expect(issuesOf(() => validateUpdate(products, Object.entries({ tags: new FieldValue('arrayUnion', [1]) }).map(([k, v]) => [[k], v] as const)))).toEqual(['tags[0]']);
    expect(() => validateUpdate(products, Object.entries({ at: new FieldValue('delete') }).map(([k, v]) => [[k], v] as const))).not.toThrow();
    expect(issuesOf(() => validateUpdate(products, Object.entries({ name: new FieldValue('delete') }).map(([k, v]) => [[k], v] as const)))).toEqual(['name']);
    expect(issuesOf(() => validateWrite(products, { ...good, at: new FieldValue('delete') }, 'set'))).toEqual(['at']);
  });
  it('checks references against the target collection', () => {
    const ok = { type: 'document', id: 'p1', path: 'products/p1' };
    expect(() => validateWrite(orders, { product: ok, qty: 1 }, 'create')).not.toThrow();
    expect(issuesOf(() => validateWrite(orders, { product: { type: 'document', id: 'x', path: 'users/x' }, qty: 1 }, 'create'))).toEqual(['product']);
  });
  it('reports drift on reads without throwing', () => {
    expect(readIssues(products, { ...good, priceCents: 'cheap' }).map((i) => i.path)).toEqual(['priceCents']);
    expect(readIssues(products, good)).toEqual([]);
  });
});

describe('validateQueryValue', () => {
  it('checks operands but not stored-value bounds', () => {
    expect(() => validateQueryValue(products, ['priceCents'], '>', -5)).not.toThrow();
    expect(() => validateQueryValue(products, ['category'], 'in', ['shoes', 'shirts'])).not.toThrow();
    expect(() => validateQueryValue(products, ['category'], '==', 'socks')).toThrow(/category/);
    expect(() => validateQueryValue(products, ['tags'], 'array-contains', 3)).toThrow(/tags/);
    expect(() => validateQueryValue(products, ['colour'], '==', 'x')).toThrow(/not a field/);
    expect(() => validateQueryValue(products, ['at'], '==', null)).not.toThrow();
  });
});
