import { collection, desc, f, index } from '@panth977/icebase/schema';
import { products } from './products';

// Subcollection: users/{uid}/orders/{orderId}. `group: true` because server/ queries it with collectionGroup().
export const orders = collection('users/{uid}/orders', {
  fields: {
    status: f.enum(['pending', 'paid', 'shipped', 'cancelled']),
    items: f.array(f.map({ product: f.ref(products), qty: f.number({ int: true, min: 1 }) })),
    totalCents: f.number({ int: true }),
    createdAt: f.timestamp(),
  },
  indexes: [index('status'), index('status', desc('createdAt'))],
  group: true,
});
