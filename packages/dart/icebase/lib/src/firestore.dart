// Firestore with cloud_firestore's names (collection, doc, where, orderBy, get, snapshots,
// set, update, runTransaction, batch), typed from the generated schema. Every write is
// validated; a query whose index is not declared is refused before it leaves.

import 'dart:async';
import 'dart:math';

import 'app.dart';
import 'emulator/firestore.dart';
import 'errors.dart';
import 'plan.dart';
import 'schema.dart';
import 'values.dart';
import 'wire.dart';

// ─── what generated code provides ──────────────────────────────────────────────

/// A collection and how its documents convert (generated: `Products.type`).
class CollectionType<T> {
  final CollectionDef def;
  final T Function(Map<String, Object?> data) fromMap;
  final Map<String, Object?> Function(T value) toMap;
  const CollectionType(this.def, {required this.fromMap, required this.toMap});
}

/// A field of documents of type T holding V (generated: `Products.category`).
/// Its path is a key array; a key with a dot is one key.
class Field<T, V> {
  final List<String> path;
  const Field(this.path);

  /// The document id, for where()/orderBy().
  static Field<T, String> documentId<T>() => Field<T, String>(const ['__name__']);
  @override
  String toString() => showPath(path);
}

/// Firebase's FieldPath, for untyped access: FieldPath(['address', 'city']).
class FieldPath {
  final List<String> segments;
  const FieldPath(this.segments);
  static const documentId = FieldPath(['__name__']);
}

class SetOptions {
  final bool merge;
  const SetOptions({this.merge = false});
}

// ─── the driver contract ───────────────────────────────────────────────────────

/// A document as a driver returns it: data decoded (references as [DocPath]), null if absent.
class RawDoc {
  final String path;
  final Map<String, Object?>? data;
  final int version;
  final Object? native;
  const RawDoc(this.path, this.data, {this.version = 0, this.native});
  String get id => path.substring(path.lastIndexOf('/') + 1);
}

class RawChange {
  /// added | modified | removed
  final String type;
  final RawDoc doc;
  final int oldIndex;
  final int newIndex;
  const RawChange(this.type, this.doc, this.oldIndex, this.newIndex);
}

sealed class Write {
  final String path;
  const Write(this.path);
}

class SetWrite extends Write {
  final Map<String, Object?> data;
  final bool merge;
  const SetWrite(super.path, this.data, {this.merge = false});
}

class CreateWrite extends Write {
  final Map<String, Object?> data;
  const CreateWrite(super.path, this.data);
}

class UpdateWrite extends Write {
  final List<(List<String>, Object?)> fields;
  const UpdateWrite(super.path, this.fields);
}

class DeleteWrite extends Write {
  const DeleteWrite(super.path);
}

abstract interface class TxDriver {
  Future<RawDoc> get(String path);
  void write(Write w);
}

abstract interface class FirestoreDriver {
  Future<RawDoc> get(String path);
  Future<List<RawDoc>> query(QuerySpec spec);
  Future<Map<String, num?>> aggregate(QuerySpec spec, Map<String, AggregateField> aggs);
  Future<void> commit(List<Write> writes);
  Stream<RawDoc> watchDoc(String path);
  Stream<({List<RawDoc> docs, List<RawChange> changes})> watchQuery(QuerySpec spec);
  Future<R> transaction<R>(Future<R> Function(TxDriver tx) fn, {int maxAttempts});
}

// ─── the database ──────────────────────────────────────────────────────────────

class IceBaseFirestore {
  final IceBaseApp app;
  final FirestoreDriver _driver;
  IceBaseFirestore._(this.app, this._driver);

  /// The Firestore of an app (like FirebaseFirestore.instanceFor).
  static IceBaseFirestore instanceFor(IceBaseApp app) => app.single('firestore:api', () => IceBaseFirestore._(app, app.driver<FirestoreDriver>('firestore', () => EmulatorFirestoreDriver(app))));
  static IceBaseFirestore get instance => instanceFor(IceBaseApp.instance());

  /// @nodoc
  FirestoreDriver get driver => _driver;

  /// collection(Products.type) · collection(Orders.type, [uid]) — path params are required.
  CollectionReference<T> collection<T>(CollectionType<T> type, [List<String> params = const []]) {
    if (!app.config.schema.collections.contains(type.def)) throw IceBaseException('invalid-argument', "collection('${type.def.path}') is not in this app's schema", reason: 'unknown-collection');
    return CollectionReference._(this, type, type.def.fill(params));
  }

  /// Every collection with this id; needs `group: true` on it in the schema.
  Query<T> collectionGroup<T>(CollectionType<T> type) => Query._(this, type, QuerySpec(path: null, collectionId: type.def.id));

  WriteBatch batch() => WriteBatch._(this);

  Future<R> runTransaction<R>(Future<R> Function(Transaction tx) fn, {int maxAttempts = 5}) => _driver.transaction((tx) => fn(Transaction._(this, tx)), maxAttempts: maxAttempts);
}

// ─── references and queries ────────────────────────────────────────────────────

class Query<T> {
  final IceBaseFirestore firestore;
  final CollectionType<T> type;
  final QuerySpec spec;
  Query._(this.firestore, this.type, this.spec);

  Query<T> _with(QuerySpec s) => Query._(firestore, type, s);

  /// where(Products.category, isEqualTo: 'shoes') — the value must match the field's type.
  Query<T> where<V>(
    Field<T, V> field, {
    V? isEqualTo,
    V? isNotEqualTo,
    V? isLessThan,
    V? isLessThanOrEqualTo,
    V? isGreaterThan,
    V? isGreaterThanOrEqualTo,
    Object? arrayContains,
    Iterable<Object?>? arrayContainsAny,
    Iterable<V>? whereIn,
    Iterable<V>? whereNotIn,
    bool? isNull,
  }) {
    final f = <FieldFilter>[];
    void add(String op, Object? v0) {
      final v = storedValue(v0);
      final value = isName(field.path) && v is String ? DocPath('${spec.path}/$v') : v;
      validateQueryValue(type.def, field.path, op, v);
      f.add(FieldFilter(field.path, op, value is List ? value.map((x) => isName(field.path) && x is String ? DocPath('${spec.path}/$x') : x).toList() : value));
    }

    if (isEqualTo != null) add('==', isEqualTo);
    if (isNotEqualTo != null) add('!=', isNotEqualTo);
    if (isLessThan != null) add('<', isLessThan);
    if (isLessThanOrEqualTo != null) add('<=', isLessThanOrEqualTo);
    if (isGreaterThan != null) add('>', isGreaterThan);
    if (isGreaterThanOrEqualTo != null) add('>=', isGreaterThanOrEqualTo);
    if (arrayContains != null) add('array-contains', arrayContains);
    if (arrayContainsAny != null) add('array-contains-any', arrayContainsAny.toList());
    if (whereIn != null) add('in', whereIn.toList());
    if (whereNotIn != null) add('not-in', whereNotIn.toList());
    if (isNull != null) add(isNull ? '==' : '!=', null);
    if (f.isEmpty) throw IceBaseException('invalid-argument', 'where(${showPath(field.path)}): give a condition (isEqualTo: …)');
    return _with(spec.copyWith(filters: [...spec.filters, ...f]));
  }

  /// whereAny([…]) / where(Filter.or(…)) — or() over field filters built with [Filter].
  Query<T> whereFilter(Filter<T> filter) => _with(spec.copyWith(filters: [...spec.filters, filter._node(type.def)]));

  Query<T> orderBy<V>(Field<T, V> field, {bool descending = false}) {
    if (!isName(field.path) && fieldAt(type.def.fields, field.path) == null) throw IceBaseException('invalid-argument', 'orderBy(${showPath(field.path)}): not a field', reason: 'schema');
    return _with(spec.copyWith(orders: [...spec.orders, OrderSpec(field.path, descending: descending)]));
  }

  Query<T> limit(int n) => _with(spec.copyWith(limit: (n: n, last: false)));
  Query<T> limitToLast(int n) => _with(spec.copyWith(limit: (n: n, last: true)));
  Query<T> startAt(List<Object?> values) => _with(spec.copyWith(start: Cursor(values, true)));
  Query<T> startAfter(List<Object?> values) => _with(spec.copyWith(start: Cursor(values, false)));
  Query<T> endAt(List<Object?> values) => _with(spec.copyWith(end: Cursor(values, true)));
  Query<T> endBefore(List<Object?> values) => _with(spec.copyWith(end: Cursor(values, false)));
  Query<T> startAtDocument(DocumentSnapshot<T> d) => _with(spec.copyWith(start: _snap(d, true)));
  Query<T> startAfterDocument(DocumentSnapshot<T> d) => _with(spec.copyWith(start: _snap(d, false)));
  Query<T> endAtDocument(DocumentSnapshot<T> d) => _with(spec.copyWith(end: _snap(d, true)));
  Query<T> endBeforeDocument(DocumentSnapshot<T> d) => _with(spec.copyWith(end: _snap(d, false)));
  Cursor _snap(DocumentSnapshot<T> d, bool inclusive) => Cursor(const [], inclusive, snapshot: (path: d.reference.path, data: d._raw.data ?? const {}));

  void _check() => assertIndexed(type.def, spec);

  Future<QuerySnapshot<T>> get() async {
    _check();
    final docs = await firestore._driver.query(spec);
    return QuerySnapshot._(this, docs, [for (var i = 0; i < docs.length; i++) RawChange('added', docs[i], -1, i)]);
  }

  Stream<QuerySnapshot<T>> snapshots() {
    _check();
    return firestore._driver.watchQuery(spec).map((r) => QuerySnapshot._(this, r.docs, r.changes));
  }

  /// count() like Firebase's AggregateQuery.
  Future<int> count() async {
    _check();
    return ((await firestore._driver.aggregate(spec, {'count': const AggregateField.count()}))['count'] ?? 0).toInt();
  }

  /// sum / average over number fields: aggregate({'total': AggregateField.sum(Products.stock)}).
  Future<Map<String, num?>> aggregate(Map<String, AggregateField> aggs) {
    _check();
    return firestore._driver.aggregate(spec, aggs);
  }
}

class AggregateField {
  /// count | sum | avg
  final String op;
  final List<String>? field;
  const AggregateField.count()
      : op = 'count',
        field = null;
  AggregateField.sum(Field<Object?, num> f)
      : op = 'sum',
        field = f.path;
  AggregateField.average(Field<Object?, num> f)
      : op = 'avg',
        field = f.path;
  Map<String, Object?> toJson() => {'op': op, if (field != null) 'field': field};
}

/// Filters for or()/and() (Firebase's Filter).
class Filter<T> {
  final FilterNode Function(CollectionDef def) _build;
  Filter._(this._build);
  FilterNode _node(CollectionDef def) => _build(def);

  static Filter<T> where<T, V>(Field<T, V> field, {V? isEqualTo, V? isLessThan, V? isGreaterThan, Object? arrayContains, Iterable<V>? whereIn}) => Filter._((def) {
        final op = isEqualTo != null
            ? '=='
            : isLessThan != null
                ? '<'
                : isGreaterThan != null
                    ? '>'
                    : arrayContains != null
                        ? 'array-contains'
                        : 'in';
        final v = isEqualTo ?? isLessThan ?? isGreaterThan ?? arrayContains ?? whereIn?.toList();
        validateQueryValue(def, field.path, op, v);
        return FieldFilter(field.path, op, v);
      });
  static Filter<T> or<T>(List<Filter<T>> filters) => Filter._((def) => CompositeFilter('or', [for (final f in filters) f._node(def)]));
  static Filter<T> and<T>(List<Filter<T>> filters) => Filter._((def) => CompositeFilter('and', [for (final f in filters) f._node(def)]));
}

class CollectionReference<T> extends Query<T> {
  final String path;
  CollectionReference._(IceBaseFirestore firestore, CollectionType<T> type, this.path) : super._(firestore, type, QuerySpec(path: path, collectionId: type.def.id));

  String get id => path.substring(path.lastIndexOf('/') + 1);

  /// doc() → a new auto id · doc('id')
  DocumentReference<T> doc([String? id]) {
    final docId = id ?? autoId();
    if (docId.isEmpty || docId.contains('/')) throw IceBaseException('invalid-argument', "doc('$docId'): an id is non-empty, without '/'");
    return DocumentReference._(firestore, type, '$path/$docId', type.def);
  }

  Future<DocumentReference<T>> add(T value) => addData(type.toMap(value));

  /// add with a map (for FieldValue sentinels such as serverTimestamp()).
  Future<DocumentReference<T>> addData(Map<String, Object?> data) async {
    final d = doc();
    validateWrite(type.def, data, 'create');
    await firestore._driver.commit([SetWrite(d.path, data)]);
    return d;
  }
}

class DocumentReference<T> implements HasDocPath {
  final IceBaseFirestore firestore;
  final CollectionType<T>? _type;
  @override
  final String path;
  final CollectionDef? _def;
  DocumentReference._(this.firestore, this._type, this.path, this._def);

  String get id => path.substring(path.lastIndexOf('/') + 1);

  /// For reference fields in generated models: `Order(product: productRef.docPath, …)`.
  DocPath get docPath => DocPath(path);

  CollectionDef get _schema => _def ?? (throw IceBaseException('invalid-argument', '$path is not in the schema; IceBase only writes declared collections', reason: 'unknown-collection'));

  Future<DocumentSnapshot<T>> get() async => DocumentSnapshot._(this, await firestore._driver.get(path));
  Stream<DocumentSnapshot<T>> snapshots() => firestore._driver.watchDoc(path).map((r) => DocumentSnapshot._(this, r));

  Future<void> set(T value, [SetOptions options = const SetOptions()]) => setData(_type!.toMap(value), options);

  /// set with a map (FieldValue sentinels allowed; with merge, any subset).
  Future<void> setData(Map<String, Object?> data, [SetOptions options = const SetOptions()]) {
    validateWrite(_schema, data, options.merge ? 'merge' : 'set');
    return firestore._driver.commit([SetWrite(path, data, merge: options.merge)]);
  }

  /// update({Products.stock: FieldValue.increment(1), 'name': 'Boot', Users.address.city: 'Pune'})
  /// — keys are Fields (key paths), FieldPaths, or top-level keys (a string is never split on dots).
  Future<void> update(Map<Object, Object?> data) => firestore._driver.commit([UpdateWrite(path, _entries(_schema, data))]);

  Future<void> delete() => firestore._driver.commit([DeleteWrite(path)]);
}

List<(List<String>, Object?)> _entries(CollectionDef def, Map<Object, Object?> data) {
  if (data.isEmpty) throw IceBaseException('invalid-argument', 'update({}): nothing to update');
  final out = [
    for (final e in data.entries)
      (
        switch (e.key) {
          final Field<Object?, Object?> f => f.path,
          final FieldPath p => p.segments,
          final String s => [s],
          final List<String> l => l,
          _ => throw IceBaseException('invalid-argument', 'update keys are Fields, FieldPaths, strings or key lists, got ${e.key.runtimeType}'),
        },
        e.value
      ),
  ];
  validateUpdate(def, out);
  return out;
}

// ─── snapshots ─────────────────────────────────────────────────────────────────

class DocumentSnapshot<T> {
  final DocumentReference<T> reference;
  final RawDoc _raw;
  DocumentSnapshot._(this.reference, this._raw);

  String get id => reference.id;
  bool get exists => _raw.data != null;

  /// The typed document (null when it does not exist).
  T? data() {
    final d = _raw.data;
    if (d == null) return null;
    final t = reference._type;
    return t == null ? d as T : t.fromMap(d);
  }

  /// The stored map, as is (references as [DocPath]).
  Map<String, Object?>? rawData() => _raw.data;

  V? get<V>(Field<T, V> field) {
    Object? cur = _raw.data;
    for (final k in field.path) {
      cur = cur is Map ? cur[k] : null;
    }
    return cur as V?;
  }
}

class DocumentChange<T> {
  /// added | modified | removed
  final String type;
  final DocumentSnapshot<T> doc;
  final int oldIndex;
  final int newIndex;
  DocumentChange._(this.type, this.doc, this.oldIndex, this.newIndex);
}

class QuerySnapshot<T> {
  final Query<T> query;
  final List<DocumentSnapshot<T>> docs;
  final List<DocumentChange<T>> docChanges;
  QuerySnapshot._(this.query, List<RawDoc> raw, List<RawChange> changes)
      : docs = [for (final d in raw) DocumentSnapshot._(_ref(query, d.path), d)],
        docChanges = [for (final c in changes) DocumentChange._(c.type, DocumentSnapshot._(_ref(query, c.doc.path), c.doc), c.oldIndex, c.newIndex)];
  int get size => docs.length;
  bool get isEmpty => docs.isEmpty;
  static DocumentReference<T> _ref<T>(Query<T> q, String path) => DocumentReference._(q.firestore, q.type, path, q.type.def);
}

// ─── transactions and batches ──────────────────────────────────────────────────

class Transaction {
  final IceBaseFirestore _fs;
  final TxDriver _tx;
  Transaction._(this._fs, this._tx);

  Future<DocumentSnapshot<T>> get<T>(DocumentReference<T> ref) async => DocumentSnapshot._(ref, await _tx.get(ref.path));
  Transaction set<T>(DocumentReference<T> ref, T value, [SetOptions options = const SetOptions()]) => setData(ref, ref._type!.toMap(value), options);
  Transaction setData<T>(DocumentReference<T> ref, Map<String, Object?> data, [SetOptions options = const SetOptions()]) {
    validateWrite(ref._schema, data, options.merge ? 'merge' : 'set');
    _tx.write(SetWrite(ref.path, data, merge: options.merge));
    return this;
  }

  Transaction update<T>(DocumentReference<T> ref, Map<Object, Object?> data) {
    _tx.write(UpdateWrite(ref.path, _entries(ref._schema, data)));
    return this;
  }

  Transaction delete<T>(DocumentReference<T> ref) {
    _tx.write(DeleteWrite(ref.path));
    return this;
  }

  /// @nodoc
  IceBaseFirestore get firestore => _fs;
}

class WriteBatch {
  final IceBaseFirestore _fs;
  final List<Write> _writes = [];
  bool _committed = false;
  WriteBatch._(this._fs);

  void _open() {
    if (_committed) throw IceBaseException('failed-precondition', 'A write batch can no longer be used after commit()');
  }

  void set<T>(DocumentReference<T> ref, T value, [SetOptions options = const SetOptions()]) => setData(ref, ref._type!.toMap(value), options);
  void setData<T>(DocumentReference<T> ref, Map<String, Object?> data, [SetOptions options = const SetOptions()]) {
    _open();
    validateWrite(ref._schema, data, options.merge ? 'merge' : 'set');
    _writes.add(SetWrite(ref.path, data, merge: options.merge));
  }

  void update<T>(DocumentReference<T> ref, Map<Object, Object?> data) {
    _open();
    _writes.add(UpdateWrite(ref.path, _entries(ref._schema, data)));
  }

  void delete<T>(DocumentReference<T> ref) {
    _open();
    _writes.add(DeleteWrite(ref.path));
  }

  Future<void> commit() {
    _open();
    _committed = true;
    return _fs._driver.commit(_writes);
  }
}

const _chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
final _rand = Random.secure();

/// Firestore's auto-id: 20 characters from [A-Za-z0-9].
String autoId() => String.fromCharCodes(List.generate(20, (_) => _chars.codeUnitAt(_rand.nextInt(62))));
