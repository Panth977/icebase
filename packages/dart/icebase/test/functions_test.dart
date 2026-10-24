import 'package:icebase/icebase.dart';
import 'package:test/test.dart';

import 'fixture/icebase.g.dart';
import 'support.dart';

void main() {
  late Emulator emu;
  late IceBaseApp app;

  setUpAll(() async {
    emu = await Emulator.start();
    app = IceBaseApp.initialize(icebaseConfig, 'local', name: 'fn', emulatorOrigin: emu.url);
  });
  tearDownAll(() async {
    await app.delete();
    await emu.stop();
  });

  test('callable result and errors', () async {
    final f = IceBaseFunctions.instanceFor(app);
    final r = await f.httpsCallable('add').call<Map<String, Object?>>({'a': 2, 'b': 3});
    expect(r.data['sum'], 5);
    await expectLater(f.httpsCallable('add').call({'a': 'x'}), throwsA(isA<IceBaseException>().having((e) => e.code, 'code', 'functions/invalid-argument')));
    await expectLater(f.httpsCallable('nope').call(), throwsA(isA<IceBaseException>().having((e) => e.code, 'code', startsWith('functions/'))));
  });

  test('input is validated before the call', () {
    final f = IceBaseFunctions.instanceFor(app);
    final c = f.httpsCallable('add', input: const MapField({'a': NumberField(), 'b': NumberField()}));
    expect(() => c.call({'a': 1, 'b': 'two'}), throwsA(isA<IceBaseException>()));
  });
}
