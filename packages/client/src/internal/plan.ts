// The index rule, at runtime (IDX-2). Same rule as the compile-time check in icebase/firestore,
// plus what the types cannot see: order of fields, directions and filters nested in
// and()/or(). Every index a query uses must be declared — single-field ones too. Used by the
// SDK before a query leaves (every mode) and by the emulator's query planner.
//
// Fields are key paths (['address', 'city']); IceBase never splits a string on dots.

import { IceBaseError } from '../errors.ts';
import { pathKey, showPath, type AnyCollection, type IndexField, type ParsedIndex } from '../schema.ts';

export type WhereOp = '==' | '!=' | '<' | '<=' | '>' | '>=' | 'in' | 'not-in' | 'array-contains' | 'array-contains-any';

export interface FieldFilter {
  kind: 'field';
  /** The key path; ['__name__'] is the document id. */
  field: string[];
  op: WhereOp;
  value: unknown;
}
export type FilterNode = FieldFilter | { kind: 'and' | 'or'; filters: FilterNode[] };

export interface OrderSpec {
  field: string[];
  dir: 'asc' | 'desc';
}

export interface QuerySpec {
  /** Concrete collection path ('users/u1/orders'), or null for a collection-group query. */
  path: string | null;
  /** The collection id ('orders'). */
  collectionId: string;
  filters: FilterNode[];
  orders: OrderSpec[];
  limit?: { n: number; last: boolean };
  start?: { values: unknown[]; inclusive: boolean; snapshot?: unknown };
  end?: { values: unknown[]; inclusive: boolean; snapshot?: unknown };
}

const EQ: ReadonlySet<WhereOp> = new Set(['==', 'in']);
const CONTAINS: ReadonlySet<WhereOp> = new Set(['array-contains', 'array-contains-any']);
export const isName = (p: readonly string[]) => p.length === 1 && p[0] === '__name__';

/** Flatten and()/or() into disjunctive normal form: a list of AND-ed field filters. */
export function dnf(filters: FilterNode[]): FieldFilter[][] {
  const of = (n: FilterNode): FieldFilter[][] => {
    if (n.kind === 'field') return [[n]];
    if (n.kind === 'or') return n.filters.flatMap(of);
    return n.filters.reduce<FieldFilter[][]>((acc, child) => acc.flatMap((a) => of(child).map((b) => [...a, ...b])), [[]]);
  };
  return of({ kind: 'and', filters });
}

/** What one conjunction needs. */
interface Need {
  /** Every field the conjunction touches. */
  fields: string[][];
  eq: string[][];
  contains: string[] | null;
  /** The ordered (range / orderBy) fields that are not equality fields, in order. */
  ordered: OrderSpec[];
}

export interface IndexNeed {
  fields: string[][];
  /** The index(…) to declare, as code. */
  suggestion: string;
}

function needFor(conj: FieldFilter[], orders: OrderSpec[]): Need | null {
  const eq = new Map<string, string[]>();
  let contains: string[] | null = null;
  const inequality = new Map<string, string[]>();
  for (const f of conj) {
    if (isName(f.field)) continue;
    if (EQ.has(f.op)) eq.set(pathKey(f.field), f.field);
    else if (CONTAINS.has(f.op)) contains = f.field;
    else inequality.set(pathKey(f.field), f.field);
  }
  const ordered: OrderSpec[] = orders.filter((o) => !isName(o.field));
  // Firestore orders by every inequality field (implicitly, ascending) after the explicit orders.
  for (const [k, p] of [...inequality].sort(([a], [b]) => (a < b ? -1 : 1))) if (!ordered.some((o) => pathKey(o.field) === k)) ordered.push({ field: p, dir: 'asc' });
  const sorted = ordered.filter((o) => !eq.has(pathKey(o.field)));
  const all = new Map<string, string[]>([...eq, ...(contains ? [[pathKey(contains), contains] as [string, string[]]] : []), ...sorted.map((o) => [pathKey(o.field), o.field] as [string, string[]])]);
  if (all.size === 0) return null;
  return { fields: [...all.values()], eq: [...eq.values()], contains, ordered: sorted };
}

const single = (ix: ParsedIndex) => ix.fields.length === 1;
const declaresSingle = (c: AnyCollection, p: string[]) => c.indexes.some((ix) => single(ix) && pathKey(ix.fields[0]!.path) === pathKey(p));

/** A composite that serves the conjunction: the same fields, the ordered ones as its tail in order (or all reversed). */
function serves(ix: ParsedIndex, n: Need): boolean {
  const fields = ix.fields;
  if (fields.length !== n.fields.length) return false;
  const want = new Set(n.fields.map(pathKey));
  if (!fields.every((f) => want.has(pathKey(f.path)))) return false;
  const containsEntry = fields.find((f) => f.mode === 'contains');
  if ((containsEntry ? pathKey(containsEntry.path) : null) !== (n.contains ? pathKey(n.contains) : null)) return false;
  const tail: IndexField[] = fields.slice(fields.length - n.ordered.length);
  if (tail.some((t) => t.mode === 'contains')) return false;
  if (!tail.every((t, i) => pathKey(t.path) === pathKey(n.ordered[i]!.field))) return false;
  const same = tail.every((t, i) => t.mode === n.ordered[i]!.dir);
  const reversed = tail.every((t, i) => t.mode !== n.ordered[i]!.dir);
  return same || reversed;
}

const code = (p: string[]) => (p.length === 1 ? `'${p[0]}'` : `[${p.map((s) => `'${s}'`).join(', ')}]`);

/** The index serving one conjunction, a list of single-field indexes merged, or what is missing. */
function choose(c: AnyCollection, n: Need): { ok: true; uses: ParsedIndex[] } | { ok: false; missing: IndexNeed } {
  // One field: its single-field index (an array field's serves array-contains too).
  if (n.fields.length === 1) {
    const p = n.fields[0]!;
    const ix = c.indexes.find((x) => single(x) && pathKey(x.fields[0]!.path) === pathKey(p));
    return ix ? { ok: true, uses: [ix] } : { ok: false, missing: { fields: [p], suggestion: `index(${code(p)})` } };
  }
  const composite = c.indexes.find((x) => !single(x) && serves(x, n));
  if (composite) return { ok: true, uses: [composite] };
  // Equality / contains only: Firestore merges single-field indexes, so every field's will do.
  if (n.ordered.length === 0 && n.fields.every((p) => declaresSingle(c, p))) return { ok: true, uses: n.fields.map((p) => c.indexes.find((x) => single(x) && pathKey(x.fields[0]!.path) === pathKey(p))!) };
  const parts = [...n.eq.map(code), ...(n.contains ? [`contains(${code(n.contains)})`] : []), ...n.ordered.map((o) => (o.dir === 'desc' ? `desc(${code(o.field)})` : code(o.field)))];
  if (n.ordered.length === 0) {
    const lacking = n.fields.filter((p) => !declaresSingle(c, p));
    return { ok: false, missing: { fields: lacking, suggestion: lacking.map((p) => `index(${code(p)})`).join(', ') } };
  }
  return { ok: false, missing: { fields: n.fields, suggestion: `index(${parts.join(', ')})` } };
}

/** The declared indexes serving each disjunction, or the first missing one. */
export function planQuery(c: AnyCollection, spec: QuerySpec): { ok: true; indexes: ParsedIndex[][] } | { ok: false; missing: IndexNeed } {
  const used: ParsedIndex[][] = [];
  for (const conj of dnf(spec.filters)) {
    const n = needFor(conj, spec.orders);
    if (!n) {
      used.push([]);
      continue;
    }
    const r = choose(c, n);
    if (!r.ok) return r;
    used.push(r.uses);
  }
  return { ok: true, indexes: used };
}

/** Throw the IDX-2 error when a query needs an index that is not declared. */
export function assertIndexed(c: AnyCollection, spec: QuerySpec): void {
  if (spec.path === null && !c.group) {
    throw new IceBaseError('failed-precondition', `collectionGroup('${c.id}') needs \`group: true\` on collection('${c.path}') in the schema, so its indexes are declared with collection-group scope.`, { reason: 'missing-index', collection: c.path });
  }
  const r = planQuery(c, spec);
  if (r.ok) return;
  throw new IceBaseError(
    'failed-precondition',
    `The query on '${c.path}' needs an index on ${r.missing.fields.map(showPath).join(' + ')} that is not declared.\nAdd ${r.missing.suggestion} to the indexes of collection('${c.path}') in your schema.`,
    { reason: 'missing-index', collection: c.path, index: r.missing.suggestion },
  );
}

/** The full order of a query: explicit orders, implicit inequality orders, then __name__. */
export function fullOrder(spec: QuerySpec): OrderSpec[] {
  const orders = [...spec.orders];
  const ineq = new Map<string, string[]>();
  for (const conj of dnf(spec.filters)) for (const f of conj) if (!['==', 'in', 'array-contains', 'array-contains-any'].includes(f.op) && !isName(f.field)) ineq.set(pathKey(f.field), f.field);
  for (const [k, p] of [...ineq].sort(([a], [b]) => (a < b ? -1 : 1))) if (!orders.some((o) => pathKey(o.field) === k)) orders.push({ field: p, dir: 'asc' });
  if (!orders.some((o) => isName(o.field))) orders.push({ field: ['__name__'], dir: orders.length ? orders[orders.length - 1]!.dir : 'asc' });
  return orders;
}
