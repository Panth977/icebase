import { defineConfig } from '@panth977/icebase/config';
import { collection, dbPath, defineSchema, f, index } from '@panth977/icebase/schema';

export const products = collection('products', { fields: { name: f.string(), stock: f.number({ int: true }) }, indexes: [] });
export const orders = collection('users/{uid}/orders', { fields: { product: f.ref(products), qty: f.number({ int: true, min: 1 }), note: f.optional(f.string()) }, indexes: [] });

/** What the event-driven functions record, so tests can see they ran. */
export const seen = collection('seen', { fields: { kind: f.string(), detail: f.any(), attempt: f.optional(f.number()) }, indexes: [index('kind')] });
export const rooms = dbPath('rooms/{roomId}/messages/{msgId}', f.map({ text: f.string() }));

export default defineConfig({
  name: 'fn-fixture',
  schema: defineSchema({ products, orders, seen }, { paths: { rooms } }),
  firebase: { projectId: 'demo-icebase' },
  environments: { test: { mode: 'firebase' }, local: { mode: 'emulator' } },
});
