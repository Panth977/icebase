// The schema at runtime: what `icebase gen dart` writes from icebase.config.ts. Every write is
// validated against it before it leaves (SCH-1), in every mode — the same rules as the
// TypeScript SDK.

import 'dart:typed_data';

import 'errors.dart';
import 'values.dart';
import 'wire.dart';

/// One field's type.
sealed class FieldDef {
  final bool optional;
  const FieldDef({this.optional = false});
  String get expected;
}

class StringField extends FieldDef {
  final int? min;
  final int? max;
  const StringField({this.min, this.max, super.optional});
  @override
  String get expected => 'string${min != null || max != null ? ' (length ${min ?? 0}..${max ?? '∞'})' : ''}';
}

class NumberField extends FieldDef {
  final bool integer;
  final num? min;
  final num? max;
  const NumberField({this.integer = false, this.min, this.max, super.optional});
  @override
  String get expected => '${integer ? 'integer' : 'number'}${min != null || max != null ? ' (${min ?? '-∞'}..${max ?? '∞'})' : ''}';
}

class BooleanField extends FieldDef {
  const BooleanField({super.optional});
  @override
  String get expected => 'boolean';
}

class TimestampField extends FieldDef {
  const TimestampField({super.optional});
  @override
  String get expected => 'timestamp';
}

class EnumField extends FieldDef {
  final List<String> values;
  const EnumField(this.values, {super.optional});
  @override
  String get expected => values.map((v) => '"$v"').join(' | ');
}

class ArrayField extends FieldDef {
  final FieldDef of;
  final int? max;
  const ArrayField(this.of, {this.max, super.optional});
  @override
  String get expected => 'array of ${of.expected}${max != null ? ' (max $max)' : ''}';
}

class MapField extends FieldDef {
  final Map<String, FieldDef> fields;
  const MapField(this.fields, {super.optional});
  @override
  String get expected => 'map';
}

class RefField extends FieldDef {
  /// The target collection's path template ('users/{uid}/orders').
  final String to;
  const RefField(this.to, {super.optional});
  @override
  String get expected => 'reference to $to';
}

class GeoPointField extends FieldDef {
  const GeoPointField({super.optional});
  @override
  String get expected => 'geopoint';
}

class BytesField extends FieldDef {
  const BytesField({super.optional});
  @override
  String get expected => 'bytes';
}

/// One field of a declared index.
class IndexField {
  final List<String> path;

  /// asc | desc | contains
  final String mode;
  const IndexField(this.path, [this.mode = 'asc']);
}

/// A declared index: one field (single-field) or several (composite).
class IndexDef {
  final List<IndexField> fields;
  const IndexDef(this.fields);
}

/// A declared collection.
class CollectionDef {
  final String path;
  final Map<String, FieldDef> fields;
  final List<IndexDef> indexes;
  final bool group;
  const CollectionDef(this.path, {required this.fields, this.indexes = const [], this.group = false});

  String get id => path.substring(path.lastIndexOf('/') + 1);
  List<String> get params => [for (final m in RegExp(r'\{([A-Za-z_][A-Za-z0-9_]*)\}').allMatches(path)) m.group(1)!];

  /// 'users/{uid}/orders' + ['u1'] → 'users/u1/orders'.
  String fill(List<String> args) {
    final p = params;
    if (args.length != p.length) throw IceBaseException('invalid-argument', "collection '$path' needs ${p.length} path parameter(s), got ${args.length}", reason: 'schema');
    var i = 0;
    return path.split('/').map((s) {
      if (!s.startsWith('{')) return s;
      final v = args[i++];
      if (v.isEmpty || v.contains('/')) throw IceBaseException('invalid-argument', "collection '$path': parameter $s must be non-empty, without '/'", reason: 'schema');
      return v;
    }).join('/');
  }

  /// Does a concrete collection path ('users/u1/orders') belong to this template?
  bool matches(String concrete) {
    final a = path.split('/');
    final b = concrete.split('/');
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!a[i].startsWith('{') && a[i] != b[i]) return false;
    }
    return true;
  }
}

/// A Realtime Database path: 'rooms/{roomId}/messages/{msgId}' holding one value type.
class DbPathDef {
  final String path;
  final FieldDef value;
  final List<String> indexOn;
  const DbPathDef(this.path, this.value, {this.indexOn = const []});
}

/// A Cloud Storage path: where files may go, and what they may be.
class FilePathDef {
  final String path;
  final List<String> contentTypes;
  final int? maxBytes;
  const FilePathDef(this.path, {this.contentTypes = const [], this.maxBytes});

  bool matches(String concrete) {
    final a = path.split('/');
    final b = concrete.split('/');
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i++) {
      if (!a[i].startsWith('{') && a[i] != b[i]) return false;
    }
    return true;
  }
}

class Schema {
  final List<CollectionDef> collections;
  final List<DbPathDef> paths;
  final List<FilePathDef> files;
  const Schema({this.collections = const [], this.paths = const [], this.files = const []});

  CollectionDef? collectionFor(String concretePath) {
    for (final c in collections) {
      if (c.matches(concretePath)) return c;
    }
    return null;
  }
}

/// The definition of the field at a key path (through maps), or null.
FieldDef? fieldAt(Map<String, FieldDef> fields, List<String> path) {
  var cur = fields;
  FieldDef? def;
  for (var i = 0; i < path.length; i++) {
    def = cur[path[i]];
    if (def == null) return null;
    if (i < path.length - 1) {
      if (def is! MapField) return null;
      cur = def.fields;
    }
  }
  return def;
}

String showPath(List<String> p) => p.length == 1 ? "'${p[0]}'" : '[${p.map((s) => "'$s'").join(', ')}]';

// ─── validation ────────────────────────────────────────────────────────────────

class Issue {
  final String path;
  final String expected;
  final String got;
  const Issue(this.path, this.expected, this.got);
  @override
  String toString() => '$path: expected $expected, got $got';
}

String _describe(Object? v) {
  if (v == null) return 'null';
  if (v is FieldValue) return '${v.op}()';
  if (v is String) return '"${v.length > 40 ? '${v.substring(0, 40)}…' : v}"';
  if (v is HasDocPath) return 'reference ${v.path}';
  return '${v.runtimeType} $v';
}

class _Ctx {
  final List<Issue> issues = [];
  final bool write;
  final bool bounds;
  final String kind;
  _Ctx({required this.write, required this.bounds, required this.kind});
}

bool _refMatches(String template, String path) {
  final tpl = template.split('/');
  final segs = path.split('/');
  if (segs.length != tpl.length + 1) return false;
  for (var i = 0; i < tpl.length; i++) {
    if (!tpl[i].startsWith('{') && tpl[i] != segs[i]) return false;
  }
  return true;
}

void _check(FieldDef def, Object? v0, String path, _Ctx ctx, bool partial) {
  final v = v0 is FieldValue ? v0 : storedValue(v0);
  void bad([String? expected]) => ctx.issues.add(Issue(path, expected ?? def.expected, _describe(v)));
  if (v is FieldValue) {
    if (!ctx.write) return bad();
    switch (v.op) {
      case 'serverTimestamp':
        if (def is! TimestampField) bad('${def.expected} (serverTimestamp() only fits timestamp fields)');
      case 'serverTime':
        if (def is! NumberField) bad('${def.expected} (ServerValue.timestamp fits number fields)');
      case 'increment':
        if (def is! NumberField) {
          bad('${def.expected} (increment() only fits number fields)');
        } else if (def.integer && v.operand is! int) {
          bad('increment() by an integer (the field is an integer)');
        }
      case 'arrayUnion' || 'arrayRemove':
        if (def is! ArrayField) {
          bad('${def.expected} (${v.op}() only fits array fields)');
        } else {
          final list = v.operand as List<Object?>;
          for (var i = 0; i < list.length; i++) {
            _check(def.of, list[i], '$path[$i]', ctx, false);
          }
        }
      case 'delete':
        bad('a value (FieldValue.delete() only on optional fields, with update or set merge)');
    }
    return;
  }
  switch (def) {
    case StringField():
      if (v is! String) return bad();
      if (ctx.bounds && ((def.min != null && v.length < def.min!) || (def.max != null && v.length > def.max!))) bad();
    case NumberField():
      if (v is! num || (v is double && v.isNaN)) return bad();
      if (def.integer && v is! int && v != v.roundToDouble()) return bad();
      if (ctx.bounds && ((def.min != null && v < def.min!) || (def.max != null && v > def.max!))) bad();
    case BooleanField():
      if (v is! bool) bad();
    case TimestampField():
      if (v is! Timestamp && v is! DateTime) bad();
    case EnumField():
      if (v is! String || !def.values.contains(v)) bad();
    case GeoPointField():
      if (v is! GeoPoint) bad();
    case BytesField():
      if (v is! Uint8List) bad();
    case RefField():
      final p = v is HasDocPath ? v.path : (v is DocPath ? v.path : null);
      if (p == null || !_refMatches(def.to, p)) bad();
    case ArrayField():
      if (v is! List) return bad();
      if (ctx.bounds && def.max != null && v.length > def.max!) bad();
      for (var i = 0; i < v.length; i++) {
        _check(def.of, v[i], '$path[$i]', ctx, false);
      }
    case MapField():
      if (v is! Map) return bad();
      _checkFields(def.fields, v.cast<String, Object?>(), path, ctx, partial);
  }
}

void _checkFields(Map<String, FieldDef> fields, Map<String, Object?> data, String prefix, _Ctx ctx, bool partial) {
  for (final e in data.entries) {
    final path = prefix.isEmpty ? e.key : '$prefix.${e.key}';
    final def = fields[e.key];
    if (def == null) {
      ctx.issues.add(Issue(path, 'no such field (fields: ${fields.keys.join(', ')})', _describe(e.value)));
      continue;
    }
    final v = e.value;
    if (v is FieldValue && v.op == 'delete') {
      if (!ctx.write || !(ctx.kind == 'update' || ctx.kind == 'merge')) {
        ctx.issues.add(Issue(path, def.expected, 'delete() (only with update or set merge)'));
      } else if (!def.optional) {
        ctx.issues.add(Issue(path, '${def.expected} (required: delete() would remove it)', 'delete()'));
      }
      continue;
    }
    if (v == null) {
      if (!def.optional) ctx.issues.add(Issue(path, def.expected, 'null'));
      continue;
    }
    _check(def, v, path, ctx, partial);
  }
  if (!partial) {
    for (final e in fields.entries) {
      if (!e.value.optional && data[e.key] == null) ctx.issues.add(Issue(prefix.isEmpty ? e.key : '$prefix.${e.key}', e.value.expected, 'missing'));
    }
  }
}

Never _fail(String where, String what, List<Issue> issues) {
  final lines = issues.take(10).map((i) => '  $i').join('\n');
  throw IceBaseException('invalid-argument', "$what on '$where' does not match the schema:\n$lines", reason: 'schema', details: {'issues': issues});
}

/// set / create (every required field) or merge (only what is given).
void validateWrite(CollectionDef c, Map<String, Object?> data, String kind) {
  final ctx = _Ctx(write: true, bounds: true, kind: kind);
  _checkFields(c.fields, data, '', ctx, kind == 'merge');
  if (ctx.issues.isNotEmpty) _fail(c.path, kind, ctx.issues);
}

/// update: each entry sets the field at its key path.
void validateUpdate(CollectionDef c, List<(List<String>, Object?)> entries) {
  final ctx = _Ctx(write: true, bounds: true, kind: 'update');
  for (final (path, v) in entries) {
    final shown = path.length == 1 && !path[0].contains('.') ? path[0] : showPath(path);
    final def = path.isEmpty ? null : fieldAt(c.fields, path);
    if (def == null) {
      ctx.issues.add(Issue(shown, 'a field in the schema', _describe(v)));
      continue;
    }
    if (v is FieldValue && v.op == 'delete') {
      if (!def.optional) ctx.issues.add(Issue(shown, '${def.expected} (required: delete() would remove it)', 'delete()'));
      continue;
    }
    if (v == null) {
      if (!def.optional) ctx.issues.add(Issue(shown, def.expected, 'null'));
      continue;
    }
    _check(def, v, shown, ctx, false);
  }
  if (ctx.issues.isNotEmpty) _fail(c.path, 'update', ctx.issues);
}

/// A query operand against a field (type only: lengths and ranges don't apply).
void validateQueryValue(CollectionDef c, List<String> path, String op, Object? value) {
  if (path.length == 1 && path[0] == '__name__') return;
  final def = fieldAt(c.fields, path);
  if (def == null) throw IceBaseException('invalid-argument', "where(${showPath(path)}, …) on '${c.path}': not a field (fields: ${c.fields.keys.join(', ')})", reason: 'schema');
  if (value == null && (op == '==' || op == '!=')) return;
  final ctx = _Ctx(write: false, bounds: false, kind: 'query');
  final shown = path.join('.');
  if (op == 'in' || op == 'not-in') {
    if (value is! List) {
      ctx.issues.add(Issue(shown, "a list for '$op'", _describe(value)));
    } else {
      for (var i = 0; i < value.length; i++) {
        _check(def, value[i], '$shown[$i]', ctx, false);
      }
    }
  } else if (op == 'array-contains' || op == 'array-contains-any') {
    if (def is! ArrayField) {
      ctx.issues.add(Issue(shown, "an array field for '$op'", def.expected));
    } else if (op == 'array-contains') {
      _check(def.of, value, shown, ctx, false);
    } else if (value is! List) {
      ctx.issues.add(Issue(shown, "a list for '$op'", _describe(value)));
    } else {
      for (var i = 0; i < value.length; i++) {
        _check(def.of, value[i], '$shown[$i]', ctx, false);
      }
    }
  } else {
    _check(def, value, shown, ctx, false);
  }
  if (ctx.issues.isNotEmpty) _fail(c.path, "where(${showPath(path)}, '$op', …)", ctx.issues);
}

/// Validate one Realtime Database value against its path's field.
void validateValue(FieldDef def, Object? value, String where) {
  final ctx = _Ctx(write: true, bounds: true, kind: 'set');
  _check(def, value, where, ctx, false);
  if (ctx.issues.isNotEmpty) _fail(where, 'write', ctx.issues);
}
