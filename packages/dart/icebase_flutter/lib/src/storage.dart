// firebase mode: Cloud Storage over firebase_storage.

import 'dart:typed_data';

import 'package:firebase_storage/firebase_storage.dart' as st;
import 'package:icebase/icebase.dart';

IceBaseException _err(Object e) {
  if (e is st.FirebaseException) return IceBaseException('storage/${e.code}', e.message ?? e.code);
  if (e is IceBaseException) return e;
  return IceBaseException('storage/unknown', '$e');
}

Future<T> _guard<T>(Future<T> Function() f) async {
  try {
    return await f();
  } catch (e) {
    throw _err(e);
  }
}

FullMetadata _meta(st.FullMetadata m) => FullMetadata(
      bucket: m.bucket ?? '',
      fullPath: m.fullPath,
      size: m.size ?? 0,
      contentType: m.contentType,
      md5Hash: m.md5Hash,
      generation: m.generation,
      timeCreated: m.timeCreated,
      updated: m.updated,
      cacheControl: m.cacheControl,
      contentDisposition: m.contentDisposition,
      customMetadata: m.customMetadata ?? const {},
    );

st.SettableMetadata? _settable(SettableMetadata? m) => m == null
    ? null
    : st.SettableMetadata(
        contentType: m.contentType,
        cacheControl: m.cacheControl,
        contentDisposition: m.contentDisposition,
        contentEncoding: m.contentEncoding,
        contentLanguage: m.contentLanguage,
        customMetadata: m.customMetadata,
      );

class FlutterStorageDriver implements StorageDriver {
  final st.FirebaseStorage storage;
  FlutterStorageDriver(this.storage);

  @override
  Future<FullMetadata> upload(String path, Uint8List data, SettableMetadata? metadata) => _guard(() async => _meta((await storage.ref(path).putData(data, _settable(metadata))).metadata!));

  @override
  Future<Uint8List> download(String path, int maxSize) => _guard(() async => (await storage.ref(path).getData(maxSize))!);

  @override
  Future<FullMetadata> getMetadata(String path) => _guard(() async => _meta(await storage.ref(path).getMetadata()));

  @override
  Future<FullMetadata> updateMetadata(String path, SettableMetadata metadata) => _guard(() async => _meta(await storage.ref(path).updateMetadata(_settable(metadata)!)));

  @override
  Future<void> delete(String path) => _guard(() => storage.ref(path).delete());

  @override
  Future<String> downloadUrl(String path) => _guard(() => storage.ref(path).getDownloadURL());

  @override
  Future<({List<String> items, List<String> prefixes, String? next})> list(String prefix, {int? maxResults, String? pageToken}) => _guard(() async {
        final r = await storage.ref(prefix.replaceFirst(RegExp(r'/$'), '')).list(st.ListOptions(maxResults: maxResults ?? 1000, pageToken: pageToken));
        return (items: [for (final i in r.items) i.fullPath], prefixes: [for (final p in r.prefixes) p.fullPath], next: r.nextPageToken);
      });
}
