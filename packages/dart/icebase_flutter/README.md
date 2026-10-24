# icebase_flutter

Firebase mode for the [IceBase Dart SDK](../icebase) on Flutter. It provides the IceBase API
(schema checks, declared indexes, custom auth) on top of FlutterFire:

- `cloud_firestore`
- `firebase_auth`
- `firebase_database`
- `firebase_storage`
- `cloud_functions`

```dart
await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);
IceBaseFlutter.register();
final app = IceBaseApp.initialize(icebaseConfig, 'prod');
```

A service whose mode is `emulator` in the environment you chose keeps talking to `icebase dev`.
Only services in `firebase` mode use FlutterFire.

## License

Apache-2.0
