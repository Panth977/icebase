// The schema as TypeScript, for the console's Schema page: one interface per collection (and per
// Realtime Database / Storage path), the constraints the types cannot say as comments.

import type { AnyConfig } from '@panth977/icebase/config';
import type { AnyCollection, AnyDbPath, AnyFilePath, Field, FieldDef, FieldMap } from '@panth977/icebase/schema';

const pascal = (s: string) => s.replace(/(^|[^a-zA-Z0-9]+)([a-zA-Z0-9])/g, (_, __, c: string) => c.toUpperCase());
const key = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));

/** What a field's constraints are, in words (for a trailing comment). */
function note(d: FieldDef): string {
  if (d.kind === 'string' && (d.min !== undefined || d.max !== undefined)) return `length ${d.min ?? 0}..${d.max ?? '∞'}`;
  if (d.kind === 'number') {
    const parts = [d.int ? 'integer' : '', d.min !== undefined || d.max !== undefined ? `${d.min ?? '-∞'}..${d.max ?? '∞'}` : ''].filter(Boolean);
    return parts.join(', ');
  }
  if (d.kind === 'array' && d.max !== undefined) return `at most ${d.max} items`;
  return '';
}

export function typeOf(f: Field<unknown>, indent: string, names: Map<AnyCollection, string>): string {
  const d = f.def;
  let t: string;
  switch (d.kind) {
    case 'string':
      t = 'string';
      break;
    case 'number':
      t = 'number';
      break;
    case 'boolean':
      t = 'boolean';
      break;
    case 'timestamp':
      t = 'Timestamp';
      break;
    case 'geopoint':
      t = 'GeoPoint';
      break;
    case 'any':
      t = 'unknown';
      break;
    case 'literal':
      t = JSON.stringify(d.value);
      break;
    case 'enum':
      t = d.values.map((v) => JSON.stringify(v)).join(' | ');
      break;
    case 'ref':
      t = `DocumentReference<${names.get(d.to) ?? 'DocumentData'}>`;
      break;
    case 'array': {
      const inner = typeOf(d.of, indent, names);
      t = /[|&\s]/.test(inner) && !inner.startsWith('{') ? `(${inner})[]` : `${inner}[]`;
      break;
    }
    case 'record':
      t = `Record<string, ${typeOf(d.of, indent, names)}>`;
      break;
    case 'union':
      t = d.of.map((x) => typeOf(x, indent, names)).join(' | ');
      break;
    case 'map':
      t = objectType(d.fields, indent, names, d.rest);
      break;
  }
  return f.nullable ? `${t} | null` : t;
}

function objectType(fields: FieldMap, indent: string, names: Map<AnyCollection, string>, rest?: Field<unknown>): string {
  const inner = `${indent}  `;
  const lines = Object.entries(fields).map(([k, f]) => {
    const n = note(f.def);
    return `${inner}${key(k)}${f.optional ? '?' : ''}: ${typeOf(f, inner, names)};${n ? ` // ${n}` : ''}`;
  });
  if (rest) lines.push(`${inner}[key: string]: ${typeOf(rest, inner, names)};`);
  return lines.length ? `{\n${lines.join('\n')}\n${indent}}` : '{}';
}

export interface TsBlock {
  kind: 'collection' | 'path' | 'file';
  path: string;
  name: string;
  code: string;
}

/** The project's schema as TypeScript, one block per declaration. */
export function schemaTypeScript(config: AnyConfig): TsBlock[] {
  const cols = Object.entries(config.schema.collections) as [string, AnyCollection][];
  const names = new Map<AnyCollection, string>(cols.map(([k, c]) => [c, pascal(k)]));
  const out: TsBlock[] = [];
  for (const [k, c] of cols) {
    const name = pascal(k);
    const head = [
      `/**`,
      ` * collection('${c.path}')${c.group ? ' · collection group' : ''}${c.ttl ? ` · TTL on ${c.ttl}` : ''}`,
      ...(c.indexes.length ? [` * indexes: ${c.indexes.map((ix) => ix.fields.map((f) => `${f.mode === 'contains' ? 'contains ' : ''}${f.path.join('.')}${f.mode === 'desc' ? ' desc' : ''}`).join(' + ')).join(' · ')}`] : []),
      ` */`,
    ];
    out.push({ kind: 'collection', path: c.path, name, code: `${head.join('\n')}\nexport interface ${name} ${objectType(c.fields, '', names, c.rest)}` });
  }
  for (const [k, p] of Object.entries(config.schema.paths ?? {}) as [string, AnyDbPath][]) {
    const name = pascal(k);
    const head = `/** Realtime Database: ref('${p.path}')${p.indexOn.length ? ` · .indexOn ${p.indexOn.join(', ')}` : ''} */`;
    out.push({ kind: 'path', path: p.path, name, code: `${head}\nexport type ${name} = ${typeOf(p.value, '', names)};` });
  }
  for (const [k, f] of Object.entries(config.schema.files ?? {}) as [string, AnyFilePath][]) {
    const name = pascal(k);
    const types = f.contentTypes.length ? f.contentTypes.map((t) => JSON.stringify(t)).join(' | ') : 'string';
    out.push({ kind: 'file', path: f.path, name, code: `/** Storage: '${f.path}'${f.maxBytes ? ` · at most ${f.maxBytes} bytes` : ''} */\nexport type ${name}ContentType = ${types};` });
  }
  return out;
}
