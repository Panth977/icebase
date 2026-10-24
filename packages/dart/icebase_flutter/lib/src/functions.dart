// firebase mode: callable functions over cloud_functions.

import 'package:cloud_functions/cloud_functions.dart' as cf;
import 'package:firebase_core/firebase_core.dart';
import 'package:icebase/icebase.dart';

class FlutterFunctionsDriver implements FunctionsDriver {
  final FirebaseApp app;
  FlutterFunctionsDriver(this.app);

  @override
  Future<Object?> call(String region, String name, Object? data, {Duration? timeout}) async {
    final f = cf.FirebaseFunctions.instanceFor(app: app, region: region);
    try {
      final r = await f.httpsCallable(name, options: cf.HttpsCallableOptions(timeout: timeout ?? const Duration(seconds: 70))).call<Object?>(data);
      return r.data;
    } on cf.FirebaseFunctionsException catch (e) {
      final d = e.details;
      throw IceBaseException('functions/${e.code}', e.message ?? e.code, details: d is Map ? d.cast<String, Object?>() : {if (d != null) 'details': d});
    }
  }
}
