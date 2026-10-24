// The Realtime Database with firebase_database's names, over the dbPath() declarations of the
// schema. Writes are validated against the declared value; orderByChild() needs the child in the
// path's indexOn (IDX-6). A reference is either one item (DatabaseReference) or the list of them
// (ListReference, when the path ends in a {param} and that parameter is left out).

import 'dart:async';
import 'dart:math';

import 'app.dart';
import 'emulator/database.dart';
import 'errors.dart';
import 'schema.dart';
import 'values.dart';

// ─── the driver contract ────────────────────────────────────────────────────────

class DbQuery {
  /// child | key | value
  final String? orderBy;
  final String? child;
  final (Object?, String?)? startAt;
  final (Object?, String?)? endAt;
  final (Object?, String?)? equalTo;
  final int? limitToFirst;
  final int? limitToLast;
  const DbQuery({this.orderBy, this.child, this.startAt, this.endAt, this.equalTo, this.limitToFirst, this.limitToLast});

  DbQuery copyWith({String? orderBy, String? child, (Object?, String?)? startAt, (Object?, String?)? endAt, (Object?, String?)? equalTo, int? limitToFirst, int? limitToLast}) => DbQuery(
        orderBy: orderBy ?? this.orderBy,
        child: child ?? this.child,
        startAt: startAt ?? this.startAt,
        endAt: endAt ?? this.endAt,
        equalTo: equalTo ?? this.equalTo,
        limitToFirst: limitToFirst ?? this.limitToFirst,
        limitToLast: limitToLast ?? this.limitToLast,
      );

  Map<String, Object?> toJson() {
    Map<String, Object?> b((Object?, String?) x) => {'value': x.$1, if (x.$2 != null) 'key': x.$2};
    return {
      if (orderBy != null) 'orderBy': orderBy == 'child' ? {'kind': 'child', 'child': child} : {'kind': orderBy},
      if (startAt != null) 'startAt': b(startAt!),
      if (endAt != null) 'endAt': b(endAt!),
      if (equalTo != null) 'equalTo': b(equalTo!),
      if (limitToFirst != null) 'limitToFirst': limitToFirst,
      if (limitToLast != null) 'limitToLast': limitToLast,
    };
  }
}

/// A snapshot as the driver returns it: the stored value and, for a list, its children in order.
class RawDbSnapshot {
  final String? key;
  final Object? value;
  final List<(String, Object?)>? children;
  const RawDbSnapshot(this.key, this.value, this.children);
}

abstract interface class DbDisconnect {
  Future<void> set(Object? value);
  Future<void> update(Map<String, Object?> values);
  Future<void> remove();
  Future<void> cancel();
}

abstract interface class DatabaseDriver {
  Future<RawDbSnapshot> get(String path, DbQuery? q);
  Future<void> set(String path, Object? value);
  Future<void> update(String path, Map<String, Object?> values);

  /// Every change of the location / query, as a full ordered snapshot.
  Stream<RawDbSnapshot> watch(String path, DbQuery? q);
  Future<({bool committed, RawDbSnapshot snapshot})> transaction(String path, Object? Function(Object? current) fn);
  DbDisconnect onDisconnect(String path);
}

// ─── typed paths ────────────────────────────────────────────────────────────────

/// A dbPath() with its Dart type (written by `icebase gen dart`).
class DbPathType<T> {
  final DbPathDef def;
  final T Function(Object? stored) fromValue;
  final Object? Function(T value) toValue;
  const DbPathType(this.def, {required this.fromValue, required this.toValue});

  /// An untyped path (the stored JSON as is).
  static DbPathType<Object?> raw(DbPathDef def) => DbPathType<Object?>(def, fromValue: (v) => v, toValue: (v) => v);
}

final _key = RegExp(r'^[^.#$\[\]/]+$');
String _checkKey(String k, String where) {
  if (!_key.hasMatch(k)) throw IceBaseException('invalid-argument', "$where: '$k' is not a valid key (no '.', '#', '\$', '[', ']' or '/')", details: {'service': 'database'});
  return k;
}

FieldDef? _childDef(FieldDef def, List<String> segs) {
  FieldDef? d = def;
  for (final s in segs) {
    d = d is MapField ? d.fields[s] : null;
    if (d == null) return null;
  }
  return d;
}

/// firebase_database's FirebaseDatabase.
class IceBaseDatabase {
  final IceBaseApp app;
  final DatabaseDriver driver;
  IceBaseDatabase._(this.app, this.driver);

  static IceBaseDatabase instanceFor(IceBaseApp app) => app.single('database:api', () => IceBaseDatabase._(app, app.driver<DatabaseDriver>('database', () => EmulatorDatabaseDriver(app))));
  static IceBaseDatabase get instance => instanceFor(IceBaseApp.instance());

  DbPathDef _declared(DbPathDef d) {
    if (!app.config.schema.paths.contains(d)) {
      throw IceBaseException('invalid-argument', "dbPath('${d.path}') is not in this app's schema", reason: 'unknown-collection', details: {'service': 'database'});
    }
    return d;
  }

  List<String> _fill(DbPathDef d, List<String> params, int segs) {
    var i = 0;
    return [for (final s in d.path.split('/').take(segs)) s.startsWith('{') ? _checkKey(params[i++], "ref('${d.path}')") : s];
  }

  int _paramCount(DbPathDef d) => d.path.split('/').where((s) => s.startsWith('{')).length;

  /// One item: ref(Messages.type, [roomId, msgId]).
  DatabaseReference<T> ref<T>(DbPathType<T> p, [List<String> params = const []]) {
    final d = _declared(p.def);
    final n = _paramCount(d);
    if (params.length != n) throw IceBaseException('invalid-argument', "ref('${d.path}'): needs $n path parameter(s), got ${params.length}", reason: 'schema', details: {'service': 'database'});
    return DatabaseReference._(this, p, _fill(d, params, 1 << 30).join('/'));
  }

  /// The list of items: list(Messages.type, [roomId]) — the last parameter left out.
  ListReference<T> list<T>(DbPathType<T> p, [List<String> params = const []]) {
    final d = _declared(p.def);
    final n = _paramCount(d);
    if (!d.path.endsWith('}') || params.length != n - 1) {
      throw IceBaseException('invalid-argument', "list('${d.path}'): needs ${n - 1} path parameter(s) and a path ending in a {param}", reason: 'schema', details: {'service': 'database'});
    }
    final segs = d.path.split('/');
    return ListReference._(this, p, _fill(d, params, segs.length - 1).join('/'), const DbQuery());
  }
}

class _Base {
  final IceBaseDatabase _db;
  final String path;
  _Base(this._db, this.path);
  String? get key => path.isEmpty ? null : path.substring(path.lastIndexOf('/') + 1);
  @override
  String toString() => '/$path';
}

/// One declared item (or a field inside it via [child]).
class DatabaseReference<T> extends _Base {
  final DbPathType<T> _type;
  DatabaseReference._(super._db, this._type, super.path);

  Object? _validated(Object? value, String op) {
    if (value == null) {
      final listItem = _type.def.path.endsWith('}');
      if (!_type.def.value.optional && !listItem) throw IceBaseException('invalid-argument', '$op($this, null) would remove a required value', reason: 'schema', details: {'service': 'database'});
      return null;
    }
    validateValue(_type.def.value, value, toString());
    return value;
  }

  Future<DataSnapshot<T>> get() async => DataSnapshot._(this, await _db.driver.get(path, null));

  /// Every change of the value (firebase_database's onValue).
  Stream<DataSnapshot<T>> get onValue => _db.driver.watch(path, null).map((s) => DataSnapshot._(this, s));

  Future<void> set(T? value) => _db.driver.set(path, _validated(value == null ? null : storedValue(_type.toValue(value)), 'set'));

  /// update({'text': 'hi', 'meta/at': ServerValue.timestamp}) — each key replaces that child.
  Future<void> update(Map<String, Object?> values) {
    final out = <String, Object?>{};
    for (final e in values.entries) {
      final segs = e.key.split('/');
      for (final s in segs) {
        _checkKey(s, 'update($this)');
      }
      final def = _childDef(_type.def.value, segs);
      if (def == null) throw IceBaseException('invalid-argument', "update($this): '${e.key}' is not in the declared value", reason: 'schema', details: {'service': 'database'});
      final v = storedValue(e.value);
      if (v == null) {
        if (!def.optional) throw IceBaseException('invalid-argument', "update($this): '${e.key}' is required and cannot be removed", reason: 'schema', details: {'service': 'database'});
      } else {
        validateValue(def, v, '$this/${e.key}');
      }
      out[e.key] = v;
    }
    return _db.driver.update(path, out);
  }

  Future<void> remove() => set(null);

  /// runTransaction(cur => next) — return [DbTransaction.abort] to leave it.
  Future<TransactionResult<T>> runTransaction(Object? Function(T? current) fn) async {
    final r = await _db.driver.transaction(path, (cur) {
      final next = fn(cur == null ? null : _type.fromValue(cur));
      if (identical(next, DbTransaction.abort)) return DbTransaction.abort;
      return _validated(next == null ? null : storedValue(next is T ? _type.toValue(next as T) : next), 'runTransaction');
    });
    return TransactionResult._(r.committed, DataSnapshot._(this, r.snapshot));
  }

  OnDisconnect<T> onDisconnect() => OnDisconnect._(this);
}

/// Return [abort] from a transaction handler to leave the value as it is.
abstract final class DbTransaction {
  static const Object abort = _Abort();
}

class _Abort {
  const _Abort();
}

class TransactionResult<T> {
  final bool committed;
  final DataSnapshot<T> snapshot;
  const TransactionResult._(this.committed, this.snapshot);
}

class OnDisconnect<T> {
  final DatabaseReference<T> _r;
  OnDisconnect._(this._r);
  DbDisconnect get _d => _r._db.driver.onDisconnect(_r.path);
  Future<void> set(T? value) => _d.set(_r._validated(value == null ? null : storedValue(_r._type.toValue(value)), 'onDisconnect().set'));
  Future<void> remove() => _d.remove();
  Future<void> cancel() => _d.cancel();
  Future<void> update(Map<String, Object?> values) {
    for (final e in values.entries) {
      final def = _childDef(_r._type.def.value, e.key.split('/'));
      if (def == null) throw IceBaseException('invalid-argument', "onDisconnect().update($_r): '${e.key}' is not in the declared value", reason: 'schema');
      if (e.value != null) validateValue(def, storedValue(e.value), '$_r/${e.key}');
    }
    return _d.update({for (final e in values.entries) e.key: storedValue(e.value)});
  }
}

class DataSnapshot<T> {
  final DatabaseReference<T> ref;
  final RawDbSnapshot _raw;
  DataSnapshot._(this.ref, this._raw);
  String? get key => ref.key;
  bool get exists => _raw.value != null;

  /// The value as its Dart type (null when absent).
  T? get value => _raw.value == null ? null : ref._type.fromValue(_raw.value);

  /// The stored JSON.
  Object? get rawValue => _raw.value;
}

/// A list of items: query it, push onto it, listen to its children.
class ListReference<T> extends _Base {
  final DbPathType<T> _type;
  final DbQuery _q;
  ListReference._(super._db, this._type, super.path, this._q);

  DatabaseReference<T> child(String key) => DatabaseReference._(_db, _type, '$path/${_checkKey(key, 'child($this)')}');

  /// A new chronological key; with a value, also writes it.
  Future<DatabaseReference<T>> push([T? value]) async {
    final r = child(pushId());
    if (value != null) await r.set(value);
    return r;
  }

  ListReference<T> _with(DbQuery q) => ListReference._(_db, _type, path, q);
  void _once(String name) {
    if (_q.orderBy != null) throw IceBaseException('invalid-argument', '$name: a query has one orderBy…() only', details: {'service': 'database'});
  }

  /// orderByChild('at') · orderByChild('meta/at') — the child must be in the path's indexOn.
  ListReference<T> orderByChild(String child) {
    _once("orderByChild('$child')");
    if (!_type.def.indexOn.contains(child)) {
      throw IceBaseException(
          'failed-precondition', "orderByChild('$child') on '${_type.def.path}' needs '$child' in its indexOn.\nAdd it to dbPath('${_type.def.path}', …, { indexOn }) in your schema.",
          reason: 'missing-index', details: {'service': 'database', 'path': _type.def.path, 'index': child});
    }
    return _with(_q.copyWith(orderBy: 'child', child: child));
  }

  ListReference<T> orderByKey() {
    _once('orderByKey()');
    return _with(_q.copyWith(orderBy: 'key'));
  }

  ListReference<T> orderByValue() {
    _once('orderByValue()');
    return _with(_q.copyWith(orderBy: 'value'));
  }

  ListReference<T> startAt(Object? value, {String? key}) => _with(_q.copyWith(startAt: (value, key)));
  ListReference<T> endAt(Object? value, {String? key}) => _with(_q.copyWith(endAt: (value, key)));
  ListReference<T> equalTo(Object? value, {String? key}) => _with(_q.copyWith(equalTo: (value, key)));
  ListReference<T> limitToFirst(int n) => _with(_q.copyWith(limitToFirst: n));
  ListReference<T> limitToLast(int n) => _with(_q.copyWith(limitToLast: n));

  DbQuery? get _query => _q.orderBy == null && _q.limitToFirst == null && _q.limitToLast == null && _q.startAt == null && _q.endAt == null && _q.equalTo == null ? null : _q;

  ListSnapshot<T> _snap(RawDbSnapshot s) => ListSnapshot._([for (final (k, v) in s.children ?? const <(String, Object?)>[]) DataSnapshot._(child(k), RawDbSnapshot(k, v, null))]);

  Future<ListSnapshot<T>> get() async => _snap(await _db.driver.get(path, _query));

  Stream<ListSnapshot<T>> get onValue => _db.driver.watch(path, _query).map(_snap);

  /// Child events derived from ordered snapshots, as the SDK does.
  Stream<DatabaseEvent<T>> _events(String type) {
    List<(String, String)>? prev;
    var prevValues = <String, Object?>{};
    return _db.driver.watch(path, _query).expand((s) {
      final now = [for (final (k, v) in s.children ?? const <(String, Object?)>[]) (k, _json(v))];
      final before = prev ?? const [];
      final old = {for (final (k, v) in before) k: v};
      final cur = {for (final (k, v) in now) k: v};
      final values = {for (final (k, v) in s.children ?? const <(String, Object?)>[]) k: v};
      final out = <DatabaseEvent<T>>[];
      DataSnapshot<T> snap(String k, Object? v) => DataSnapshot._(child(k), RawDbSnapshot(k, v, null));
      if (type == 'removed') {
        for (final (k, _) in before) {
          if (!cur.containsKey(k)) out.add(DatabaseEvent._(type, snap(k, prevValues[k]), null));
        }
      }
      for (var i = 0; i < now.length; i++) {
        final (k, v) = now[i];
        final prevKey = i > 0 ? now[i - 1].$1 : null;
        if (type == 'added' && !old.containsKey(k)) out.add(DatabaseEvent._(type, snap(k, values[k]), prevKey));
        if (type == 'changed' && old.containsKey(k) && old[k] != v) out.add(DatabaseEvent._(type, snap(k, values[k]), prevKey));
      }
      prev = now;
      prevValues = values;
      return out;
    });
  }

  Stream<DatabaseEvent<T>> get onChildAdded => _events('added');
  Stream<DatabaseEvent<T>> get onChildChanged => _events('changed');
  Stream<DatabaseEvent<T>> get onChildRemoved => _events('removed');
}

String _json(Object? v) => v is Map
    ? '{${(v.keys.toList()..sort((a, b) => '$a'.compareTo('$b'))).map((k) => '$k:${_json(v[k])}').join(',')}}'
    : v is List
        ? '[${v.map(_json).join(',')}]'
        : '$v';

class ListSnapshot<T> {
  /// The items in query order.
  final List<DataSnapshot<T>> children;
  const ListSnapshot._(this.children);
  bool get exists => children.isNotEmpty;
  int get size => children.length;
}

class DatabaseEvent<T> {
  /// added | changed | removed
  final String type;
  final DataSnapshot<T> snapshot;
  final String? previousChildKey;
  const DatabaseEvent._(this.type, this.snapshot, this.previousChildKey);
}

// Firebase's push ids: 8 chars of time + 12 random, sortable by creation.
const _push = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
var _lastTime = 0;
final _lastRand = List<int>.filled(12, 0);
final _rnd = Random.secure();

String pushId([int? at]) {
  final now = at ?? DateTime.now().millisecondsSinceEpoch;
  final dup = now == _lastTime;
  _lastTime = now;
  final time = List<String>.filled(8, '');
  var t = now;
  for (var i = 7; i >= 0; i--) {
    time[i] = _push[t % 64];
    t ~/= 64;
  }
  if (!dup) {
    for (var i = 0; i < 12; i++) {
      _lastRand[i] = _rnd.nextInt(64);
    }
  } else {
    var i = 11;
    for (; i >= 0 && _lastRand[i] == 63; i--) {
      _lastRand[i] = 0;
    }
    if (i >= 0) _lastRand[i]++;
  }
  return time.join() + _lastRand.map((r) => _push[r]).join();
}
