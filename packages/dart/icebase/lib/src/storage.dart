// Cloud Storage with firebase_storage's names, over the filePath() declarations of the schema.
// Uploads are checked against the declared path (content type, size) before they leave.

import 'dart:convert';
import 'dart:typed_data';

import 'app.dart';
import 'emulator/storage.dart';
import 'errors.dart';
import 'schema.dart';

class SettableMetadata {
  final String? contentType;
  final String? cacheControl;
  final String? contentDisposition;
  final String? contentEncoding;
  final String? contentLanguage;
  final Map<String, String>? customMetadata;
  const SettableMetadata({this.contentType, this.cacheControl, this.contentDisposition, this.contentEncoding, this.contentLanguage, this.customMetadata});

  Map<String, Object?> toJson() => {
        if (contentType != null) 'contentType': contentType,
        if (cacheControl != null) 'cacheControl': cacheControl,
        if (contentDisposition != null) 'contentDisposition': contentDisposition,
        if (contentEncoding != null) 'contentEncoding': contentEncoding,
        if (contentLanguage != null) 'contentLanguage': contentLanguage,
        if (customMetadata != null) 'metadata': customMetadata,
      };
}

class FullMetadata {
  final String bucket;
  final String fullPath;
  final int size;
  final String? contentType;
  final String? md5Hash;
  final String? generation;
  final DateTime? timeCreated;
  final DateTime? updated;
  final String? cacheControl;
  final String? contentDisposition;
  final Map<String, String> customMetadata;
  const FullMetadata(
      {required this.bucket,
      required this.fullPath,
      required this.size,
      this.contentType,
      this.md5Hash,
      this.generation,
      this.timeCreated,
      this.updated,
      this.cacheControl,
      this.contentDisposition,
      this.customMetadata = const {}});
  String get name => fullPath.substring(fullPath.lastIndexOf('/') + 1);
}

class ListResult {
  final List<StorageReference> items;
  final List<StorageReference> prefixes;
  final String? nextPageToken;
  const ListResult(this.items, this.prefixes, this.nextPageToken);
}

/// What a Storage backend must do; [IceBaseStorage] checks the schema first.
abstract interface class StorageDriver {
  Future<FullMetadata> upload(String path, Uint8List data, SettableMetadata? metadata);
  Future<Uint8List> download(String path, int maxSize);
  Future<FullMetadata> getMetadata(String path);
  Future<FullMetadata> updateMetadata(String path, SettableMetadata metadata);
  Future<void> delete(String path);
  Future<String> downloadUrl(String path);
  Future<({List<String> items, List<String> prefixes, String? next})> list(String prefix, {int? maxResults, String? pageToken});
}

/// firebase_storage's FirebaseStorage.
class IceBaseStorage {
  final IceBaseApp app;
  final StorageDriver driver;
  IceBaseStorage._(this.app, this.driver);

  static IceBaseStorage instanceFor(IceBaseApp app) => app.single('storage:api', () => IceBaseStorage._(app, app.driver<StorageDriver>('storage', () => EmulatorStorageDriver(app))));
  static IceBaseStorage get instance => instanceFor(IceBaseApp.instance());

  String get bucket => app.config.storageBucket ?? '${app.config.projectId}.appspot.com';

  /// A declared file: file(Avatars.def, [uid, 'me.png']).
  StorageReference file(FilePathDef fp, List<String> params) {
    if (!app.config.schema.files.contains(fp)) {
      throw IceBaseException('invalid-argument', "filePath('${fp.path}') is not in this app's schema", reason: 'unknown-collection', details: {'service': 'storage'});
    }
    final n = fp.path.split('/').where((s) => s.startsWith('{')).length;
    if (params.length != n) throw IceBaseException('invalid-argument', "file('${fp.path}'): needs $n path parameter(s), got ${params.length}", reason: 'schema', details: {'service': 'storage'});
    var i = 0;
    final path = fp.path.split('/').map((s) {
      if (!s.startsWith('{')) return s;
      final v = params[i++];
      if (v.isEmpty || v.contains('/')) {
        throw IceBaseException('invalid-argument', "file('${fp.path}'): parameter $s must be a non-empty string without '/'", reason: 'schema', details: {'service': 'storage'});
      }
      return v;
    }).join('/');
    return StorageReference._(this, path);
  }

  /// A path as is (reads, lists; uploads still need a declared path).
  StorageReference ref([String path = '']) => StorageReference._(this, path.replaceAll(RegExp(r'^/+|/+$'), ''));
}

class StorageReference {
  final IceBaseStorage storage;
  final String fullPath;
  StorageReference._(this.storage, this.fullPath);

  String get name => fullPath.substring(fullPath.lastIndexOf('/') + 1);
  String get bucket => storage.bucket;
  StorageReference? get parent => fullPath.isEmpty ? null : StorageReference._(storage, fullPath.contains('/') ? fullPath.substring(0, fullPath.lastIndexOf('/')) : '');
  StorageReference child(String path) => storage.ref(fullPath.isEmpty ? path : '$fullPath/$path');

  void _check(int? size, String? contentType) {
    final files = storage.app.config.schema.files;
    if (files.isEmpty) return;
    FilePathDef? fp;
    for (final f in files) {
      if (f.matches(fullPath)) fp = f;
    }
    if (fp == null) {
      throw IceBaseException('invalid-argument', "upload to '$fullPath': the path matches no filePath(…) in the schema (${files.map((f) => "'${f.path}'").join(', ')})",
          reason: 'schema', details: {'service': 'storage'});
    }
    if (fp.maxBytes != null && size != null && size > fp.maxBytes!) {
      throw IceBaseException('invalid-argument', "upload to '$fullPath': $size bytes is over the ${fp.maxBytes} allowed for '${fp.path}'", reason: 'schema', details: {'service': 'storage'});
    }
    if (fp.contentTypes.isNotEmpty) {
      final ok = contentType != null && fp.contentTypes.any((p) => p.endsWith('/*') ? contentType.startsWith(p.substring(0, p.length - 1)) : contentType == p);
      if (!ok) {
        throw IceBaseException('invalid-argument', "upload to '$fullPath': content type ${contentType ?? '(none)'} is not one of ${fp.contentTypes.join(', ')}",
            reason: 'schema', details: {'service': 'storage'});
      }
    }
  }

  Future<FullMetadata> putData(Uint8List data, [SettableMetadata? metadata]) {
    _check(data.length, metadata?.contentType);
    return storage.driver.upload(fullPath, data, metadata);
  }

  Future<FullMetadata> putString(String text, {SettableMetadata? metadata}) => putData(utf8.encode(text), metadata ?? const SettableMetadata(contentType: 'text/plain'));

  /// The bytes (at most [maxSize], 10 MB by default as in firebase_storage).
  Future<Uint8List> getData([int maxSize = 10485760]) => storage.driver.download(fullPath, maxSize);
  Future<String> getDownloadURL() => storage.driver.downloadUrl(fullPath);
  Future<FullMetadata> getMetadata() => storage.driver.getMetadata(fullPath);
  Future<FullMetadata> updateMetadata(SettableMetadata metadata) {
    if (metadata.contentType != null) _check(null, metadata.contentType);
    return storage.driver.updateMetadata(fullPath, metadata);
  }

  Future<void> delete() => storage.driver.delete(fullPath);

  Future<ListResult> list({int? maxResults, String? pageToken}) async {
    final r = await storage.driver.list(fullPath.isEmpty ? '' : '$fullPath/', maxResults: maxResults, pageToken: pageToken);
    return ListResult([for (final i in r.items) storage.ref(i)], [for (final p in r.prefixes) storage.ref(p)], r.next);
  }

  Future<ListResult> listAll() async {
    final items = <StorageReference>[];
    final prefixes = <StorageReference>[];
    String? token;
    do {
      final r = await list(pageToken: token);
      items.addAll(r.items);
      prefixes.addAll(r.prefixes);
      token = r.nextPageToken;
    } while (token != null);
    return ListResult(items, prefixes, null);
  }

  @override
  String toString() => 'gs://$bucket/$fullPath';
}
