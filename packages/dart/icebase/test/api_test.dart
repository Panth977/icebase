import 'package:icebase/icebase.dart';
import 'package:test/test.dart';

import 'fixture/icebase.g.dart';
import 'support.dart';

void main() {
  late Emulator emu;
  late IceBaseApp app;

  setUpAll(() async {
    emu = await Emulator.start();
    app = IceBaseApp.initialize(icebaseConfig, 'local', name: 'api', emulatorOrigin: emu.url);
  });
  tearDownAll(() async {
    await app.delete();
    await emu.stop();
  });

  test('declared callables: typed in, typed out (timestamps cross the wire)', () async {
    final fns = IceBaseFunctions.instanceFor(app);
    final r = await fns.call(Api.addNumbers, const AddNumbersInput(a: 2, b: 3));
    expect(r.sum, 5);
    expect(r.at, isA<Timestamp>());
    expect(r.at.toDate().toUtc().year, 2030);
    expect(await fns.call(Api.tagCount, ['a', 'b', 'c']), 3);
  });

  test('the input is checked before it leaves', () async {
    final fns = IceBaseFunctions.instanceFor(app);
    await expectLater(fns.call(Api.addNumbers, const AddNumbersInput(a: double.nan, b: 1)), throwsA(isA<IceBaseException>().having((e) => e.code, 'code', 'invalid-argument')));
  });

  test('declared HTTP endpoint: path params, output as the collection model, declared errors', () async {
    final db = IceBaseFirestore.instanceFor(app);
    await db.collection(Products.type).doc('hat').set(const Product(name: 'Hat', priceCents: 900, category: ProductCategory.bags, tags: ['x'], stock: 2, active: true));
    final fns = IceBaseFunctions.instanceFor(app);
    final p = await fns.call(Api.productById, const ProductByIdInput(id: 'hat'));
    expect(p, isA<Product>());
    expect(p.name, 'Hat');
    expect(p.category, ProductCategory.bags);
    await expectLater(fns.call(Api.productById, const ProductByIdInput(id: 'nope')), throwsA(isA<IceBaseException>().having((e) => e.code, 'code', 'not-found')));
  });
}
