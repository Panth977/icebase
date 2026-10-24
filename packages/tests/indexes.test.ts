import { describe, expect, it } from 'vitest';
import { collection, contains, defineSchema, desc, f, index } from '@panth977/icebase/schema';
import { firestoreIndexesJson } from '@panth977/icebase-cli/manage';
import { firebaseFieldPath } from '@panth977/icebase-cli/internal';

describe('firestore.indexes.json from the schema (IDX-4)', () => {
  it('composites, collection-group scopes, exemptions for undeclared fields, ttl', () => {
    const products = collection('products', {
      fields: { category: f.string(), price: f.number(), tags: f.array(f.string()), blob: f.string(), expires: f.timestamp(), dims: f.map({ w: f.number() }) },
      indexes: [index('category'), index('category', desc('price')), index(contains('tags'), 'price'), index(['dims', 'w'])],
      ttl: 'expires',
    });
    const orders = collection('users/{uid}/orders', { fields: { status: f.string(), at: f.timestamp() }, indexes: [index('status'), index('status', desc('at'))], group: true });
    const out = firestoreIndexesJson(defineSchema({ products, orders }));
    expect(out.indexes).toEqual([
      { collectionGroup: 'products', queryScope: 'COLLECTION', fields: [{ fieldPath: 'category', order: 'ASCENDING' }, { fieldPath: 'price', order: 'DESCENDING' }] },
      { collectionGroup: 'products', queryScope: 'COLLECTION', fields: [{ fieldPath: 'tags', arrayConfig: 'CONTAINS' }, { fieldPath: 'price', order: 'ASCENDING' }] },
      { collectionGroup: 'orders', queryScope: 'COLLECTION', fields: [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'at', order: 'DESCENDING' }] },
      { collectionGroup: 'orders', queryScope: 'COLLECTION_GROUP', fields: [{ fieldPath: 'status', order: 'ASCENDING' }, { fieldPath: 'at', order: 'DESCENDING' }] },
    ]);
    // Fields no index touches are exempted: Firebase stops indexing what IceBase never queries.
    expect(out.fieldOverrides.find((o) => o.fieldPath === 'blob')).toEqual({ collectionGroup: 'products', fieldPath: 'blob', indexes: [] });
    expect(out.fieldOverrides.find((o) => o.fieldPath === 'expires')).toMatchObject({ ttl: true, indexes: [] });
    expect(out.fieldOverrides.some((o) => o.fieldPath === 'dims' || o.fieldPath === 'category')).toBe(false);
    const status = out.fieldOverrides.find((o) => o.collectionGroup === 'orders' && o.fieldPath === 'status')!;
    expect(status.indexes.map((i) => i.queryScope)).toEqual(['COLLECTION', 'COLLECTION', 'COLLECTION_GROUP', 'COLLECTION_GROUP']);
  });
  it('writes key paths in Firestore field-path syntax', () => {
    expect(firebaseFieldPath(['address', 'city'])).toBe('address.city');
    expect(firebaseFieldPath(['rating.avg'])).toBe('`rating.avg`');
    expect(firebaseFieldPath(['a`b'])).toBe('`a\\`b`');
  });
});
