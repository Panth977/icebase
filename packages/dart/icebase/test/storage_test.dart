import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:icebase/icebase.dart';
import 'package:test/test.dart';

import 'fixture/icebase.g.dart';
import 'support.dart';

Matcher code(String c) => throwsA(isA<IceBaseException>().having((e) => e.code, 'code', c));

void main() {
  late Emulator emu;
  late IceBaseApp app;
  late IceBaseStorage st;

  setUpAll(() async {
    emu = await Emulator.start();
    app = IceBaseApp.initialize(icebaseConfig, 'local', name: 'st', emulatorOrigin: emu.url);
    st = IceBaseStorage.instanceFor(app);
  });
  tearDownAll(() async {
    await app.delete();
    await emu.stop();
  });

  test('put / get / metadata / download URL / list / delete', () async {
    final bytes = Uint8List.fromList(List.generate(300, (i) => i % 256));
    final r = st.file(Avatars.def, ['u1', 'me.png']);
    final m = await r.putData(bytes, const SettableMetadata(contentType: 'image/png', customMetadata: {'by': 'test'}));
    expect(m.size, 300);
    expect(m.fullPath, 'avatars/u1/me.png');
    expect(await r.getData(), bytes);
    final meta = await r.getMetadata();
    expect(meta.contentType, 'image/png');
    expect(meta.customMetadata['by'], 'test');
    final url = await r.getDownloadURL();
    final c = HttpClient();
    final res = await (await c.getUrl(Uri.parse(url))).close();
    final got = await res.fold<List<int>>([], (a, b) => a..addAll(b));
    c.close();
    expect(got, bytes);
    await st.file(Avatars.def, ['u1', 'b.png']).putData(Uint8List(4), const SettableMetadata(contentType: 'image/png'));
    final l = await st.ref('avatars/u1').listAll();
    expect(l.items.map((i) => i.name).toList()..sort(), ['b.png', 'me.png']);
    final top = await st.ref('avatars').list();
    expect(top.prefixes.map((p) => p.fullPath), ['avatars/u1']);
    await r.delete();
    await expectLater(r.getData(), code('storage/object-not-found'));
  });

  test('uploads are checked against filePath()', () {
    final r = st.file(Avatars.def, ['u2', 'a.txt']);
    expect(() => r.putData(Uint8List(1), const SettableMetadata(contentType: 'text/plain')), throwsA(isA<IceBaseException>().having((e) => e.reason, 'reason', 'schema')));
    expect(() => r.putData(Uint8List(2 * 1024 * 1024), const SettableMetadata(contentType: 'image/png')), throwsA(isA<IceBaseException>().having((e) => e.reason, 'reason', 'schema')));
    expect(() => st.ref('other/x.png').putData(Uint8List(1), const SettableMetadata(contentType: 'image/png')), throwsA(isA<IceBaseException>()));
    expect(() => st.file(Avatars.def, ['u2']), throwsA(isA<IceBaseException>()));
    expect(utf8.decode(utf8.encode('ok')), 'ok');
  });
}
