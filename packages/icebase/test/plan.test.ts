import { describe, expect, it } from 'vitest';
import { collection, contains, desc, f, index } from '../src/schema.js';
import { assertIndexed, planQuery, type FilterNode, type QuerySpec } from '../src/internal/plan.js';

const products = collection('products', {
  fields: { name: f.string(), priceCents: f.number(), category: f.string(), tags: f.array(f.string()), stock: f.number(), active: f.boolean(), dims: f.map({ w: f.number(), h: f.number() }), 'a.b': f.optional(f.string()) },
  indexes: [
    index('name'),
    index('category'),
    index('active'),
    index('priceCents'),
    index('tags'),
    index(['dims', 'w']),
    index('a.b'),
    index('category', 'priceCents'),
    index(contains('tags'), 'priceCents'),
    index('active', desc('stock')),
    index('category', 'active', 'stock', desc('priceCents')),
  ],
});
const sub = collection('users/{uid}/orders', { fields: { status: f.string() }, indexes: [index('status')] });

const w = (field: string | string[], op: string, value: unknown = 1): FilterNode => ({ kind: 'field', field: typeof field === 'string' ? [field] : field, op: op as never, value });
const spec = (filters: FilterNode[], orders: [string | string[], 'asc' | 'desc'][] = [], path: string | null = 'products'): QuerySpec => ({
  path,
  collectionId: 'products',
  filters,
  orders: orders.map(([field, dir]) => ({ field: typeof field === 'string' ? [field] : field, dir })),
});
const ok = (s: QuerySpec) => planQuery(products, s).ok;

describe('index rule: every index is declared', () => {
  it('needs nothing for a plain listing or document ids', () => {
    expect(ok(spec([]))).toBe(true);
    expect(ok(spec([w('__name__', 'in', [])]))).toBe(true);
  });
  it('single fields need their declared single-field index', () => {
    expect(ok(spec([w('name', '==')]))).toBe(true);
    expect(ok(spec([w('priceCents', '>')], [['priceCents', 'asc']]))).toBe(true);
    expect(ok(spec([w('tags', 'array-contains')]))).toBe(true);
    expect(ok(spec([], [['stock', 'desc']]))).toBe(false); // stock has no single-field index
    expect(ok(spec([w('stock', '==')]))).toBe(false);
  });
  it('merges single-field indexes for equality-only queries', () => {
    expect(ok(spec([w('category', '=='), w('active', '=='), w('tags', 'array-contains')]))).toBe(true);
    expect(ok(spec([w('category', '=='), w('stock', '==')]))).toBe(false);
    expect(ok(spec([w('category', '==')], [['category', 'asc']]))).toBe(true);
  });
  it('key-array paths, and keys with dots are one key', () => {
    expect(ok(spec([w(['dims', 'w'], '>')]))).toBe(true);
    expect(ok(spec([w(['dims', 'h'], '>')]))).toBe(false);
    expect(ok(spec([w('a.b', '==')]))).toBe(true);
    expect(ok(spec([w(['a', 'b'], '==')]))).toBe(false);
  });
  it('accepts declared composites, in either full direction', () => {
    expect(ok(spec([w('category', '==')], [['priceCents', 'asc']]))).toBe(true);
    expect(ok(spec([w('category', '==')], [['priceCents', 'desc']]))).toBe(true);
    expect(ok(spec([w('tags', 'array-contains')], [['priceCents', 'asc']]))).toBe(true);
    expect(ok(spec([w('active', '==')], [['stock', 'desc']]))).toBe(true);
    expect(ok(spec([w('category', 'in', ['a']), w('active', '==')], [['stock', 'asc'], ['priceCents', 'desc']]))).toBe(true);
    expect(ok(spec([w('category', 'in', ['a']), w('active', '==')], [['stock', 'desc'], ['priceCents', 'asc']]))).toBe(true);
  });
  it('refuses undeclared composites', () => {
    expect(ok(spec([w('category', '==')], [['stock', 'asc']]))).toBe(false);
    expect(ok(spec([w('priceCents', '>'), w('stock', '<')]))).toBe(false);
    expect(ok(spec([], [['stock', 'asc'], ['priceCents', 'asc']]))).toBe(false);
    expect(ok(spec([w('category', 'in', ['a']), w('active', '==')], [['stock', 'asc'], ['priceCents', 'asc']]))).toBe(false);
    expect(ok(spec([w('category', '=='), w('priceCents', '>')]))).toBe(true);
    expect(ok(spec([w('category', '=='), w('stock', '>')]))).toBe(false);
  });
  it('checks every branch of or()', () => {
    const either = (a: FilterNode, b: FilterNode): FilterNode => ({ kind: 'or', filters: [a, b] });
    expect(ok(spec([either(w('category', '=='), w('active', '=='))], [['priceCents', 'asc']]))).toBe(false);
    expect(ok(spec([either(w('category', '=='), w('tags', 'array-contains'))], [['priceCents', 'asc']]))).toBe(true);
  });
  it('names the index to add, as code', () => {
    expect(() => assertIndexed(products, spec([w('category', '==')], [['stock', 'desc']]))).toThrow("Add index('category', desc('stock'))");
    expect(() => assertIndexed(products, spec([], [['stock', 'desc']]))).toThrow("Add index('stock')");
    expect(() => assertIndexed(products, spec([w(['dims', 'h'], '==')]))).toThrow("Add index(['dims', 'h'])");
  });
  it('wants group: true for collection-group queries', () => {
    expect(() => assertIndexed(sub, { path: null, collectionId: 'orders', filters: [], orders: [] })).toThrow(/group: true/);
  });
});
