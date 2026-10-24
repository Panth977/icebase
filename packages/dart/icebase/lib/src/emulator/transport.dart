// HTTP and the one realtime socket to the IceBase server (emulator mode), shared by every
// service of an app. The socket re-authenticates when the user changes and re-subscribes after
// reconnecting.

import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:web_socket_channel/web_socket_channel.dart';

import '../app.dart';
import '../errors.dart';

class Transport {
  final IceBaseApp app;
  final http.Client _http = http.Client();
  WebSocketChannel? _ws;
  Future<void>? _open;
  String? _token;
  final Map<String, _Sub> _subs = {};
  var _seq = 0;
  bool _closed = false;

  Transport._(this.app) {
    app.onDelete(close);
  }

  static Transport of(IceBaseApp app) => app.single('emulator:transport', () => Transport._(app));

  Future<String?> token() async => app.idToken == null ? null : await app.idToken!();

  /// POST JSON to the server; throws IceBaseException with the server's code.
  Future<Map<String, Object?>> post(String path, Object? body, {String? bearer}) async {
    final t = bearer ?? await token();
    final http.Response res;
    try {
      res = await _http.post(Uri.parse('${app.emulatorOrigin}$path'), headers: {'content-type': 'application/json', if (t != null) 'authorization': 'Bearer $t'}, body: jsonEncode(body));
    } catch (e) {
      throw IceBaseException('unavailable', 'cannot reach the IceBase emulator at ${app.emulatorOrigin} (is `icebase dev` running?): $e');
    }
    return decodeResponse(res);
  }

  Future<http.Response> send(http.BaseRequest req) async => http.Response.fromStream(await _http.send(req));
  http.Client get client => _http;

  static Map<String, Object?> decodeResponse(http.Response res) {
    final Object? j = res.body.isEmpty ? <String, Object?>{} : jsonDecode(res.body);
    final m = j is Map ? j.cast<String, Object?>() : <String, Object?>{'value': j};
    final err = m['error'];
    if (res.statusCode >= 400 || err != null) {
      final e = err is Map ? err : const {};
      throw IceBaseException((e['code'] ?? e['status'] ?? 'internal').toString(), (e['message'] ?? 'emulator ${res.statusCode}').toString(),
          details: e['details'] is Map ? (e['details'] as Map).cast<String, Object?>() : const {});
    }
    return m;
  }

  String nextId() => 'd${++_seq}';

  Future<void> _connect() {
    return _open ??= () async {
      final ws = WebSocketChannel.connect(Uri.parse('${app.emulatorOrigin.replaceFirst('http', 'ws')}/v1/rt'));
      await ws.ready;
      _ws = ws;
      _token = await token();
      ws.sink.add(jsonEncode({'t': 'auth', 'token': _token}));
      for (final s in _subs.values) {
        ws.sink.add(jsonEncode(s.message));
      }
      ws.stream.listen(
        (raw) {
          final m = (jsonDecode(raw as String) as Map).cast<String, Object?>();
          if (m['t'] == 'authed') return;
          final s = _subs['${m['s']}:${m['id']}'];
          if (s == null) return;
          if (m['t'] == 'error') {
            _subs.remove('${m['s']}:${m['id']}');
            final e = (m['error'] as Map).cast<String, Object?>();
            s.onError(IceBaseException(e['code'].toString(), e['message'].toString()));
          } else {
            s.onMessage(m);
          }
        },
        onDone: () {
          _ws = null;
          _open = null;
          if (!_closed && _subs.isNotEmpty) Timer(const Duration(milliseconds: 500), () => _connect().catchError((_) {}));
        },
        cancelOnError: false,
      );
    }();
  }

  /// Subscribe (s: 'fs' | 'db'); the returned function unsubscribes.
  void Function() listen(String s, Map<String, Object?> subscribe, void Function(Map<String, Object?>) onMessage, void Function(Object) onError) {
    final id = nextId();
    final sub = _Sub({'s': s, 'id': id, 't': 'listen', ...subscribe}, onMessage, onError);
    final key = '$s:$id';
    _subs[key] = sub;
    () async {
      try {
        final wasOpen = _ws != null;
        await _connect();
        final t = await token();
        if (t != _token) {
          _token = t;
          _ws?.sink.add(jsonEncode({'t': 'auth', 'token': t}));
        }
        if (wasOpen && _subs[key] == sub) _ws?.sink.add(jsonEncode(sub.message));
      } catch (e) {
        if (_subs.remove(key) != null) onError(e);
      }
    }();
    return () {
      if (_subs.remove(key) == null) return;
      _ws?.sink.add(jsonEncode({'s': s, 'id': id, 't': 'unlisten'}));
    };
  }

  /// Send one message and wait for its { t: 'ok' }.
  Future<void> request(String s, Map<String, Object?> msg) {
    final done = Completer<void>();
    final id = nextId();
    final key = '$s:$id';
    _subs[key] = _Sub({'s': s, 'id': id, ...msg}, (_) {
      _subs.remove(key);
      done.complete();
    }, (e) => done.completeError(e));
    final wasOpen = _ws != null;
    _connect().then((_) {
      if (wasOpen) _ws?.sink.add(jsonEncode(_subs[key]?.message));
    }, onError: (Object e) {
      _subs.remove(key);
      done.completeError(e);
    });
    return done.future;
  }

  Future<void> close() async {
    _closed = true;
    await _ws?.sink.close();
    _http.close();
  }
}

class _Sub {
  final Map<String, Object?> message;
  final void Function(Map<String, Object?>) onMessage;
  final void Function(Object) onError;
  _Sub(this.message, this.onMessage, this.onError);
}
