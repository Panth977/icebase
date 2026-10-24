import 'package:icebase/icebase.dart';
import 'package:test/test.dart';

import 'fixture/icebase.g.dart';
import 'support.dart';

void main() {
  late Emulator emu;
  late IceBaseFirestore db;
  late IceBaseApp app;

  setUpAll(() async {
    emu = await Emulator.start();
    app = IceBaseApp.initialize(icebaseConfig, 'local', name: 'fs', emulatorOrigin: emu.url);
    db = IceBaseFirestore.instanceFor(app);
    final batch = db.batch();
    for (var i = 0; i < 12; i++) {
      batch.set(
        db.collection(Products.type).doc('p${i.toString().padLeft(2, '0')}'),
        Product(name: 'P$i', priceCents: 100 * (i + 1), category: ProductCategory.values[i % 3], tags: ['all', if (i.isOdd) 'odd'], stock: i, active: i % 4 != 0),
      );
    }
    await batch.commit();
  });
  tearDownAll(() async {
    await app.delete();
    await emu.stop();
  });

  CollectionReference<Product> products() => db.collection(Products.type);

  test('typed read', () async {
    final s = await products().doc('p03').get();
    expect(s.exists, isTrue);
    final p = s.data()!;
    expect(p.name, 'P3');
    expect(p.category, ProductCategory.shoes);
    expect(p.priceCents, 400);
    expect((await products().doc('missing').get()).exists, isFalse);
  });

  test('queries with declared indexes', () async {
    final s = await products().where(Products.tags, arrayContains: 'all').orderBy(Products.priceCents, descending: true).limit(3).get();
    expect(s.docs.map((d) => d.data()!.stock), [11, 10, 9]);
    final eq = await products().where(Products.category, isEqualTo: ProductCategory.bags).where(Products.active, isEqualTo: true).get();
    expect(eq.docs.map((d) => d.data()!.stock).toSet(), {2, 5, 11});
    final page = await products().orderBy(Products.stock).limit(4).get();
    final next = await products().orderBy(Products.stock).startAfterDocument(page.docs.last).limit(4).get();
    expect(next.docs.map((d) => d.data()!.stock), [4, 5, 6, 7]);
    final ors = await products().whereFilter(Filter.or([Filter.where(Products.stock, isEqualTo: 1), Filter.where(Products.stock, isEqualTo: 5)])).get();
    expect(ors.docs.map((d) => d.data()!.stock).toSet(), {1, 5});
    expect(await products().where(Products.tags, arrayContains: 'odd').count(), 6);
  });

  test('refuses an undeclared index before the request leaves', () {
    expect(
      () => products().where(Products.category, isEqualTo: ProductCategory.shoes).orderBy(Products.stock).get(),
      throwsA(isA<IceBaseException>().having((e) => e.details['index'], 'index', "index('category', 'stock')")),
    );
    expect(() => products().where(Products.name, isEqualTo: 'x').get(), throwsA(isA<IceBaseException>().having((e) => e.message, 'message', contains("Add index('name')"))));
  });

  test('validates writes against the schema', () async {
    expect(() => products().doc('bad').setData({'name': 'x', 'priceCents': -1, 'category': 'socks'}), throwsA(isA<IceBaseException>().having((e) => e.reason, 'reason', 'schema')));
    expect(() => products().doc('p01').update({Products.stock: 'many'}), throwsA(isA<IceBaseException>()));
  });

  test('field values, key paths and dotted keys', () async {
    final r = products().doc('p05');
    await r.update({
      Products.stock: FieldValue.increment(10),
      Products.tags: FieldValue.arrayUnion(['sale']),
      Products.updatedAt: FieldValue.serverTimestamp(),
      Products.dims: const ProductDims(w: 3, h: 4),
      Products.ratingAvg: 4.5
    });
    await r.update({Products.dimsW: 7});
    final p = (await r.get()).data()!;
    expect(p.stock, 15);
    expect(p.tags, contains('sale'));
    expect(p.updatedAt, isA<Timestamp>());
    expect(p.dims!.w, 7);
    expect(p.ratingAvg, 4.5);
    expect((await r.get()).rawData()!.containsKey('rating'), isFalse);
    expect((await products().where(Products.dimsW, isEqualTo: 7).get()).docs.map((d) => d.id), ['p05']);
    await r.update({Products.updatedAt: FieldValue.delete()});
    expect((await r.get()).data()!.updatedAt, isNull);
  });

  test('subcollections, references, collection groups, transactions', () async {
    final orders = db.collection(Orders.type, ['u1']);
    final o = await orders.add(Order(product: products().doc('p01').docPath, qty: 2, status: OrderStatus.paid));
    expect(o.path, startsWith('users/u1/orders/'));
    final g = await db.collectionGroup(Orders.type).where(Orders.status, isEqualTo: OrderStatus.paid).get();
    expect(g.docs.single.data()!.product.path, 'products/p01');
    final name = await db.runTransaction((tx) async {
      final s = await tx.get(products().doc('p07'));
      tx.update(s.reference, {Products.stock: s.data()!.stock + 1});
      return s.data()!.name;
    });
    expect(name, 'P7');
    expect((await products().doc('p07').get()).data()!.stock, 8);
  });

  test('snapshots stream changes', () async {
    final events = <List<String>>[];
    final sub = products().where(Products.category, isEqualTo: ProductCategory.shirts).snapshots().listen((s) => events.add([for (final c in s.docChanges) '${c.type}:${c.doc.id}']));
    await Future<void>.delayed(const Duration(milliseconds: 300));
    await products().doc('p04').delete();
    await Future<void>.delayed(const Duration(milliseconds: 300));
    await sub.cancel();
    expect(events.first.every((e) => e.startsWith('added:')), isTrue);
    expect(events.last, ['removed:p04']);
  });
}
