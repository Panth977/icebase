// Callable functions with cloud_functions' names. In emulator mode the call goes to the IceBase
// server over Firebase's callable protocol; firebase mode is icebase_flutter's.

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'app.dart';
import 'emulator/transport.dart';
import 'errors.dart';
import 'schema.dart';
import 'values.dart';

/// What a callable backend must do.
abstract interface class FunctionsDriver {
  Future<Object?> call(String region, String name, Object? data, {Duration? timeout});
}

/// firebase's FunctionsException codes (not-found, permission-denied, …) in [IceBaseException.code],
/// prefixed `functions/`.
class IceBaseFunctions {
  final IceBaseApp app;
  final String region;
  final FunctionsDriver _driver;
  IceBaseFunctions._(this.app, this.region, this._driver);

  static IceBaseFunctions instanceFor(IceBaseApp app, {String? region}) {
    final r = region ?? app.config.functionsRegion;
    return app.single('functions:$r', () => IceBaseFunctions._(app, r, app.driver<FunctionsDriver>('functions', () => EmulatorFunctionsDriver(app))));
  }

  static IceBaseFunctions get instance => instanceFor(IceBaseApp.instance());

  /// httpsCallable('add') — with [input], the request is validated before it is sent.
  HttpsCallable httpsCallable(String name, {FieldDef? input, Duration? timeout}) => HttpsCallable._(this, name, input, timeout);
}

class HttpsCallableResult<T> {
  final T data;
  const HttpsCallableResult(this.data);
}

class HttpsCallable {
  final IceBaseFunctions _f;
  final String name;
  final FieldDef? _input;
  final Duration? _timeout;
  HttpsCallable._(this._f, this.name, this._input, this._timeout);

  Future<HttpsCallableResult<T>> call<T>([Object? data]) async {
    final v = storedValue(data);
    if (_input != null) validateValue(_input, v, "httpsCallable('$name') request");
    return HttpsCallableResult<T>(await _f._driver.call(_f.region, name, v, timeout: _timeout) as T);
  }
}

const _status = {
  'CANCELLED': 'cancelled',
  'UNKNOWN': 'unknown',
  'INVALID_ARGUMENT': 'invalid-argument',
  'DEADLINE_EXCEEDED': 'deadline-exceeded',
  'NOT_FOUND': 'not-found',
  'ALREADY_EXISTS': 'already-exists',
  'PERMISSION_DENIED': 'permission-denied',
  'RESOURCE_EXHAUSTED': 'resource-exhausted',
  'FAILED_PRECONDITION': 'failed-precondition',
  'ABORTED': 'aborted',
  'OUT_OF_RANGE': 'out-of-range',
  'UNIMPLEMENTED': 'unimplemented',
  'INTERNAL': 'internal',
  'UNAVAILABLE': 'unavailable',
  'DATA_LOSS': 'data-loss',
  'UNAUTHENTICATED': 'unauthenticated',
};

/// Firebase's callable protocol: POST {data} → {result} | {error: {status, message, details}}.
class EmulatorFunctionsDriver implements FunctionsDriver {
  final IceBaseApp app;
  final Transport _t;
  EmulatorFunctionsDriver(this.app) : _t = Transport.of(app);

  @override
  Future<Object?> call(String region, String name, Object? data, {Duration? timeout}) async {
    final t = await _t.token();
    final http.Response res;
    try {
      final f = _t.client.post(Uri.parse('${app.emulatorOrigin}/${app.config.projectId}/$region/$name'),
          headers: {'content-type': 'application/json', if (t != null) 'authorization': 'Bearer $t'}, body: jsonEncode({'data': _plain(data)}));
      res = await (timeout == null ? f : f.timeout(timeout));
    } on Exception catch (e) {
      throw IceBaseException(e.toString().contains('Timeout') ? 'functions/deadline-exceeded' : 'functions/unavailable', 'cannot reach the IceBase emulator at ${app.emulatorOrigin}: $e');
    }
    final Object? j = res.body.isEmpty ? null : jsonDecode(res.body);
    final m = j is Map ? j.cast<String, Object?>() : const <String, Object?>{};
    if (res.statusCode >= 400 || m['error'] != null) {
      final e = (m['error'] as Map?)?.cast<String, Object?>() ?? const {};
      final details = e['details'];
      throw IceBaseException('functions/${_status[e['status']] ?? 'internal'}', (e['message'] ?? 'function $name failed (${res.statusCode})').toString(),
          details: details is Map ? details.cast<String, Object?>() : {if (details != null) 'details': details});
    }
    return m['result'];
  }
}

/// Callable data is plain JSON (Timestamps as ISO strings, like the Firebase SDKs' encoder).
Object? _plain(Object? v) {
  if (v is Timestamp) return v.toDate().toUtc().toIso8601String();
  if (v is List) return [for (final x in v) _plain(x)];
  if (v is Map) return {for (final e in v.entries) '${e.key}': _plain(e.value)};
  return v;
}
