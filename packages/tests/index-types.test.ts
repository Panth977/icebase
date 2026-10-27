// The compile-time index check (PRD §9): a query whose index is not declared does not type-check.
// `npm run typecheck` proves each @ts-expect-error below fails for its stated reason; at run
// time the client refuses the same queries before they leave.
import { describe, expect, it } from 'vitest';
import { initializeApp } from '@panth977/icebase/app';
import { defineConfig } from '@panth977/icebase/config';
import { collection, getDocs, getFirestore, orderBy, query, where } from '@panth977/icebase/firestore';
import { asc, collection as coll, defineSchema, desc, f, index } from '@panth977/icebase/schema';

const items = coll('items', {
  fields: { shop: f.string(), price: f.number(), name: f.string(), tags: f.array(f.string()), address: f.map({ city: f.string(), pin: f.string() }) },
  indexes: [index('shop'), index('price'), index(['address', 'city']), index('shop', desc('price')), index(asc('tags'))],
});
const config = defineConfig({ name: 'ix-types', schema: defineSchema({ items }), firebase: { projectId: 'demo-ix' }, environments: { local: { mode: 'emulator' } } });
const db = getFirestore(initializeApp(config, 'local', { name: 'ix-types', firebase: { apiKey: 'demo', projectId: 'demo-ix' } }));
const c = collection(db, items);

describe('the compile-time index check', () => {
  it('declared single-field, nested and composite indexes type-check', () => {
    expect(query(c, where('shop', '==', 's'))).toBeTruthy();
    expect(query(c, where(['address', 'city'], '==', 'Pune'))).toBeTruthy();
    expect(query(c, where('shop', '==', 's'), orderBy('price', 'desc'))).toBeTruthy();
  });

  it('undeclared ones are compile errors, and refused at run time', async () => {
    const refused: (() => unknown)[] = [
      // @ts-expect-error name has no index declared
      () => getDocs(query(c, orderBy('name'))),
      // @ts-expect-error ['address', 'pin'] has no index declared
      () => getDocs(query(c, where(['address', 'pin'], '==', '411001'))),
      // @ts-expect-error shop + name is not a declared composite
      () => getDocs(query(c, where('shop', '==', 's'), orderBy('name'))),
      // @ts-expect-error ['address', 'town'] is not a field
      () => query(c, where(['address', 'town'], '==', 'x')),
      // @ts-expect-error a price is a number
      () => query(c, where('price', '==', 'cheap')),
    ];
    // Refused before anything is sent (no server is running here).
    for (const q of refused.slice(0, 3)) await expect(Promise.resolve().then(q)).rejects.toThrow(/index/i);
  });
});
