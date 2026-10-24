// IDX-4: firestore.indexes.json, generated from the schema and never edited by hand.

import { fieldAt, type AnyCollection, type IndexField, type Schema } from '../schema.js';

export type QueryScope = 'COLLECTION' | 'COLLECTION_GROUP';
export interface IndexFieldJson {
  fieldPath: string;
  order?: 'ASCENDING' | 'DESCENDING';
  arrayConfig?: 'CONTAINS';
}
export interface IndexJson {
  collectionGroup: string;
  queryScope: QueryScope;
  fields: IndexFieldJson[];
}
export interface FieldOverrideJson {
  collectionGroup: string;
  fieldPath: string;
  ttl?: boolean;
  indexes: { queryScope: QueryScope; order?: 'ASCENDING' | 'DESCENDING'; arrayConfig?: 'CONTAINS' }[];
}
export interface IndexesFile {
  indexes: IndexJson[];
  fieldOverrides: FieldOverrideJson[];
}

/** Firestore's field-path syntax: keys joined by dots, a key that is not a plain name in backticks. */
export function firebaseFieldPath(path: readonly string[]): string {
  return path.map((k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? k : `\`${k.replace(/[\\`]/g, '\\$&')}\``)).join('.');
}

const fieldJson = (f: IndexField): IndexFieldJson =>
  f.mode === 'contains' ? { fieldPath: firebaseFieldPath(f.path), arrayConfig: 'CONTAINS' } : { fieldPath: firebaseFieldPath(f.path), order: f.mode === 'desc' ? 'DESCENDING' : 'ASCENDING' };

/** The single-field indexes Firebase creates automatically, in one scope. */
const automatic = (scope: QueryScope, isArray: boolean): FieldOverrideJson['indexes'] => [
  { queryScope: scope, order: 'ASCENDING' },
  { queryScope: scope, order: 'DESCENDING' },
  ...(isArray ? [{ queryScope: scope, arrayConfig: 'CONTAINS' as const }] : []),
];

/** Composite indexes (single-field ones are Firebase's automatic indexes). */
export function collectionIndexes(c: AnyCollection): IndexJson[] {
  const scopes: QueryScope[] = c.group ? ['COLLECTION', 'COLLECTION_GROUP'] : ['COLLECTION'];
  const composites = c.indexes.filter((ix) => ix.fields.length > 1);
  return scopes.flatMap((queryScope) => composites.map((ix) => ({ collectionGroup: c.id, queryScope, fields: ix.fields.map(fieldJson) })));
}

/**
 * Field overrides: only declared fields stay indexed. A top-level field no declared index
 * touches is exempted (no index writes, as IceBase never queries it); a collection-group
 * collection's declared single-field indexes get collection-group scope; TTL fields are marked.
 */
export function collectionOverrides(c: AnyCollection): FieldOverrideJson[] {
  const out: FieldOverrideJson[] = [];
  const declared = c.indexes.flatMap((ix) => ix.fields.map((f) => f.path));
  const singles = c.indexes.filter((ix) => ix.fields.length === 1).map((ix) => ix.fields[0]!.path);
  for (const [name, def] of Object.entries(c.fields)) {
    const ttl = c.ttl === name;
    const touched = declared.some((p) => p[0] === name);
    if (!touched) out.push({ collectionGroup: c.id, fieldPath: firebaseFieldPath([name]), ...(ttl ? { ttl: true } : {}), indexes: [] });
    else if (ttl) out.push({ collectionGroup: c.id, fieldPath: firebaseFieldPath([name]), ttl: true, indexes: automatic('COLLECTION', def.def.kind === 'array') });
  }
  if (c.group) {
    for (const p of singles) {
      const isArray = fieldAt(c.fields, p)?.def.kind === 'array';
      out.push({ collectionGroup: c.id, fieldPath: firebaseFieldPath(p), indexes: [...automatic('COLLECTION', isArray), ...automatic('COLLECTION_GROUP', isArray)] });
    }
  }
  return out;
}

export function firestoreIndexesJson(schema: Schema<Record<string, AnyCollection>, any, any>): IndexesFile {
  const cs = Object.values(schema.collections);
  return { indexes: cs.flatMap(collectionIndexes), fieldOverrides: cs.flatMap(collectionOverrides) };
}

/** A stable key for comparing a desired index with one listed by the Admin API. */
export function indexKey(ix: { collectionGroup: string; queryScope: string; fields: IndexFieldJson[] }): string {
  const fields = ix.fields.filter((f) => f.fieldPath !== '__name__').map((f) => `${f.fieldPath}:${f.order ?? f.arrayConfig}`);
  return `${ix.collectionGroup}|${ix.queryScope}|${fields.join(',')}`;
}
