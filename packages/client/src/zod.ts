// fromZod: an IceBase field map from a zod object schema, so a project that already describes
// its documents with zod (v3 or v4) declares its IceBase schema from the same source:
//
//   const tickets = collection('boards/{b}/tickets', { fields: fromZod(TicketSchema), indexes: [...] });
//
// zod is not a dependency: the schema is read through its public definition objects.

import { IceBaseError } from './errors.ts';
import { f, type Field, type FieldMap } from './schema.ts';

// deno-lint-ignore no-explicit-any
type Z = any;

/** The definition of a zod type, v3 (`_def.typeName`) or v4 (`_zod.def.type`). */
function defOf(z: Z): { type: string; def: Z } {
  if (z?._zod?.def) return { type: String(z._zod.def.type), def: z._zod.def };
  if (z?._def?.typeName) return { type: String(z._def.typeName).replace(/^Zod/, '').toLowerCase(), def: z._def };
  throw new IceBaseError('invalid-argument', 'fromZod(…): not a zod schema', { reason: 'schema' });
}

/** v3 keeps limits in `checks: [{kind, value}]`; v4 in `checks: [{_zod: {def: {check, …}}}]`. */
function limits(def: Z): { min?: number; max?: number; int?: boolean } {
  const out: { min?: number; max?: number; int?: boolean } = {};
  for (const c of def.checks ?? []) {
    const d = c?._zod?.def ?? c;
    const kind = d.kind ?? d.check;
    const v = d.value ?? d.minimum ?? d.maximum ?? d.length;
    if (kind === 'min' || kind === 'min_length' || kind === 'greater_than') out.min = Number(v);
    else if (kind === 'max' || kind === 'max_length' || kind === 'less_than') out.max = Number(v);
    else if (kind === 'length' || kind === 'length_equals') out.min = out.max = Number(v);
    else if (kind === 'int' || (kind === 'number_format' && /int/.test(String(d.format)))) out.int = true;
  }
  return out;
}

const objectShape = (def: Z): Record<string, Z> => (typeof def.shape === 'function' ? def.shape() : def.shape);

/** A whole zod object → the field map of a collection. */
export function fromZod(schema: Z): FieldMap {
  return zodDocument(schema).fields;
}

/** A whole zod object → { fields, rest } for collection(path, { ...zodDocument(Schema), indexes }). */
export function zodDocument(schema: Z): { fields: FieldMap; rest?: Field<unknown> } {
  const { type } = unwrap(schema);
  if (type !== 'object') throw new IceBaseError('invalid-argument', `fromZod(…): a document schema must be a z.object(…), got ${type}`, { reason: 'schema' });
  const m = fieldFromZod(schema).def as { kind: 'map'; fields: FieldMap; rest?: Field<unknown> };
  return { fields: m.fields, ...(m.rest ? { rest: m.rest } : {}) };
}

/** Effects, brands, pipes and readonly wrap the type that is stored. */
function unwrap(z: Z): { type: string; def: Z } {
  let cur = defOf(z);
  for (;;) {
    const { type, def } = cur;
    if (type === 'effects') cur = defOf(def.schema);
    else if (type === 'branded' || type === 'readonly') cur = defOf(def.type ?? def.innerType);
    else if (type === 'pipeline' || type === 'pipe') cur = defOf(def.in);
    else return cur;
  }
}

/** One zod type → an IceBase field. */
export function fieldFromZod(z: Z): Field<unknown> {
  const { type, def } = unwrap(z);
  switch (type) {
    case 'optional':
    case 'default':
    case 'prefault':
    case 'catch':
      return f.optional(fieldFromZod(def.innerType));
    case 'nullable':
      return f.nullable(fieldFromZod(def.innerType));
    case 'string':
      return f.string(pick(limits(def), 'min', 'max'));
    case 'number':
    case 'int':
      return f.number({ ...limits(def), ...(type === 'int' ? { int: true } : {}) });
    case 'bigint':
      return f.number({ int: true });
    case 'boolean':
      return f.boolean();
    case 'date':
      return f.timestamp();
    case 'enum': {
      const values = Array.isArray(def.values) ? def.values : Object.values(def.entries ?? def.values ?? {});
      return f.enum(values.map(String));
    }
    case 'nativeenum':
      return f.enum(Object.values(def.values).filter((v): v is string => typeof v === 'string'));
    case 'literal': {
      const values: unknown[] = def.values ?? [def.value];
      if (values.every((v) => typeof v === 'string')) return f.enum(values as string[]);
      if (values.length === 1) return f.literal(values[0] as string | number | boolean | null);
      return f.union(...values.map((v) => f.literal(v as string | number | boolean | null)));
    }
    case 'null':
      return f.literal(null);
    case 'array': {
      const lim = limits(def);
      const max = def.maxLength?.value ?? lim.max;
      const of = fieldFromZod(def.type ?? def.element);
      return f.array(of.optional ? { ...of, optional: false } : of, max !== undefined ? { max } : {});
    }
    case 'tuple':
    case 'set':
      return f.array(f.any());
    case 'object': {
      const shape = objectShape(def);
      // Extra keys allowed (passthrough / catchall): the map cannot be closed.
      const fields = Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, fieldFromZod(v)]));
      const catchall = def.catchall && !['never', 'unknown'].includes(defOf(def.catchall).type) ? fieldFromZod(def.catchall) : null;
      const open = def.unknownKeys === 'passthrough' || (def.catchall && defOf(def.catchall).type === 'unknown');
      return catchall ? f.map(fields, { rest: catchall }) : open ? f.map(fields, { rest: f.any() }) : f.map(fields);
    }
    case 'record':
    case 'map': {
      const v = fieldFromZod(def.valueType);
      return f.record(v.optional ? { ...v, optional: false } : v);
    }
    case 'union':
    case 'discriminatedunion': {
      const options: Z[] = Array.isArray(def.options) ? def.options : [...def.options.values()];
      const fields = options.map(fieldFromZod);
      const nullable = fields.some((x) => x.nullable || (x.def.kind === 'literal' && x.def.value === null));
      const rest = fields.filter((x) => !(x.def.kind === 'literal' && x.def.value === null));
      // A union of string enums / literals is one enum.
      if (rest.length && rest.every((x) => x.def.kind === 'enum')) {
        const e = f.enum(rest.flatMap((x) => (x.def as { values: readonly string[] }).values));
        return nullable ? f.nullable(e) : e;
      }
      const u = rest.length === 1 ? rest[0]! : f.union(...rest);
      return nullable ? f.nullable(u) : u;
    }
    case 'intersection':
    case 'lazy':
    case 'any':
    case 'unknown':
    case 'custom':
    case 'function':
      return f.any();
    default:
      return f.any();
  }
}

function pick<T extends object, K extends keyof T>(o: T, ...keys: K[]): Pick<T, K> {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])) as Pick<T, K>;
}
