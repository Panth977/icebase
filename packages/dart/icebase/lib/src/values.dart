// Value types shared by every service and every mode — the same ones Firebase has.

import 'dart:typed_data';

import 'errors.dart';

/// A point in time with nanosecond precision, like Firebase's Timestamp.
class Timestamp implements Comparable<Timestamp> {
  final int seconds;
  final int nanoseconds;

  Timestamp(this.seconds, this.nanoseconds) {
    if (nanoseconds < 0 || nanoseconds >= 1000000000) {
      throw IceBaseException('invalid-argument', 'Timestamp($seconds, $nanoseconds): nanoseconds must be in [0, 1e9)');
    }
  }

  factory Timestamp.now() => Timestamp.fromDate(DateTime.now());
  factory Timestamp.fromDate(DateTime d) => Timestamp.fromMicrosecondsSinceEpoch(d.microsecondsSinceEpoch);
  factory Timestamp.fromMillisecondsSinceEpoch(int ms) => Timestamp.fromMicrosecondsSinceEpoch(ms * 1000);
  factory Timestamp.fromMicrosecondsSinceEpoch(int us) {
    final s = (us / 1000000).floor();
    return Timestamp(s, (us - s * 1000000) * 1000);
  }

  DateTime toDate() => DateTime.fromMicrosecondsSinceEpoch(seconds * 1000000 + nanoseconds ~/ 1000);
  int get millisecondsSinceEpoch => seconds * 1000 + nanoseconds ~/ 1000000;

  @override
  int compareTo(Timestamp other) => seconds != other.seconds ? seconds.compareTo(other.seconds) : nanoseconds.compareTo(other.nanoseconds);
  @override
  bool operator ==(Object other) => other is Timestamp && other.seconds == seconds && other.nanoseconds == nanoseconds;
  @override
  int get hashCode => Object.hash(seconds, nanoseconds);
  @override
  String toString() => 'Timestamp(seconds=$seconds, nanoseconds=$nanoseconds)';
}

/// A latitude/longitude pair, like Firebase's GeoPoint.
class GeoPoint {
  final double latitude;
  final double longitude;
  GeoPoint(this.latitude, this.longitude) {
    if (latitude < -90 || latitude > 90) throw IceBaseException('invalid-argument', 'GeoPoint latitude $latitude is outside [-90, 90]');
    if (longitude < -180 || longitude > 180) throw IceBaseException('invalid-argument', 'GeoPoint longitude $longitude is outside [-180, 180]');
  }
  @override
  bool operator ==(Object other) => other is GeoPoint && other.latitude == latitude && other.longitude == longitude;
  @override
  int get hashCode => Object.hash(latitude, longitude);
  @override
  String toString() => 'GeoPoint($latitude, $longitude)';
}

/// Write-time sentinels, like Firebase's FieldValue (and the Realtime Database's ServerValue).
class FieldValue {
  /// serverTimestamp | serverTime | increment | arrayUnion | arrayRemove | delete
  final String op;
  final Object? operand;
  const FieldValue._(this.op, [this.operand]);

  /// Firestore: the commit time (a Timestamp field).
  static FieldValue serverTimestamp() => const FieldValue._('serverTimestamp');
  static FieldValue increment(num n) => FieldValue._('increment', n);
  static FieldValue arrayUnion(List<Object?> elements) => FieldValue._('arrayUnion', elements);
  static FieldValue arrayRemove(List<Object?> elements) => FieldValue._('arrayRemove', elements);
  static FieldValue delete() => const FieldValue._('delete');

  @override
  String toString() => 'FieldValue.$op(${operand ?? ''})';
}

/// The Realtime Database's write-time values.
abstract final class ServerValue {
  /// Milliseconds since the epoch, filled in by the server (a number field).
  static const FieldValue timestamp = FieldValue._('serverTime');
  static FieldValue increment(num n) => FieldValue._('increment', n);
}

/// The path of a document, as stored in a reference field.
class DocPath {
  final String path;
  const DocPath(this.path);
  String get id => path.substring(path.lastIndexOf('/') + 1);
  @override
  bool operator ==(Object other) => other is DocPath && other.path == path;
  @override
  int get hashCode => path.hashCode;
  @override
  String toString() => 'DocPath($path)';
}

/// Generated enums implement this: the stored string.
abstract interface class IceEnum {
  String get value;
}

/// Generated model classes (documents and map fields) implement this.
abstract interface class IceModel {
  Map<String, Object?> toMap();
}

/// Generated enums and models as stored values (lists and maps through).
Object? storedValue(Object? v) {
  if (v is IceEnum) return v.value;
  if (v is IceModel) return storedValue(v.toMap());
  if (v is DateTime) return Timestamp.fromDate(v);
  if (v is Uint8List) return v;
  if (v is List) return [for (final x in v) storedValue(x)];
  if (v is Map) return {for (final e in v.entries) e.key: storedValue(e.value)};
  return v;
}
