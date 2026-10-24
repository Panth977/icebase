// firebase mode: the Realtime Database over firebase_database.

import 'package:firebase_core/firebase_core.dart' show FirebaseException;
import 'package:firebase_database/firebase_database.dart' as rt;
import 'package:icebase/drivers.dart';
import 'package:icebase/icebase.dart';

Object? _toNative(Object? v) {
  if (v is FieldValue) {
    return switch (v.op) {
      'serverTime' => rt.ServerValue.timestamp,
      'increment' => rt.ServerValue.increment(v.operand! as num),
      _ => throw IceBaseException('invalid-argument', 'FieldValue.${v.op} is not a Realtime Database value'),
    };
  }
  if (v is List) return [for (final x in v) _toNative(x)];
  if (v is Map) return {for (final e in v.entries) '${e.key}': _toNative(e.value)};
  return v;
}

Object? _fromNative(Object? v) {
  if (v is List) return [for (final x in v) _fromNative(x)];
  if (v is Map) return {for (final e in v.entries) '${e.key}': _fromNative(e.value)};
  return v;
}

IceBaseException _err(Object e) {
  if (e is FirebaseException) return IceBaseException(e.code, e.message ?? e.code, details: {'service': 'database'});
  if (e is IceBaseException) return e;
  return IceBaseException('unknown', '$e', details: {'service': 'database'});
}

Future<T> _guard<T>(Future<T> Function() f) async {
  try {
    return await f();
  } catch (e) {
    throw _err(e);
  }
}

RawDbSnapshot _raw(rt.DataSnapshot s) => RawDbSnapshot(s.key, _fromNative(s.value), s.value is Map || s.value is List ? [for (final c in s.children) (c.key!, _fromNative(c.value))] : null);

class FlutterDatabaseDriver implements DatabaseDriver {
  final rt.FirebaseDatabase db;
  FlutterDatabaseDriver(this.db);

  rt.Query _q(String path, DbQuery? q) {
    rt.Query r = db.ref(path);
    if (q == null) return r;
    r = switch (q.orderBy) {
      'child' => r.orderByChild(q.child!),
      'key' => r.orderByKey(),
      'value' => r.orderByValue(),
      _ => r,
    };
    if (q.startAt != null) r = r.startAt(q.startAt!.$1, key: q.startAt!.$2);
    if (q.endAt != null) r = r.endAt(q.endAt!.$1, key: q.endAt!.$2);
    if (q.equalTo != null) r = r.equalTo(q.equalTo!.$1, key: q.equalTo!.$2);
    if (q.limitToFirst != null) r = r.limitToFirst(q.limitToFirst!);
    if (q.limitToLast != null) r = r.limitToLast(q.limitToLast!);
    return r;
  }

  @override
  Future<RawDbSnapshot> get(String path, DbQuery? q) => _guard(() async => _raw(await _q(path, q).get()));

  @override
  Future<void> set(String path, Object? value) => _guard(() => db.ref(path).set(_toNative(value)));

  @override
  Future<void> update(String path, Map<String, Object?> values) => _guard(() => db.ref(path).update((_toNative(values)! as Map).cast<String, Object?>()));

  @override
  Stream<RawDbSnapshot> watch(String path, DbQuery? q) => _q(path, q).onValue.map((e) => _raw(e.snapshot)).handleError((Object e) => throw _err(e));

  @override
  Future<({bool committed, RawDbSnapshot snapshot})> transaction(String path, Object? Function(Object? current) fn) => _guard(() async {
        final r = await db.ref(path).runTransaction((cur) {
          final next = fn(_fromNative(cur));
          return identical(next, DbTransaction.abort) ? rt.Transaction.abort() : rt.Transaction.success(_toNative(next));
        });
        return (committed: r.committed, snapshot: _raw(r.snapshot));
      });

  @override
  DbDisconnect onDisconnect(String path) => _Disconnect(db.ref(path).onDisconnect());
}

class _Disconnect implements DbDisconnect {
  final rt.OnDisconnect _d;
  _Disconnect(this._d);
  @override
  Future<void> set(Object? value) => _guard(() => _d.set(_toNative(value)));
  @override
  Future<void> update(Map<String, Object?> values) => _guard(() => _d.update((_toNative(values)! as Map).cast<String, Object?>()));
  @override
  Future<void> remove() => _guard(_d.remove);
  @override
  Future<void> cancel() => _guard(_d.cancel);
}
