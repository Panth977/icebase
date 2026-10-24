// `icebase gen dart` — the Dart side of icebase.config.ts: one model class per collection
// (fromMap / toMap), typed Field descriptors for queries and updates, enums, nested map classes,
// the schema with its declared indexes, and the config (environments, emulator, custom auth).

import type { AnyDbPath, AnyFilePath, FieldDef, FieldMap } from '@panth977/icebase/schema';
import { resolveModes, SERVICES, type AnyConfig } from '@panth977/icebase/config';

const RESERVED = new Set('abstract as assert async await base break case catch class const continue covariant default deferred do dynamic else enum export extends extension external factory false final finally for Function get hide if implements import in interface is late library mixin new null of on operator part required rethrow return sealed set show static super switch sync this throw true try type typedef var void when while with yield'.split(' '));

const pascal = (s: string) => s.replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (_m, _a, c: string) => c.toUpperCase()).replace(/^[0-9]/, '_$&');
const camel = (s: string) => {
  const p = pascal(s);
  const c = p.charAt(0).toLowerCase() + p.slice(1);
  return RESERVED.has(c) ? `${c}_` : c;
};
const singular = (s: string) => (/ies$/.test(s) ? s.replace(/ies$/, 'y') : /(ss|x|ch|sh)es$/.test(s) ? s.replace(/es$/, '') : /s$/.test(s) && !/ss$/.test(s) ? s.slice(0, -1) : s);
const str = (s: string) => `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\$')}'`;

interface Ctx {
  out: string[];
  /** Classes / enums already written, by name. */
  made: Set<string>;
}

/** The Dart type for a field (classes and enums it needs are written into ctx). */
function dartType(ctx: Ctx, def: FieldDef, name: string): string {
  switch (def.kind) {
    case 'string':
      return 'String';
    case 'number':
      return def.int ? 'int' : 'num';
    case 'boolean':
      return 'bool';
    case 'timestamp':
      return 'Timestamp';
    case 'geopoint':
      return 'GeoPoint';
    case 'ref':
      return 'DocPath';
    case 'enum': {
      const e = name;
      if (!ctx.made.has(e)) {
        ctx.made.add(e);
        ctx.out.push(`enum ${e} implements IceEnum {\n${def.values.map((v) => `  ${camel(v)}(${str(v)})`).join(',\n')};\n\n  const ${e}(this.value);\n  @override\n  final String value;\n  static ${e} from(String v) => values.firstWhere((x) => x.value == v, orElse: () => throw IceBaseException('invalid-argument', '${e}: unknown value $v'));\n}\n`);
      }
      return e;
    }
    case 'array':
      return `List<${dartType(ctx, def.of.def, `${name}Item`)}>`;
    case 'map':
      modelClass(ctx, name, def.fields);
      return name;
    case 'record':
      return `Map<String, ${dartType(ctx, def.of.def, `${name}Value`)}${def.of.nullable ? '?' : ''}>`;
    case 'literal':
      return typeof def.value === 'string' ? 'String' : typeof def.value === 'number' ? 'num' : typeof def.value === 'boolean' ? 'bool' : 'Object?';
    case 'union':
    case 'any':
      return 'Object?';
  }
}

function fromExpr(ctx: Ctx, def: FieldDef, name: string, v: string): string {
  switch (def.kind) {
    case 'string':
      return `${v} as String`;
    case 'number':
      return def.int ? `(${v} as num).toInt()` : `${v} as num`;
    case 'boolean':
      return `${v} as bool`;
    case 'timestamp':
      return `${v} as Timestamp`;
    case 'geopoint':
      return `${v} as GeoPoint`;
    case 'ref':
      return `${v} as DocPath`;
    case 'enum':
      return `${dartType(ctx, def, name)}.from(${v} as String)`;
    case 'array':
      return `[for (final x in ${v} as List) ${fromExpr(ctx, def.of.def, `${name}Item`, 'x')}]`;
    case 'map':
      return `${dartType(ctx, def, name)}.fromMap((${v} as Map).cast<String, Object?>())`;
    case 'record':
      return `{for (final e in (${v} as Map).entries) e.key as String: ${def.of.nullable ? 'e.value == null ? null : ' : ''}${fromExpr(ctx, def.of.def, `${name}Value`, 'e.value')}}`;
    case 'literal':
      return `${v} as ${dartType(ctx, def, name)}`;
    case 'union':
    case 'any':
      return v;
  }
}

function toExpr(def: FieldDef, v: string): string {
  switch (def.kind) {
    case 'enum':
      return `${v}.value`;
    case 'map':
      return `${v}.toMap()`;
    case 'array': {
      const inner = toExpr(def.of.def, 'x');
      return inner === 'x' ? v : `[for (final x in ${v}) ${inner}]`;
    }
    case 'record': {
      const inner = toExpr(def.of.def, 'e.value');
      return inner === 'e.value' ? v : `{for (final e in ${v}.entries) e.key: ${def.of.nullable ? 'e.value == null ? null : ' : ''}${def.of.nullable ? toExpr(def.of.def, 'e.value!') : inner}}`;
    }
    default:
      return v;
  }
}

/** A Dart class for a set of fields (a document or a map field). */
function modelClass(ctx: Ctx, cls: string, fields: FieldMap): void {
  if (ctx.made.has(cls)) return;
  ctx.made.add(cls);
  const entries = Object.entries(fields).map(([key, f]) => ({ key, prop: camel(key), def: f.def, optional: f.optional || !!f.nullable, type: dartType(ctx, f.def, `${cls}${pascal(key)}`) }));
  const lines = [`class ${cls} implements IceModel {`];
  for (const e of entries) lines.push(`  final ${e.type}${e.optional && !e.type.endsWith('?') ? '?' : ''} ${e.prop};`);
  lines.push('', `  const ${cls}({${entries.map((e) => `${e.optional ? '' : 'required '}this.${e.prop}`).join(', ')}});`, '');
  lines.push(`  factory ${cls}.fromMap(Map<String, Object?> m) => ${cls}(`);
  for (const e of entries) lines.push(`        ${e.prop}: ${e.optional ? `m[${str(e.key)}] == null ? null : ` : ''}${fromExpr(ctx, e.def, `${cls}${pascal(e.key)}`, `m[${str(e.key)}]`)},`);
  lines.push('      );', '');
  lines.push('  @override', '  Map<String, Object?> toMap() => {');
  for (const e of entries) lines.push(`        ${e.optional ? `if (${e.prop} != null) ` : ''}${str(e.key)}: ${toExpr(e.def, e.optional ? `${e.prop}!` : e.prop)},`);
  lines.push('      };', '}', '');
  ctx.out.push(lines.join('\n'));
}

function fieldDefExpr(def: FieldDef, optional: boolean, nullable = false): string {
  const o = [optional ? 'optional: true' : '', nullable ? 'nullable: true' : ''].filter(Boolean).join(', ');
  const args = (...a: string[]) => a.filter(Boolean).join(', ');
  switch (def.kind) {
    case 'string':
      return `StringField(${args(def.min !== undefined ? `min: ${def.min}` : '', def.max !== undefined ? `max: ${def.max}` : '', o)})`;
    case 'number':
      return `NumberField(${args(def.int ? 'integer: true' : '', def.min !== undefined ? `min: ${def.min}` : '', def.max !== undefined ? `max: ${def.max}` : '', o)})`;
    case 'boolean':
      return `BooleanField(${o})`;
    case 'timestamp':
      return `TimestampField(${o})`;
    case 'geopoint':
      return `GeoPointField(${o})`;
    case 'enum':
      return `EnumField([${def.values.map(str).join(', ')}]${o ? `, ${o}` : ''})`;
    case 'ref':
      return `RefField(${str(def.to.path)}${o ? `, ${o}` : ''})`;
    case 'array':
      return `ArrayField(${fieldDefExpr(def.of.def, false, !!def.of.nullable)}${def.max !== undefined ? `, max: ${def.max}` : ''}${o ? `, ${o}` : ''})`;
    case 'map':
      return `MapField({${Object.entries(def.fields).map(([k, f]) => `${str(k)}: ${fieldDefExpr(f.def, f.optional, !!f.nullable)}`).join(', ')}}${o ? `, ${o}` : ''})`;
    case 'record':
      return `RecordField(${fieldDefExpr(def.of.def, false, !!def.of.nullable)}${o ? `, ${o}` : ''})`;
    case 'union':
      return `UnionField([${def.of.map((u) => fieldDefExpr(u.def, false, !!u.nullable)).join(', ')}]${o ? `, ${o}` : ''})`;
    case 'literal':
      return `LiteralField(${def.value === null ? 'null' : typeof def.value === 'string' ? str(def.value) : String(def.value)}${o ? `, ${o}` : ''})`;
    case 'any':
      return `AnyField(${o})`;
  }
}

/** Every field path of a collection (through maps), with its Dart type. */
function fieldPaths(ctx: Ctx, fields: FieldMap, cls: string, prefix: string[] = []): { path: string[]; type: string }[] {
  const out: { path: string[]; type: string }[] = [];
  for (const [key, f] of Object.entries(fields)) {
    const path = [...prefix, key];
    out.push({ path, type: dartType(ctx, f.def, `${cls}${pascal(key)}`) });
    if (f.def.kind === 'map') out.push(...fieldPaths(ctx, f.def.fields, `${cls}${pascal(key)}`, path));
  }
  return out;
}

export function genDart(config: AnyConfig, opts: { package?: string } = {}): string {
  const ctx: Ctx = { out: [], made: new Set() };
  const holders: string[] = [];
  const collections = Object.entries(config.schema.collections);
  for (const [key, c] of collections) {
    const holder = pascal(key);
    const model = pascal(singular(key)) === holder ? `${holder}Doc` : pascal(singular(key));
    modelClass(ctx, model, c.fields);
    const fields = fieldPaths(ctx, c.fields, model);
    const idx = c.indexes.map((ix) => `IndexDef([${ix.fields.map((f) => `IndexField([${f.path.map(str).join(', ')}]${f.mode === 'asc' ? '' : `, ${str(f.mode)}`})`).join(', ')}])`);
    const lines = [
      `/// collection(${str(c.path)})`,
      `abstract final class ${holder} {`,
      `  static const def = CollectionDef(`,
      `    ${str(c.path)},`,
      `    fields: {${Object.entries(c.fields).map(([k, f]) => `${str(k)}: ${fieldDefExpr(f.def, f.optional, !!f.nullable)}`).join(', ')}},`,
      `    indexes: [${idx.join(', ')}],`,
      ...(c.group ? ['    group: true,'] : []),
      '  );',
      `  static final type = CollectionType<${model}>(def, fromMap: ${model}.fromMap, toMap: (v) => v.toMap());`,
      ...fields.map((f) => `  static const ${camel(f.path.join('_'))} = Field<${model}, ${f.type}>([${f.path.map(str).join(', ')}]);`),
      `  static final id = Field.documentId<${model}>();`,
      '}',
      '',
    ];
    holders.push(lines.join('\n'));
  }
  // Realtime Database paths: the value's Dart type and a typed DbPathType.
  const paths: string[] = [];
  for (const [key, p] of Object.entries((config.schema.paths ?? {}) as Record<string, AnyDbPath>)) {
    const holder = pascal(key);
    const name = pascal(singular(key)) === holder ? `${holder}Value` : pascal(singular(key));
    const type = dartType(ctx, p.value.def, name);
    const from = fromExpr(ctx, p.value.def, name, 'v');
    holders.push(
      [
        `/// dbPath(${str(p.path)})`,
        `abstract final class ${holder} {`,
        `  static const def = DbPathDef(${str(p.path)}, ${fieldDefExpr(p.value.def, p.value.optional)}${p.indexOn.length ? `, indexOn: [${p.indexOn.map(str).join(', ')}]` : ''});`,
        `  static final type = DbPathType<${type}>(def, fromValue: (v) => ${p.value.def.kind === 'map' ? `${name}.fromMap((v as Map).cast<String, Object?>())` : from}, toValue: (v) => ${toExpr(p.value.def, 'v')});`,
        '}',
        '',
      ].join('\n'),
    );
    paths.push(`${holder}.def`);
  }
  const files: string[] = [];
  for (const [key, f] of Object.entries((config.schema.files ?? {}) as Record<string, AnyFilePath>)) {
    const holder = pascal(key);
    holders.push(`/// filePath(${str(f.path)})\nabstract final class ${holder} {\n  static const def = FilePathDef(${str(f.path)}${f.contentTypes.length ? `, contentTypes: [${f.contentTypes.map(str).join(', ')}]` : ''}${f.maxBytes !== undefined ? `, maxBytes: ${f.maxBytes}` : ''});\n}\n`);
    files.push(`${holder}.def`);
  }
  const envs = Object.keys(config.environments).map((e) => {
    const m = resolveModes(config, e);
    return `    ${str(e)}: {${SERVICES.map((s) => `${str(s)}: ${str(m[s])}`).join(', ')}},`;
  });
  const custom = config.auth?.custom;
  const customExpr = custom
    ? `CustomAuthInfo(email: ${!!custom.email}, phone: ${!!custom.phone}, google: ${!!custom.google}, emailSignIn: ${str(custom.email?.signIn ?? 'link')}${custom.endpoint ? `, endpoint: ${str(custom.endpoint)}` : ''}${custom.security?.store?.path ? `, storePath: ${str(custom.security.store.path)}` : ''})`
    : null;
  return [
    '// GENERATED by `icebase gen dart` from icebase.config.ts — do not edit.',
    '// ignore_for_file: constant_identifier_names, non_constant_identifier_names',
    '',
    `import 'package:${opts.package ?? 'icebase'}/icebase.dart';`,
    '',
    ...ctx.out,
    ...holders,
    `/// The IceBase config of ${config.name}.`,
    'final icebaseConfig = IceBaseConfig(',
    `  name: ${str(config.name)},`,
    `  projectId: ${str(config.firebase?.projectId ?? `demo-${config.name}`)},`,
    `  schema: Schema(collections: [${collections.map(([k]) => `${pascal(k)}.def`).join(', ')}]${paths.length ? `, paths: [${paths.join(', ')}]` : ''}${files.length ? `, files: [${files.join(', ')}]` : ''}),`,
    '  environments: {',
    ...envs,
    '  },',
    ...(config.emulator?.host ? [`  emulatorHost: ${str(config.emulator.host)},`] : []),
    ...(config.emulator?.port ? [`  emulatorPort: ${config.emulator.port},`] : []),
    ...(config.functions?.region ? [`  functionsRegion: ${str(config.functions.region)},`] : []),
    ...(config.firebase?.storageBucket ? [`  storageBucket: ${str(config.firebase.storageBucket)},`] : []),
    ...(config.firebase?.databaseURL ? [`  databaseUrl: ${str(config.firebase.databaseURL)},`] : []),
    ...(customExpr ? [`  customAuth: ${customExpr},`] : []),
    ');',
    '',
  ].join('\n');
}
