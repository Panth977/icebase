// describe(config): the whole project as plain data — the database (collections, fields, indexes,
// Realtime Database paths, storage paths) and the API (endpoints, their input and output) — what
// `icebase docs` renders, `icebase openapi` and `icebase gen dart` read, and a dry run checks.

import type { AnyConfig } from './config.ts';
import { resolveModes, SERVICES } from './config.ts';
import { refOf, sampleOf, toJsonSchema, type AnyEndpoint, type JsonSchema } from './api.ts';
import { validateValue, type AnyCollection, type AnyDbPath, type AnyFilePath, type Field, type FieldDef } from './schema.ts';

/** One field, for people: its type in words, its rules, and its children. */
export interface FieldDoc {
  name: string;
  /** e.g. "string (1..80)", "map", "array of string", "reference to users". */
  type: string;
  kind: FieldDef['kind'];
  optional: boolean;
  nullable: boolean;
  /** The collection it was taken from (docOf / pick), or the one a reference points to. */
  ref?: string;
  values?: readonly string[];
  children?: FieldDoc[];
}

export interface CollectionDoc {
  path: string;
  id: string;
  params: readonly string[];
  group: boolean;
  glob: boolean;
  autoIndex: boolean;
  ttl?: string;
  /** Any other top-level key is allowed (an open document). */
  open: boolean;
  fields: FieldDoc[];
  indexes: { fields: { path: string[]; mode: string }[]; code: string }[];
  sample: unknown;
  jsonSchema: JsonSchema;
}

export interface EndpointDoc {
  name: string;
  kind: 'callable' | 'http';
  method?: string;
  path?: string;
  summary?: string;
  description?: string;
  tag?: string;
  auth: string;
  deprecated: boolean;
  input: FieldDoc;
  output: FieldDoc;
  errors: { code: string; when: string }[];
  example: { input: unknown; output: unknown };
  jsonSchema: { input: JsonSchema; output: JsonSchema };
}

export interface ProjectDoc {
  name: string;
  projectId?: string;
  environments: { name: string; modes: Record<string, string> }[];
  collections: CollectionDoc[];
  paths: { path: string; params: readonly string[]; value: FieldDoc; indexOn: readonly string[]; sample: unknown }[];
  files: { path: string; params: readonly string[]; contentTypes: readonly string[]; maxBytes?: number }[];
  endpoints: EndpointDoc[];
  /** What a dry run found: declarations that contradict themselves. */
  problems: string[];
}

const typeOf = (d: FieldDef): string => {
  switch (d.kind) {
    case 'string':
      return d.min !== undefined || d.max !== undefined ? `string (${d.min ?? 0}..${d.max ?? '∞'})` : 'string';
    case 'number':
      return `${d.int ? 'integer' : 'number'}${d.min !== undefined || d.max !== undefined ? ` (${d.min ?? '-∞'}..${d.max ?? '∞'})` : ''}`;
    case 'array':
      return `array of ${typeOf(d.of.def)}${d.max !== undefined ? ` (max ${d.max})` : ''}`;
    case 'record':
      return `map of ${typeOf(d.of.def)} by key`;
    case 'union':
      return d.of.map((u) => typeOf(u.def)).join(' | ');
    case 'literal':
      return JSON.stringify(d.value);
    case 'enum':
      return 'enum';
    case 'ref':
      return `reference to ${d.to.path}`;
    default:
      return d.kind;
  }
};

export function fieldDoc(name: string, f: Field<unknown>): FieldDoc {
  const d = f.def;
  const ref = refOf(f) ?? (d.kind === 'ref' ? d.to.path : undefined);
  const children: FieldDoc[] | undefined =
    d.kind === 'map'
      ? [...Object.entries(d.fields).map(([k, v]) => fieldDoc(k, v)), ...(d.rest ? [fieldDoc('*', d.rest)] : [])]
      : d.kind === 'array' && (d.of.def.kind === 'map' || d.of.def.kind === 'union')
        ? [fieldDoc('[]', d.of)]
        : d.kind === 'record' && (d.of.def.kind === 'map' || d.of.def.kind === 'union')
          ? [fieldDoc('{key}', d.of)]
          : d.kind === 'union'
            ? d.of.map((u, i) => fieldDoc(`#${i + 1}`, u))
            : undefined;
  return {
    name,
    type: typeOf(d),
    kind: d.kind,
    optional: f.optional,
    nullable: !!f.nullable,
    ...(ref ? { ref } : {}),
    ...(d.kind === 'enum' ? { values: d.values } : {}),
    ...(children?.length ? { children } : {}),
  };
}

const indexCode = (fields: readonly { path: readonly string[]; mode: string }[]) => {
  const k = (p: readonly string[]) => (p.length === 1 ? `'${p[0]}'` : `[${p.map((s) => `'${s}'`).join(', ')}]`);
  return `index(${fields.map((f) => (f.mode === 'desc' ? `desc(${k(f.path)})` : f.mode === 'contains' ? `contains(${k(f.path)})` : k(f.path))).join(', ')})`;
};

function collectionDoc(c: AnyCollection): CollectionDoc {
  const doc: Field<unknown> = { kind: 'map', optional: false, def: { kind: 'map', fields: c.fields, ...(c.rest ? { rest: c.rest } : {}) } };
  return {
    path: c.path,
    id: c.id,
    params: c.params,
    group: c.group,
    glob: !!c.glob,
    autoIndex: !!c.autoIndex,
    ...(c.ttl ? { ttl: c.ttl } : {}),
    open: !!c.rest,
    fields: fieldDoc('', doc).children ?? [],
    indexes: c.indexes.map((ix) => ({ fields: ix.fields.map((f) => ({ path: [...f.path], mode: f.mode })), code: indexCode(ix.fields) })),
    sample: sampleOf(doc),
    jsonSchema: toJsonSchema(doc),
  };
}

/** Everything the config declares, as data; problems lists what a dry run found. */
export function describe(config: AnyConfig): ProjectDoc {
  const problems: string[] = [];
  const colls = Object.values(config.schema.collections);
  const refs = (path: string) => (colls.some((c) => c.path === path) ? `#/components/schemas/${encodeURIComponent(path)}` : undefined);
  const endpoints: EndpointDoc[] = Object.values((config.api ?? {}) as Record<string, AnyEndpoint>).map((e) => {
    const example = e.example ?? sampleOf(e.input);
    // Dry run: the declared example must pass the declared input.
    try {
      validateValue(e.input, example, `${e.name} example`);
    } catch (err) {
      problems.push(`${e.name}: its example does not fit its input — ${(err as Error).message.split('\n').slice(1).join(' ').trim()}`);
    }
    return {
      name: e.name,
      kind: e.http ? 'http' : 'callable',
      ...(e.http ? { method: e.http.method, path: e.http.path } : {}),
      ...(e.summary ? { summary: e.summary } : {}),
      ...(e.description ? { description: e.description } : {}),
      ...(e.tag ? { tag: e.tag } : {}),
      auth: e.auth ?? 'signed-in',
      deprecated: !!e.deprecated,
      input: fieldDoc('input', e.input),
      output: fieldDoc('output', e.output),
      errors: Object.entries(e.errors ?? {}).map(([code, when]) => ({ code, when: String(when) })),
      example: { input: example, output: sampleOf(e.output) },
      jsonSchema: { input: toJsonSchema(e.input, { refs }), output: toJsonSchema(e.output, { refs }) },
    };
  });
  for (const c of colls) {
    if (!c.glob && !c.rest && Object.keys(c.fields).length === 0) problems.push(`collection('${c.path}') declares no fields`);
  }
  return {
    name: config.name,
    ...(config.firebase?.projectId ? { projectId: config.firebase.projectId } : {}),
    environments: Object.keys(config.environments).map((name) => {
      const m = resolveModes(config, name);
      return { name, modes: Object.fromEntries(SERVICES.map((s) => [s, m[s]])) };
    }),
    collections: colls.map(collectionDoc),
    paths: Object.values((config.schema.paths ?? {}) as Record<string, AnyDbPath>).map((p) => ({ path: p.path, params: p.params, value: fieldDoc('value', p.value), indexOn: p.indexOn, sample: sampleOf(p.value) })),
    files: Object.values((config.schema.files ?? {}) as Record<string, AnyFilePath>).map((f) => ({ path: f.path, params: f.params, contentTypes: f.contentTypes, ...(f.maxBytes !== undefined ? { maxBytes: f.maxBytes } : {}) })),
    endpoints,
    problems,
  };
}

/** The HTTP endpoints (and callables, as POST with Firebase's { data } envelope) as OpenAPI 3.1. */
export function openApi(config: AnyConfig, doc: ProjectDoc = describe(config)): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  const errorResponses = (e: EndpointDoc) =>
    Object.fromEntries(
      e.errors.map((x) => {
        const status = { 'invalid-argument': 400, unauthenticated: 401, 'permission-denied': 403, 'not-found': 404, 'already-exists': 409, 'failed-precondition': 400, 'resource-exhausted': 429 }[x.code] ?? 500;
        return [String(status), { description: `${x.code}: ${x.when}` }];
      }),
    );
  for (const e of doc.endpoints) {
    const security = e.auth === 'none' ? [] : [{ firebaseIdToken: [] }];
    if (e.kind === 'http') {
      const params = (e.path!.match(/\{([^}]+)\}/g) ?? []).map((p) => p.slice(1, -1));
      const isBodyless = e.method === 'GET' || e.method === 'DELETE';
      const props = (e.jsonSchema.input.properties ?? {}) as Record<string, JsonSchema>;
      const required = new Set((e.jsonSchema.input.required ?? []) as string[]);
      const parameters = [
        ...params.map((p) => ({ name: p, in: 'path', required: true, schema: props[p] ?? { type: 'string' } })),
        ...(isBodyless ? Object.keys(props).filter((k) => !params.includes(k)).map((k) => ({ name: k, in: 'query', required: required.has(k), schema: props[k] })) : []),
      ];
      (paths[e.path!] ??= {})[e.method!.toLowerCase()] = {
        operationId: e.name,
        ...(e.summary ? { summary: e.summary } : {}),
        ...(e.description ? { description: e.description } : {}),
        ...(e.tag ? { tags: [e.tag] } : {}),
        ...(e.deprecated ? { deprecated: true } : {}),
        security,
        parameters,
        ...(isBodyless ? {} : { requestBody: { required: true, content: { 'application/json': { schema: e.jsonSchema.input } } } }),
        responses: { '200': { description: 'OK', content: { 'application/json': { schema: e.jsonSchema.output } } }, ...errorResponses(e) },
      };
    } else {
      paths[`/${e.name}`] = {
        post: {
          operationId: e.name,
          summary: e.summary ?? e.name,
          description: `${e.description ? `${e.description}\n\n` : ''}A callable (Firebase's callable protocol): the input travels as { "data": … }, the output comes back as { "result": … }.`,
          tags: [e.tag ?? 'Callables'],
          ...(e.deprecated ? { deprecated: true } : {}),
          security,
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { data: e.jsonSchema.input }, required: ['data'] } } } },
          responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { result: e.jsonSchema.output } } } } }, ...errorResponses(e) },
        },
      };
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: `${doc.name} API`, version: '1' },
    servers: doc.projectId ? [{ url: `https://us-central1-${doc.projectId}.cloudfunctions.net` }] : [],
    components: {
      securitySchemes: { firebaseIdToken: { type: 'http', scheme: 'bearer', bearerFormat: 'Firebase ID token' } },
      schemas: Object.fromEntries(doc.collections.map((c) => [c.path, c.jsonSchema])),
    },
    paths,
  };
}
