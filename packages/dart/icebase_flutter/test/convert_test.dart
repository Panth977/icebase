import 'dart:typed_data';

import 'package:cloud_firestore/cloud_firestore.dart' as fs;
import 'package:flutter_test/flutter_test.dart';
import 'package:icebase/icebase.dart';
import 'package:icebase_flutter/icebase_flutter.dart';

void main() {
  test('Firestore values round-trip through cloud_firestore types', () {
    final v = {
      'at': Timestamp(1700000000, 5),
      'geo': GeoPoint(1.5, -2.5),
      'bytes': Uint8List.fromList([1, 2, 3]),
      'list': [Timestamp(1, 0), 'x'],
      'nested': {'n': 1},
    };
    final native = fromNative({
      'at': fs.Timestamp(1700000000, 5),
      'geo': const fs.GeoPoint(1.5, -2.5),
      'bytes': fs.Blob(Uint8List.fromList([1, 2, 3])),
      'list': [fs.Timestamp(1, 0), 'x'],
      'nested': {'n': 1},
    });
    expect(native, v);
  });
}
