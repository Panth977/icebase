// The schema the Dart tests run against (generated to icebase.g.dart by `icebase gen dart`).
import { defineConfig, senders } from '@panth977/icebase/config';
import { collection, contains, dbPath, defineSchema, desc, f, filePath, index } from '@panth977/icebase/schema';

const products = collection('products', {
  fields: {
    name: f.string(),
    priceCents: f.number({ int: true, min: 0 }),
    category: f.enum(['shoes', 'shirts', 'bags']),
    tags: f.array(f.string()),
    stock: f.number({ int: true }),
    active: f.boolean(),
    updatedAt: f.optional(f.timestamp()),
    dims: f.optional(f.map({ w: f.number(), h: f.number() })),
    'rating.avg': f.optional(f.number()),
  },
  indexes: [index('category'), index('stock'), index('active'), index('tags'), index(['dims', 'w']), index('rating.avg'), index('category', 'priceCents'), index(contains('tags'), desc('priceCents'))],
});
const orders = collection('users/{uid}/orders', {
  fields: { product: f.ref(products), qty: f.number({ int: true, min: 1 }), status: f.enum(['pending', 'paid']) },
  indexes: [index('status')],
  group: true,
});
const messages = dbPath('rooms/{roomId}/messages/{msgId}', f.map({ text: f.string(), at: f.number(), by: f.string() }), { indexOn: ['at'] });
const avatars = filePath('avatars/{uid}/{file}', { contentTypes: ['image/*'], maxMb: 1 });

export default defineConfig({
  name: 'dart-test',
  schema: defineSchema({ products, orders }, { paths: { messages }, files: { avatars } }),
  auth: { providers: ['password', 'emailLink', 'phone'], custom: { email: { sender: senders.console(), signIn: 'code' }, phone: { sender: senders.console() } } },
  functions: { source: 'functions' },
  firebase: { projectId: 'demo-dart', storageBucket: 'demo-dart.appspot.com' },
  environments: { local: { mode: 'emulator' } },
});
