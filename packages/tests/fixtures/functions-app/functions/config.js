import { defineConfig } from '@panth977/icebase/config';
import { collection, defineSchema, f } from '@panth977/icebase/schema';

export const products = collection('products', { fields: { name: f.string(), stock: f.number({ int: true }) }, indexes: [] });
export const orders = collection('users/{uid}/orders', { fields: { product: f.ref(products), qty: f.number({ int: true, min: 1 }), note: f.optional(f.string()) }, indexes: [] });

export default defineConfig({
  name: 'fn-fixture',
  schema: defineSchema({ products, orders }),
  firebase: { projectId: 'demo-icebase' },
  environments: { test: { mode: 'firebase' }, local: { mode: 'emulator' } },
});
