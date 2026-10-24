// firebase mode: Firestore over cloud_firestore. The IceBase layer above has already validated
// the write and checked the query's index; this only translates.

import 'dart:typed_data';

import 'package:cloud_firestore/cloud_firestore.dart' as fs;
import 'package:icebase/drivers.dart';
import 'package:icebase/icebase.dart';

/// IceBase value → cloud_firestore value.
Object? toNative(fs.FirebaseFirestore db, Object? v) {
  if (v is Timestamp) return fs.Timestamp(v.seconds, v.nanoseconds);
  if (v is GeoPoint) return fs.GeoPoint(v.latitude, v.longitude);
  if (v is DocPath) return db.doc(v.path);
  if (v is Uint8List) return fs.Blob(v);
  if (v is FieldValue) {
    return switch (v.op) {
      'serverTimestamp' => fs.FieldValue.serverTimestamp(),
      'increment' => fs.FieldValue.increment(v.operand! as num),
      'arrayUnion' => fs.FieldValue.arrayUnion([for (final x in v.operand! as List) toNative(db, x)]),
      'arrayRemove' => fs.FieldValue.arrayRemove([for (final x in v.operand! as List) toNative(db, x)]),
      'delete' => fs.FieldValue.delete(),
      _ => throw IceBaseException('invalid-argument', 'FieldValue.${v.op} is not a Firestore value'),
    };
  }
  if (v is List) return [for (final x in v) toNative(db, x)];
  if (v is Map) return {for (final e in v.entries) '${e.key}': toNative(db, e.value)};
  return v;
}

/// cloud_firestore value → IceBase value.
Object? fromNative(Object? v) {
  if (v is fs.Timestamp) return Timestamp(v.seconds, v.nanoseconds);
  if (v is fs.GeoPoint) return GeoPoint(v.latitude, v.longitude);
  if (v is fs.DocumentReference) return DocPath(v.path);
  if (v is fs.Blob) return v.bytes;
  if (v is List) return [for (final x in v) fromNative(x)];
  if (v is Map) return {for (final e in v.entries) '${e.key}': fromNative(e.value)};
  return v;
}

Object _path(List<String> p) => isName(p) ? fs.FieldPath.documentId : fs.FieldPath(p);

IceBaseException _err(Object e) {
  if (e is fs.FirebaseException) return IceBaseException(e.code, e.message ?? e.code);
  if (e is IceBaseException) return e;
  return IceBaseException('unknown', '$e');
}

Future<T> _guard<T>(Future<T> Function() f) async {
  try {
    return await f();
  } catch (e) {
    throw _err(e);
  }
}

class FlutterFirestoreDriver implements FirestoreDriver {
  final fs.FirebaseFirestore db;
  FlutterFirestoreDriver(this.db);

  RawDoc _raw(fs.DocumentSnapshot<Map<String, dynamic>> s) => RawDoc(s.reference.path, s.exists ? (fromNative(s.data()) as Map).cast<String, Object?>() : null, native: s);

  fs.Filter _filter(FilterNode n) {
    switch (n) {
      case FieldFilter(:final field, :final op, :final value):
        final f = _path(field);
        final v = toNative(db, value);
        return switch (op) {
          '==' => v == null ? fs.Filter(f, isNull: true) : fs.Filter(f, isEqualTo: v),
          '!=' => v == null ? fs.Filter(f, isNull: false) : fs.Filter(f, isNotEqualTo: v),
          '<' => fs.Filter(f, isLessThan: v),
          '<=' => fs.Filter(f, isLessThanOrEqualTo: v),
          '>' => fs.Filter(f, isGreaterThan: v),
          '>=' => fs.Filter(f, isGreaterThanOrEqualTo: v),
          'array-contains' => fs.Filter(f, arrayContains: v),
          'array-contains-any' => fs.Filter(f, arrayContainsAny: v! as List),
          'in' => fs.Filter(f, whereIn: v! as List),
          'not-in' => fs.Filter(f, whereNotIn: v! as List),
          _ => throw IceBaseException('invalid-argument', "where(…, '$op', …) is not a Firestore operator"),
        };
      case CompositeFilter(:final kind, :final filters):
        final parts = [for (final x in filters) _filter(x)];
        if (parts.length == 1) return parts.first;
        return Function.apply(kind == 'or' ? fs.Filter.or : fs.Filter.and, parts) as fs.Filter;
    }
  }

  List<Object?> _cursor(QuerySpec spec, Cursor c) {
    final snap = c.snapshot;
    if (snap == null) return [for (final v in c.values) toNative(db, v)];
    return [
      for (final o in fullOrder(spec))
        if (isName(o.field))
          spec.path == null ? snap.path : snap.path.substring(snap.path.lastIndexOf('/') + 1)
        else
          toNative(db, o.field.fold<Object?>(snap.data, (cur, k) => cur is Map ? cur[k] : null)),
    ];
  }

  fs.Query<Map<String, dynamic>> _q(QuerySpec s) {
    fs.Query<Map<String, dynamic>> q = s.path == null ? db.collectionGroup(s.collectionId) : db.collection(s.path!);
    if (s.filters.isNotEmpty) q = q.where(_filter(s.filters.length == 1 ? s.filters.first : CompositeFilter('and', s.filters)));
    for (final o in s.orders) {
      q = q.orderBy(_path(o.field), descending: o.descending);
    }
    if (s.start != null) q = s.start!.inclusive ? q.startAt(_cursor(s, s.start!)) : q.startAfter(_cursor(s, s.start!));
    if (s.end != null) q = s.end!.inclusive ? q.endAt(_cursor(s, s.end!)) : q.endBefore(_cursor(s, s.end!));
    if (s.limit != null) q = s.limit!.last ? q.limitToLast(s.limit!.n) : q.limit(s.limit!.n);
    return q;
  }

  @override
  Future<RawDoc> get(String path) => _guard(() async => _raw(await db.doc(path).get()));

  @override
  Future<List<RawDoc>> query(QuerySpec spec) => _guard(() async => [for (final d in (await _q(spec).get()).docs) _raw(d)]);

  String _dotted(List<String> p) {
    if (p.any((k) => k.contains('.'))) throw IceBaseException('unimplemented', "sum/average over a key with a '.' is not supported by cloud_firestore (${p.join(' › ')})");
    return p.join('.');
  }

  @override
  Future<Map<String, num?>> aggregate(QuerySpec spec, Map<String, AggregateField> aggs) => _guard(() async {
        final entries = aggs.entries.toList();
        final fields = [
          for (final e in entries)
            switch (e.value.op) {
              'count' => fs.count(),
              'sum' => fs.sum(_dotted(e.value.field!)),
              _ => fs.average(_dotted(e.value.field!)),
            },
        ];
        if (fields.isEmpty) return <String, num?>{};
        final s = await (Function.apply(_q(spec).aggregate, fields) as fs.AggregateQuery).get();
        return {
          for (final e in entries)
            e.key: switch (e.value.op) {
              'count' => s.count,
              'sum' => s.getSum(_dotted(e.value.field!)),
              _ => s.getAverage(_dotted(e.value.field!)),
            },
        };
      });

  Map<Object, Object?> _update(List<(List<String>, Object?)> fields) => {for (final (p, v) in fields) _path(p): toNative(db, v)};

  @override
  Future<void> commit(List<Write> writes) => _guard(() async {
        final b = db.batch();
        for (final w in writes) {
          final ref = db.doc(w.path);
          switch (w) {
            case SetWrite():
              b.set(ref, toNative(db, w.data)! as Map<String, Object?>, fs.SetOptions(merge: w.merge));
            case CreateWrite():
              throw IceBaseException('unimplemented', 'create() is not available on cloud_firestore');
            case UpdateWrite():
              b.update(ref, _update(w.fields));
            case DeleteWrite():
              b.delete(ref);
          }
        }
        await b.commit();
      });

  @override
  Stream<RawDoc> watchDoc(String path) => db.doc(path).snapshots().map(_raw).handleError((Object e) => throw _err(e));

  @override
  Stream<({List<RawDoc> docs, List<RawChange> changes})> watchQuery(QuerySpec spec) => _q(spec).snapshots().map((s) {
        return (
          docs: [for (final d in s.docs) _raw(d)],
          changes: [
            for (final c in s.docChanges)
              RawChange(switch (c.type) { fs.DocumentChangeType.added => 'added', fs.DocumentChangeType.modified => 'modified', fs.DocumentChangeType.removed => 'removed' }, _raw(c.doc), c.oldIndex,
                  c.newIndex),
          ],
        );
      }).handleError((Object e) => throw _err(e));

  @override
  Future<R> transaction<R>(Future<R> Function(TxDriver tx) fn, {int maxAttempts = 5}) => _guard(() => db.runTransaction((t) => fn(_Tx(this, t)), maxAttempts: maxAttempts));
}

class _Tx implements TxDriver {
  final FlutterFirestoreDriver _d;
  final fs.Transaction _t;
  _Tx(this._d, this._t);

  @override
  Future<RawDoc> get(String path) async => _d._raw(await _t.get(_d.db.doc(path)));

  @override
  void write(Write w) {
    final ref = _d.db.doc(w.path);
    switch (w) {
      case SetWrite():
        _t.set(ref, toNative(_d.db, w.data)! as Map<String, Object?>, fs.SetOptions(merge: w.merge));
      case CreateWrite():
        throw IceBaseException('unimplemented', 'create() is not available on cloud_firestore');
      case UpdateWrite():
        _t.update(ref, _d._update(w.fields));
      case DeleteWrite():
        _t.delete(ref);
    }
  }
}
