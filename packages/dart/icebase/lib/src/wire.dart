// How values travel to the IceBase server: JSON with tagged objects for the types JSON lacks
// (the same format as the TypeScript SDK).

import 'dart:convert';
import 'dart:typed_data';

import 'values.dart';

String tsKey(int s, int n) => '${(s + 62135596800).toString().padLeft(12, '0')}.${n.toString().padLeft(9, '0')}';

/// Dart value → wire JSON. Document references are written as their [DocPath].
Object? encode(Object? v) {
  if (v == null || v is String || v is bool || v is num) return v;
  if (v is IceEnum) return v.value;
  if (v is IceModel) return encode(v.toMap());
  if (v is DateTime) v = Timestamp.fromDate(v);
  if (v is Timestamp) return {'__ib': 'ts', 's': v.seconds, 'n': v.nanoseconds, 'k': tsKey(v.seconds, v.nanoseconds)};
  if (v is GeoPoint) return {'__ib': 'geo', 'lat': v.latitude, 'lng': v.longitude};
  if (v is DocPath) return {'__ib': 'ref', 'p': v.path};
  if (v is Uint8List) return {'__ib': 'bytes', 'b': base64Encode(v)};
  if (v is FieldValue) return {'__ib': 'fv', 'op': v.op, if (v.operand != null) 'v': encode(v.operand)};
  if (v is HasDocPath) return {'__ib': 'ref', 'p': v.path};
  if (v is Iterable) return [for (final x in v) encode(x)];
  if (v is Map) return {for (final e in v.entries) e.key.toString(): encode(e.value)};
  throw ArgumentError('IceBase cannot store a ${v.runtimeType}');
}

/// Wire JSON → Dart value.
Object? decode(Object? v) {
  if (v is List) return [for (final x in v) decode(x)];
  if (v is Map) {
    switch (v['__ib']) {
      case 'ts':
        return Timestamp((v['s'] as num).toInt(), (v['n'] as num).toInt());
      case 'geo':
        return GeoPoint((v['lat'] as num).toDouble(), (v['lng'] as num).toDouble());
      case 'ref':
        return DocPath(v['p'] as String);
      case 'bytes':
        return base64Decode(v['b'] as String);
      case 'fv':
        return v; // never read back
    }
    return {for (final e in v.entries) e.key as String: decode(e.value)};
  }
  return v;
}

/// Anything that names a document (a reference) and can be stored in a ref field.
abstract interface class HasDocPath {
  String get path;
}
