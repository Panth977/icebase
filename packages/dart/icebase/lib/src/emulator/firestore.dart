// emulator mode: Firestore on the IceBase server (the same protocol as the TypeScript driver).

import 'dart:async';
import 'dart:math';

import '../app.dart';
import '../errors.dart';
import '../firestore.dart';
import '../plan.dart';
import '../wire.dart';
import 'transport.dart';

class EmulatorFirestoreDriver implements FirestoreDriver {
  final IceBaseApp app;
  final Transport _t;
  EmulatorFirestoreDriver(this.app) : _t = Transport.of(app);

  RawDoc _raw(Map<String, Object?> d) =>
      RawDoc(d['path'] as String, d['data'] == null ? null : (decode(d['data']) as Map).cast<String, Object?>(), version: (d['version'] as num?)?.toInt() ?? 0, native: d);

  Map<String, Object?>? _cursor(QuerySpec spec, Cursor? c) {
    if (c == null) return null;
    final snap = c.snapshot;
    if (snap == null) {
      return {
        'values': [for (final v in c.values) encode(v)],
        'inclusive': c.inclusive
      };
    }
    // A snapshot cursor: its values in the query's full order (+ the path for __name__).
    final values = fullOrder(spec).map((o) {
      if (isName(o.field)) return snap.path;
      Object? cur = snap.data;
      for (final k in o.field) {
        cur = cur is Map ? cur[k] : null;
      }
      return encode(cur);
    }).toList();
    return {'values': values, 'inclusive': c.inclusive};
  }

  Map<String, Object?> _spec(QuerySpec s) => {
        'path': s.path,
        'collectionId': s.collectionId,
        'filters': [for (final f in s.filters) f.toJson(encode)],
        'orders': [
          for (final o in s.orders) {'field': o.field, 'dir': o.dir}
        ],
        if (s.limit != null) 'limit': {'n': s.limit!.n, 'last': s.limit!.last},
        if (s.start != null) 'start': _cursor(s, s.start),
        if (s.end != null) 'end': _cursor(s, s.end),
      };

  Map<String, Object?> _write(Write w) => switch (w) {
        SetWrite() => {'op': 'set', 'path': w.path, 'data': encode(w.data), if (w.merge) 'merge': true},
        CreateWrite() => {'op': 'create', 'path': w.path, 'data': encode(w.data)},
        UpdateWrite() => {
            'op': 'update',
            'path': w.path,
            'fields': [
              for (final (p, v) in w.fields) {'path': p, 'value': encode(v)}
            ]
          },
        DeleteWrite() => {'op': 'delete', 'path': w.path},
      };

  List<RawDoc> _docs(Map<String, Object?> r) => [for (final d in (r['docs'] as List)) _raw((d as Map).cast<String, Object?>())];

  @override
  Future<RawDoc> get(String path) async => _docs(await _t.post('/v1/fs/get', {
        'paths': [path]
      }))
          .first;

  @override
  Future<List<RawDoc>> query(QuerySpec spec) async => _docs(await _t.post('/v1/fs/query', {'spec': _spec(spec)}));

  @override
  Future<Map<String, num?>> aggregate(QuerySpec spec, Map<String, AggregateField> aggs) async {
    final r = await _t.post('/v1/fs/aggregate', {'spec': _spec(spec), 'aggs': aggs.map((k, v) => MapEntry(k, v.toJson()))});
    return (r['result'] as Map).cast<String, num?>();
  }

  Future<void> _commit(List<Write> writes, [List<Map<String, Object?>> pre = const []]) async {
    await _t.post('/v1/fs/commit', {
      'writes': [for (final w in writes) _write(w)],
      'preconditions': pre
    });
  }

  @override
  Future<void> commit(List<Write> writes) => _commit(writes);

  @override
  Stream<RawDoc> watchDoc(String path) {
    late StreamController<RawDoc> c;
    void Function()? un;
    c = StreamController<RawDoc>(
      onListen: () => un = _t.listen('fs', {'kind': 'doc', 'path': path}, (m) => c.add(_raw(((m['docs'] as List).first as Map).cast<String, Object?>())), c.addError),
      onCancel: () => un?.call(),
    );
    return c.stream;
  }

  @override
  Stream<({List<RawDoc> docs, List<RawChange> changes})> watchQuery(QuerySpec spec) {
    late StreamController<({List<RawDoc> docs, List<RawChange> changes})> c;
    void Function()? un;
    var prev = <String, (int, int)>{};
    c = StreamController(
      onListen: () => un = _t.listen('fs', {'kind': 'query', 'spec': _spec(spec)}, (m) {
        final docs = _docs(m);
        final changes = <RawChange>[];
        final now = {for (var i = 0; i < docs.length; i++) docs[i].path: (i, docs[i].version)};
        prev.forEach((p, o) {
          if (!now.containsKey(p)) changes.add(RawChange('removed', RawDoc(p, null), o.$1, -1));
        });
        for (var i = 0; i < docs.length; i++) {
          final o = prev[docs[i].path];
          if (o == null) {
            changes.add(RawChange('added', docs[i], -1, i));
          } else if (o.$2 != docs[i].version) {
            changes.add(RawChange('modified', docs[i], o.$1, i));
          }
        }
        prev = now;
        c.add((docs: docs, changes: changes));
      }, c.addError),
      onCancel: () => un?.call(),
    );
    return c.stream;
  }

  @override
  Future<R> transaction<R>(Future<R> Function(TxDriver tx) fn, {int maxAttempts = 5}) async {
    final rnd = Random();
    for (var n = 1;; n++) {
      final tx = _Tx(this);
      final result = await fn(tx);
      try {
        await _commit(tx.writes, [
          for (final e in tx.reads.entries) {'path': e.key, 'version': e.value}
        ]);
        return result;
      } on IceBaseException catch (e) {
        if (e.code != 'aborted' || n >= maxAttempts) rethrow;
        await Future<void>.delayed(Duration(milliseconds: rnd.nextInt(20 * (1 << n))));
      }
    }
  }
}

class _Tx implements TxDriver {
  final EmulatorFirestoreDriver _d;
  final Map<String, int> reads = {};
  final List<Write> writes = [];
  _Tx(this._d);

  @override
  Future<RawDoc> get(String path) async {
    if (writes.isNotEmpty) throw IceBaseException('invalid-argument', 'Firestore transactions require all reads to be executed before all writes.');
    final d = await _d.get(path);
    reads[path] = d.version;
    return d;
  }

  @override
  void write(Write w) => writes.add(w);
}
