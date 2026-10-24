import 'dart:async';

import 'package:icebase/icebase.dart';
import 'package:test/test.dart';

import 'fixture/icebase.g.dart';
import 'support.dart';

Matcher code(String c) => throwsA(isA<IceBaseException>().having((e) => e.code, 'code', c));

void main() {
  late Emulator emu;
  late IceBaseApp app;
  late IceBaseDatabase db;

  setUpAll(() async {
    emu = await Emulator.start();
    app = IceBaseApp.initialize(icebaseConfig, 'local', name: 'db', emulatorOrigin: emu.url);
    db = IceBaseDatabase.instanceFor(app);
  });
  tearDownAll(() async {
    await app.delete();
    await emu.stop();
  });

  test('typed set / get / update / remove', () async {
    final r = db.ref(Messages.type, ['r1', 'm1']);
    await r.set(const Message(text: 'hi', at: 1, by: 'ann'));
    expect((await r.get()).value?.text, 'hi');
    await r.update({'text': 'hello'});
    expect((await r.get()).value?.text, 'hello');
    expect(() => r.update({'nope': 1}), throwsA(isA<IceBaseException>().having((e) => e.reason, 'reason', 'schema')));
    expect(() => r.update({'at': 'x'}), throwsA(isA<IceBaseException>()));
    await r.remove();
    expect((await r.get()).exists, isFalse);
  });

  test('list queries need indexOn', () async {
    final list = db.list(Messages.type, ['r2']);
    for (var i = 0; i < 5; i++) {
      await list.child('m$i').set(Message(text: 't$i', at: 10 - i, by: 'bo'));
    }
    final last2 = await list.orderByChild('at').limitToLast(2).get();
    expect(last2.children.map((c) => c.key), ['m1', 'm0']);
    final range = await list.orderByChild('at').startAt(7).endAt(8).get();
    expect(range.children.map((c) => c.value!.text), ['t3', 't2']);
    expect(() => list.orderByChild('text'), code('failed-precondition'));
    final keys = await list.orderByKey().limitToFirst(2).get();
    expect(keys.children.map((c) => c.key), ['m0', 'm1']);
  });

  test('push, ServerValue, transaction', () async {
    final list = db.list(Messages.type, ['r3']);
    final a = await list.push(const Message(text: 'a', at: 0, by: 'x'));
    final b = await list.push(const Message(text: 'b', at: 0, by: 'x'));
    expect(a.key!.compareTo(b.key!), lessThan(0));
    await a.update({'at': ServerValue.timestamp});
    expect((await a.get()).value!.at, greaterThan(1600000000000));
    final r = await b.runTransaction((cur) => Message(text: '${cur!.text}!', at: cur.at + 1, by: cur.by));
    expect(r.committed, isTrue);
    expect(r.snapshot.value!.text, 'b!');
    final none = await b.runTransaction((cur) => DbTransaction.abort);
    expect(none.committed, isFalse);
  });

  test('onValue and child events stream', () async {
    final list = db.list(Messages.type, ['r4']);
    final added = <String>[];
    final changed = <String>[];
    final removed = <String>[];
    final values = <int>[];
    final subs = [
      list.onChildAdded.listen((e) => added.add(e.snapshot.key!)),
      list.onChildChanged.listen((e) => changed.add(e.snapshot.value!.text)),
      list.onChildRemoved.listen((e) => removed.add(e.snapshot.key!)),
      list.onValue.listen((s) => values.add(s.size)),
    ];
    await Future<void>.delayed(const Duration(milliseconds: 100));
    await list.child('a').set(const Message(text: 'one', at: 1, by: 'x'));
    await list.child('b').set(const Message(text: 'two', at: 2, by: 'x'));
    await list.child('a').update({'text': 'uno'});
    await list.child('b').remove();
    await Future<void>.delayed(const Duration(milliseconds: 200));
    for (final s in subs) {
      await s.cancel();
    }
    expect(added, ['a', 'b']);
    expect(changed, ['uno']);
    expect(removed, ['b']);
    expect(values.first, 0);
    expect(values.last, 1);
  });

  test('onDisconnect runs when the client goes away', () async {
    final other = IceBaseApp.initialize(icebaseConfig, 'local', name: 'db2', emulatorOrigin: emu.url);
    final r2 = IceBaseDatabase.instanceFor(other).ref(Messages.type, ['r5', 'presence']);
    await r2.set(const Message(text: 'online', at: 1, by: 'x'));
    await r2.onDisconnect().remove();
    expect((await db.ref(Messages.type, ['r5', 'presence']).get()).exists, isTrue);
    await other.delete();
    await Future<void>.delayed(const Duration(milliseconds: 300));
    expect((await db.ref(Messages.type, ['r5', 'presence']).get()).exists, isFalse);
  });
}
