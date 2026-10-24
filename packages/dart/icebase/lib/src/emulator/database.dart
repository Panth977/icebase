// emulator mode: the Realtime Database on the IceBase server (the same protocol as the
// TypeScript driver). Listeners share the app's one socket.

import 'dart:async';

import '../app.dart';
import '../database.dart';
import '../errors.dart';
import '../wire.dart';
import 'transport.dart';

RawDbSnapshot _raw(Map<String, Object?> m) => RawDbSnapshot(
      m['key'] as String?,
      m['value'],
      (m['children'] as List?)?.map((c) => ((c as Map)['key'] as String, c['value'])).toList(),
    );

class EmulatorDatabaseDriver implements DatabaseDriver {
  final IceBaseApp app;
  final Transport _t;
  EmulatorDatabaseDriver(this.app) : _t = Transport.of(app);

  @override
  Future<RawDbSnapshot> get(String path, DbQuery? q) async => _raw(await _t.post('/v1/db/get', {'path': path, 'query': q?.toJson()}));

  @override
  Future<void> set(String path, Object? value) => _t.post('/v1/db/set', {'path': path, 'value': encode(value)});

  @override
  Future<void> update(String path, Map<String, Object?> values) => _t.post('/v1/db/update', {'path': path, 'values': encode(values)});

  @override
  Stream<RawDbSnapshot> watch(String path, DbQuery? q) {
    late StreamController<RawDbSnapshot> c;
    void Function()? un;
    c = StreamController<RawDbSnapshot>(
      onListen: () => un = _t.listen('db', {'path': path, 'query': q?.toJson()}, (m) => c.add(_raw((m['snap'] as Map).cast<String, Object?>())), c.addError),
      onCancel: () => un?.call(),
    );
    return c.stream;
  }

  @override
  Future<({bool committed, RawDbSnapshot snapshot})> transaction(String path, Object? Function(Object? current) fn) async {
    for (var n = 0; n < 25; n++) {
      final cur = (await get(path, null)).value;
      final next = fn(cur);
      if (identical(next, DbTransaction.abort)) return (committed: false, snapshot: await get(path, null));
      final r = await _t.post('/v1/db/transaction', {'path': path, 'expect': cur, 'value': encode(next)});
      if (r['committed'] == true) return (committed: true, snapshot: _raw((r['snap'] as Map).cast<String, Object?>()));
    }
    throw IceBaseException('aborted', 'runTransaction: too many retries', details: {'service': 'database'});
  }

  @override
  DbDisconnect onDisconnect(String path) => _Disconnect(_t, path);
}

class _Disconnect implements DbDisconnect {
  final Transport _t;
  final String path;
  _Disconnect(this._t, this.path);
  Future<void> _send(String op, [Object? value]) => _t.request('db', {'t': 'onDisconnect', 'op': op, 'path': path, if (value != null) 'value': encode(value)});
  @override
  Future<void> set(Object? value) => _send('set', value);
  @override
  Future<void> update(Map<String, Object?> values) => _send('update', values);
  @override
  Future<void> remove() => _send('remove');
  @override
  Future<void> cancel() => _send('cancel');
}
