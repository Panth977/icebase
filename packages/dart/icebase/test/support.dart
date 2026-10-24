// Starts the IceBase emulator (Node, from this repository) for the Dart tests.
import 'dart:async';
import 'dart:convert';
import 'dart:io';

class Emulator {
  final Process process;
  final String url;
  Emulator._(this.process, this.url);

  static Future<Emulator> start() async {
    final p = await Process.start('node', ['--import', 'tsx', 'tool/emulator.ts', 'test/fixture'], environment: {'NODE_NO_WARNINGS': '1'});
    final ready = Completer<String>();
    final err = StringBuffer();
    p.stdout.transform(utf8.decoder).transform(const LineSplitter()).listen((l) {
      if (l.startsWith('ready ') && !ready.isCompleted) ready.complete(l.substring(6));
    });
    p.stderr.transform(utf8.decoder).listen(err.write);
    unawaited(p.exitCode.then((c) {
      if (!ready.isCompleted) ready.completeError('emulator exited ($c): $err');
    }));
    return Emulator._(p, await ready.future.timeout(const Duration(seconds: 60)));
  }

  /// What the console senders wrote (custom auth), newest last.
  Future<List<Map<String, Object?>>> outbox() async {
    final c = HttpClient();
    final req = await c.getUrl(Uri.parse('$url/__/icebase/auth/outbox'));
    req.headers.set('authorization', 'Bearer owner');
    final res = await req.close();
    final j = jsonDecode(await res.transform(utf8.decoder).join()) as Map;
    c.close();
    return [for (final m in j['messages'] as List) (m as Map).cast<String, Object?>()];
  }

  Future<Map<String, Object?>> lastTo(String to) async => (await outbox()).lastWhere((m) => m['to'] == to);

  Future<void> stop() async {
    process.kill();
    await process.exitCode;
  }
}
