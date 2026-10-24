import { collection, contains, desc, f, index } from 'icebase/schema';

export const products = collection('products', {
  fields: {
    name: f.string(),
    priceCents: f.number({ int: true, min: 0 }),
    category: f.enum(['shoes', 'shirts', 'bags']),
    tags: f.array(f.string()),
    stock: f.number({ int: true }),
    active: f.boolean(),
    // A key with a dot in it is just a key: IceBase never splits strings on dots.
    'rating.avg': f.optional(f.number()),
  },
  // Every index a query uses is declared — single-field ones too. Nothing else is indexed.
  indexes: [
    index('name'),
    index('category'),
    index('priceCents'),
    index('stock'),
    index('active'),
    index('tags'),
    index('rating.avg'),
    index('category', 'priceCents'),
    index(contains('tags'), 'priceCents'),
    index('active', desc('stock')),
  ],
});
