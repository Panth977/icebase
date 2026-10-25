// Declared endpoints (icebase/api), generated into Dart by `icebase gen dart`: typed input and
// output, checked against the declaration before the call leaves and after the answer arrives.

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'errors.dart';
import 'functions.dart';
import 'schema.dart';
import 'values.dart';

class ApiEndpoint<I, O> {
  final String name;

  /// GET | POST | PUT | PATCH | DELETE for an HTTP endpoint; null for a callable.
  final String? method;
  final String? path;
  final FieldDef input;
  final FieldDef output;

  /// none | signed-in | admin
  final String auth;
  final Object? Function(I input) toInput;
  final O Function(Object? output) fromOutput;
  const ApiEndpoint(this.name, {this.method, this.path, required this.input, required this.output, this.auth = 'signed-in', required this.toInput, required this.fromOutput});

  bool get isHttp => method != null;
}

/// A value → its JSON form (timestamps as ISO strings, references as paths), guided by its field.
Object? toWire(FieldDef d, Object? v) {
  if (v == null) return null;
  return switch (d) {
    TimestampField() => v is Timestamp ? v.toDate().toUtc().toIso8601String() : (v is DateTime ? v.toUtc().toIso8601String() : v),
    RefField() => v is DocPath ? v.path : v,
    GeoPointField() => v is GeoPoint ? {'latitude': v.latitude, 'longitude': v.longitude} : v,
    BytesField() => v is List<int> ? base64Encode(v) : v,
    ArrayField() => v is List ? [for (final x in v) toWire(d.of, x)] : v,
    RecordField() => v is Map ? {for (final e in v.entries) '${e.key}': toWire(d.of, e.value)} : v,
    MapField() => v is Map ? {for (final e in v.entries) '${e.key}': d.fields[e.key] == null ? e.value : toWire(d.fields[e.key]!, e.value)} : v,
    _ => v,
  };
}

/// JSON → the values the field declares (the reverse of [toWire]).
Object? fromWire(FieldDef d, Object? v) {
  if (v == null) return null;
  return switch (d) {
    TimestampField() => v is String ? Timestamp.fromDate(DateTime.parse(v)) : (v is Map && v['seconds'] is num ? Timestamp((v['seconds'] as num).toInt(), (v['nanoseconds'] as num? ?? 0).toInt()) : v),
    RefField() => v is String ? DocPath(v) : (v is Map && v['path'] is String ? DocPath(v['path'] as String) : v),
    GeoPointField() => v is Map ? GeoPoint((v['latitude'] as num).toDouble(), (v['longitude'] as num).toDouble()) : v,
    BytesField() => v is String ? base64Decode(v) : v,
    ArrayField() => v is List ? [for (final x in v) fromWire(d.of, x)] : v,
    RecordField() => v is Map ? {for (final e in v.entries) '${e.key}': fromWire(d.of, e.value)} : v,
    MapField() => v is Map ? {for (final e in v.entries) '${e.key}': d.fields[e.key] == null ? e.value : fromWire(d.fields[e.key]!, e.value)} : v,
    _ => v,
  };
}

extension ApiCalls on IceBaseFunctions {
  /// Call a declared endpoint (a callable, or an HTTP route): the input is checked before it is
  /// sent, the output after it arrives.
  Future<O> call<I, O>(ApiEndpoint<I, O> e, I input, {Duration? timeout, String? baseUrl, String? idToken}) async {
    final raw = storedValue(e.toInput(input));
    validateValue(e.input, raw, '${e.name} input');
    final wire = toWire(e.input, raw);
    final Object? out;
    if (!e.isHttp) {
      out = await httpsCallable(e.name, timeout: timeout).call<Object?>(wire).then((r) => r.data);
    } else {
      out = await _http(e, (wire as Map).cast<String, Object?>(), baseUrl: baseUrl, idToken: idToken);
    }
    final value = fromWire(e.output, out);
    try {
      validateValue(e.output, value, '${e.name} output');
    } catch (err) {
      throw IceBaseException('internal', '${e.name}: the answer does not match its declared output: $err');
    }
    return e.fromOutput(value);
  }

  Future<Object?> _http(ApiEndpoint<dynamic, dynamic> e, Map<String, Object?> input, {String? baseUrl, String? idToken}) async {
    final project = app.config.projectId;
    final base = baseUrl ?? (app.modes['functions'] == 'emulator' ? '${app.emulatorOrigin}/$project/$region/${e.name}' : 'https://$region-$project.cloudfunctions.net/${e.name}');
    final rest = {...input};
    final path = e.path!.replaceAllMapped(RegExp(r'\{([^}]+)\}'), (m) => Uri.encodeComponent('${rest.remove(m[1])}'));
    final bodyless = e.method == 'GET' || e.method == 'DELETE';
    var uri = Uri.parse(base.replaceAll(RegExp(r'/$'), '') + path);
    if (bodyless && rest.isNotEmpty) {
      uri = uri.replace(queryParameters: {
        for (final x in rest.entries)
          if (x.value != null) x.key: x.value is String ? x.value as String : jsonEncode(x.value)
      });
    }
    final token = idToken ?? (app.idToken == null ? null : await app.idToken!());
    final headers = {if (!bodyless) 'content-type': 'application/json', if (token != null) 'authorization': 'Bearer $token'};
    final req = http.Request(e.method!, uri)..headers.addAll(headers);
    if (!bodyless) req.body = jsonEncode(rest);
    final res = await http.Response.fromStream(await req.send());
    final Object? j = res.body.isEmpty ? null : jsonDecode(res.body);
    if (res.statusCode >= 400 || (j is Map && j['error'] != null)) {
      final err = j is Map ? (j['error'] as Map?) : null;
      throw IceBaseException('${err?['code'] ?? 'internal'}', '${err?['message'] ?? '${e.name}: HTTP ${res.statusCode}'}');
    }
    return j;
  }
}
