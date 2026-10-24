/// IceBase for Dart: Firebase's client API with an explicit schema, declared indexes and modes
/// per service. Generate your project's types with `icebase gen dart`.
library;

export 'src/app.dart' show IceBaseApp, IceBaseConfig, CustomAuthInfo, DriverFactory;
export 'src/errors.dart';
export 'src/values.dart';
export 'src/schema.dart';
export 'src/firestore.dart';
export 'src/auth.dart';
export 'src/database.dart' hide RawDbSnapshot, DbQuery, DbDisconnect, pushId;
export 'src/storage.dart';
export 'src/functions.dart' hide EmulatorFunctionsDriver;
