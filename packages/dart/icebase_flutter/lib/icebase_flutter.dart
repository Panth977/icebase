/// Firebase mode for the IceBase Dart SDK on Flutter: the IceBase API (schema, declared indexes,
/// validation) over FlutterFire.
///
/// ```dart
/// await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
/// IceBaseFlutter.register();
/// final app = IceBaseApp.initialize(icebaseConfig, 'prod');
/// ```
library;

import 'package:cloud_firestore/cloud_firestore.dart' as fs;
import 'package:firebase_auth/firebase_auth.dart' as fa;
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_database/firebase_database.dart' as rt;
import 'package:firebase_storage/firebase_storage.dart' as st;
import 'package:icebase/icebase.dart';

import 'src/auth.dart';
import 'src/database.dart';
import 'src/firestore.dart';
import 'src/functions.dart';
import 'src/storage.dart';

export 'src/firestore.dart' show toNative, fromNative;

abstract final class IceBaseFlutter {
  /// Register the FlutterFire drivers for firebase mode. [firebaseApp] picks the FirebaseApp
  /// for each IceBase app (default: Firebase.app()).
  static void register({FirebaseApp Function(IceBaseApp app)? firebaseApp}) => IceBaseApp.registerDrivers('firebase', _Factory(firebaseApp ?? (_) => Firebase.app()));
}

class _Factory implements DriverFactory {
  final FirebaseApp Function(IceBaseApp) _app;
  _Factory(this._app);

  @override
  Object create(IceBaseApp app, String service) {
    final fb = _app(app);
    final c = app.config;
    return switch (service) {
      'firestore' => FlutterFirestoreDriver(fs.FirebaseFirestore.instanceFor(app: fb)),
      'auth' => FlutterAuth(app, fa.FirebaseAuth.instanceFor(app: fb)),
      'database' => FlutterDatabaseDriver(c.databaseUrl == null ? rt.FirebaseDatabase.instanceFor(app: fb) : rt.FirebaseDatabase.instanceFor(app: fb, databaseURL: c.databaseUrl)),
      'storage' => FlutterStorageDriver(c.storageBucket == null ? st.FirebaseStorage.instanceFor(app: fb) : st.FirebaseStorage.instanceFor(app: fb, bucket: 'gs://${c.storageBucket}')),
      'functions' => FlutterFunctionsDriver(fb),
      _ => throw IceBaseException('unimplemented', '$service has no firebase-mode driver', reason: 'mode'),
    };
  }
}
