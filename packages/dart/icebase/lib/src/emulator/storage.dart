// emulator mode: Cloud Storage on the IceBase server, over the Firebase Storage REST API (v0)
// it speaks — the one the Firebase SDKs use.

import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;

import '../app.dart';
import '../errors.dart';
import '../storage.dart';
import 'transport.dart';

class EmulatorStorageDriver implements StorageDriver {
  final IceBaseApp app;
  final Transport _t;
  EmulatorStorageDriver(this.app) : _t = Transport.of(app);

  String get _bucket => app.config.storageBucket ?? '${app.config.projectId}.appspot.com';
  String get _base => '${app.emulatorOrigin}/v0/b/${Uri.encodeComponent(_bucket)}/o';
  Uri _obj(String path, [Map<String, String>? q]) => Uri.parse('$_base/${Uri.encodeComponent(path)}').replace(queryParameters: q);

  Future<Map<String, String>> _auth() async {
    final t = await _t.token();
    return {if (t != null) 'authorization': 'Firebase $t'};
  }

  Never _fail(http.Response res, String path) {
    Map<String, Object?> e = const {};
    try {
      e = ((jsonDecode(res.body) as Map)['error'] as Map).cast<String, Object?>();
    } catch (_) {}
    final code = e['code'];
    final msg = (e['message'] ?? 'storage ${res.statusCode}').toString();
    if (res.statusCode == 404) throw IceBaseException('storage/object-not-found', "Object '$path' does not exist.");
    if (res.statusCode == 403 || code == 'permission-denied') throw IceBaseException('storage/unauthorized', msg);
    throw IceBaseException(code is String ? (code.contains('/') ? code : 'storage/$code') : 'storage/unknown', msg);
  }

  Future<http.Response> _go(Future<http.Response> Function() f, String path) async {
    final http.Response res;
    try {
      res = await f();
    } catch (e) {
      throw IceBaseException('storage/unknown', 'cannot reach the IceBase emulator at ${app.emulatorOrigin}: $e');
    }
    if (res.statusCode >= 400) _fail(res, path);
    return res;
  }

  FullMetadata _meta(Map<String, Object?> m) => FullMetadata(
        bucket: m['bucket'] as String,
        fullPath: m['name'] as String,
        size: int.parse('${m['size']}'),
        contentType: m['contentType'] as String?,
        md5Hash: m['md5Hash'] as String?,
        generation: m['generation'] as String?,
        timeCreated: m['timeCreated'] == null ? null : DateTime.parse(m['timeCreated'] as String),
        updated: m['updated'] == null ? null : DateTime.parse(m['updated'] as String),
        cacheControl: m['cacheControl'] as String?,
        contentDisposition: m['contentDisposition'] as String?,
        customMetadata: ((m['metadata'] as Map?) ?? const {}).cast<String, String>(),
      );

  Map<String, Object?> _json(http.Response r) => (jsonDecode(r.body) as Map).cast<String, Object?>();

  @override
  Future<FullMetadata> upload(String path, Uint8List data, SettableMetadata? metadata) async {
    final boundary = 'icebase${DateTime.now().microsecondsSinceEpoch}';
    final meta = {'name': path, 'contentType': metadata?.contentType ?? 'application/octet-stream', ...?metadata?.toJson()};
    final body = BytesBuilder()
      ..add(utf8.encode('--$boundary\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${jsonEncode(meta)}\r\n--$boundary\r\ncontent-type: ${meta['contentType']}\r\n\r\n'))
      ..add(data)
      ..add(utf8.encode('\r\n--$boundary--'));
    final headers = {...await _auth(), 'content-type': 'multipart/related; boundary=$boundary', 'x-goog-upload-protocol': 'multipart'};
    final res = await _go(() => _t.client.post(Uri.parse(_base).replace(queryParameters: {'name': path}), headers: headers, body: body.takeBytes()), path);
    return _meta(_json(res));
  }

  @override
  Future<Uint8List> download(String path, int maxSize) async {
    final res = await _go(() async => _t.client.get(_obj(path, {'alt': 'media'}), headers: await _auth()), path);
    if (res.bodyBytes.length > maxSize) throw IceBaseException('storage/retry-limit-exceeded', "Object '$path' is ${res.bodyBytes.length} bytes, over the maxSize $maxSize.");
    return res.bodyBytes;
  }

  @override
  Future<FullMetadata> getMetadata(String path) async => _meta(_json(await _go(() async => _t.client.get(_obj(path), headers: await _auth()), path)));

  @override
  Future<FullMetadata> updateMetadata(String path, SettableMetadata metadata) async =>
      _meta(_json(await _go(() async => _t.client.patch(_obj(path), headers: {...await _auth(), 'content-type': 'application/json'}, body: jsonEncode(metadata.toJson())), path)));

  @override
  Future<void> delete(String path) async {
    await _go(() async => _t.client.delete(_obj(path), headers: await _auth()), path);
  }

  @override
  Future<String> downloadUrl(String path) async {
    final m = _json(await _go(() async => _t.client.get(_obj(path), headers: await _auth()), path));
    final token = (m['downloadTokens'] as String?)?.split(',').first;
    if (token == null) throw IceBaseException('storage/no-download-url', "Object '$path' has no download token.");
    return _obj(path, {'alt': 'media', 'token': token}).toString();
  }

  @override
  Future<({List<String> items, List<String> prefixes, String? next})> list(String prefix, {int? maxResults, String? pageToken}) async {
    final q = {'prefix': prefix, 'delimiter': '/', if (maxResults != null) 'maxResults': '$maxResults', if (pageToken != null) 'pageToken': pageToken};
    final m = _json(await _go(() async => _t.client.get(Uri.parse(_base).replace(queryParameters: q), headers: await _auth()), prefix));
    return (
      items: [for (final i in (m['items'] as List? ?? const [])) (i as Map)['name'] as String],
      prefixes: [for (final p in (m['prefixes'] as List? ?? const [])) (p as String).replaceFirst(RegExp(r'/$'), '')],
      next: m['nextPageToken'] as String?,
    );
  }
}
