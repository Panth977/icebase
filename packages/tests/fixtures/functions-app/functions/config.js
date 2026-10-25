import { defineConfig } from '@panth977/icebase/config';
import { defineApi, endpoint, pick } from '@panth977/icebase/api';
import { collection, dbPath, defineSchema, f, index } from '@panth977/icebase/schema';

export const products = collection('products', { fields: { name: f.string(), stock: f.number({ int: true }) }, indexes: [] });
export const orders = collection('users/{uid}/orders', { fields: { product: f.ref(products), qty: f.number({ int: true, min: 1 }), note: f.optional(f.string()) }, indexes: [] });

/** What the event-driven functions record, so tests can see they ran. */
export const seen = collection('seen', { fields: { kind: f.string(), detail: f.any(), attempt: f.optional(f.number()) }, indexes: [index('kind')] });
export const rooms = dbPath('rooms/{roomId}/messages/{msgId}', f.map({ text: f.string() }));

/** The declared API: what each endpoint takes and gives (icebase/api). */
export const api = defineApi({
  addOne: endpoint({ summary: 'Add one', input: f.map({ n: f.number() }), output: f.map({ n: f.number() }), auth: 'none' }),
  productInfo: endpoint({
    summary: 'A product, by id',
    http: { method: 'GET', path: '/products/{id}' },
    input: f.map({ id: f.string(), upper: f.optional(f.boolean()) }),
    output: pick(products, ['name', 'stock']),
    errors: { 'not-found': 'No product with that id' },
    auth: 'none',
  }),
  badOutput: endpoint({ input: f.map({}), output: f.map({ n: f.number() }), auth: 'none' }),
  whoAmI: endpoint({ input: f.map({}), output: f.map({ uid: f.string() }) }),
});

export default defineConfig({
  name: 'fn-fixture',
  schema: defineSchema({ products, orders, seen }, { paths: { rooms } }),
  api,
  firebase: { projectId: 'demo-icebase' },
  environments: { test: { mode: 'firebase' }, local: { mode: 'emulator' } },
});
