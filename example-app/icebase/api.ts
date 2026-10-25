// The API's schema: every endpoint the app calls, what it takes and what it gives — built from the
// database schema where it can be. Server (onCall / onRequest) and clients (callable / request)
// are checked against it; `icebase docs` renders it; `icebase check` makes sure it is implemented.
import { defineApi, docOf, endpoint, fieldOf, listOf, pick } from '@panth977/icebase/api';
import { f } from '@panth977/icebase/schema';
import { orders, products } from './schema';

export const api = defineApi({
  cancelOrder: endpoint({
    tag: 'Orders',
    summary: 'Cancel one of my pending orders',
    input: f.map({ orderId: f.string({ min: 1 }) }),
    output: f.map({ ok: f.literal(true) }),
    errors: { unauthenticated: 'Not signed in', 'failed-precondition': 'The order is no longer pending' },
  }),
  lowStock: endpoint({
    tag: 'Products',
    summary: 'Names of active products with fewer than 5 in stock',
    input: f.map({}),
    output: f.map({ names: listOf(fieldOf(products, 'name')) }),
    auth: 'none',
  }),
  getProduct: endpoint({
    tag: 'Products',
    summary: 'One product, by id',
    http: { method: 'GET', path: '/products/{id}' },
    input: f.map({ id: f.string() }),
    output: docOf(products),
    errors: { 'not-found': 'No product with that id' },
    auth: 'none',
  }),
  orderSummary: endpoint({
    tag: 'Orders',
    summary: 'Status and total of one of my orders',
    http: { method: 'GET', path: '/orders/{orderId}' },
    input: f.map({ orderId: f.string() }),
    output: pick(orders, ['status', 'totalCents']),
    errors: { 'not-found': 'No such order of yours' },
  }),
});
