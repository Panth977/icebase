# icebase (Dart)

The IceBase client SDK for Dart and Flutter. It gives you Firebase's client API — Firestore, Auth,
the Realtime Database, Storage and Functions — with three additions:

- **an explicit schema:** every write is checked against it before it leaves the device;
- **declared indexes:** every index a query needs, single-field ones included, must be
  declared, or the query is refused;
- **a mode per service:** `firebase` or `emulator`.

The schema, indexes and environments live in `icebase.config.ts`, the same file the TypeScript SDK
and the CLI read. Generate the Dart side from it:

```sh
npx icebase gen dart --out lib/icebase.g.dart
```

This writes:

- a typed model class per collection, with `fromMap` and `toMap`;
- `Field` descriptors for queries and updates;
- enums and nested map classes;
- typed `dbPath()` and `filePath()` holders;
- `icebaseConfig`.

## Use

```dart
import 'package:icebase/icebase.dart';
import 'icebase.g.dart';

final app = IceBaseApp.initialize(icebaseConfig, 'local'); // the environment to run
final db = IceBaseFirestore.instanceFor(app);

final shoes = await db
    .collection(Products.type)
    .where(Products.category, isEqualTo: ProductCategory.shoes) // index('category') is declared
    .orderBy(Products.priceCents)
    .get();

await db.collection(Products.type).doc('p1').update({Products.stock: FieldValue.increment(-1)});

final auth = IceBaseAuth.instanceFor(app);
await auth.signInWithEmailAndPassword(email: 'ann@example.com', password: '…');

final messages = IceBaseDatabase.instanceFor(app).list(Messages.type, ['room1']);
await messages.push(Message(text: 'hi', at: 0, by: auth.currentUser!.uid));

final avatar = IceBaseStorage.instanceFor(app).file(Avatars.def, [uid, 'me.png']);
await avatar.putData(bytes, const SettableMetadata(contentType: 'image/png'));

final sum = await IceBaseFunctions.instanceFor(app).httpsCallable('add').call<Map<String, Object?>>({'a': 1, 'b': 2});
```

Field paths are always lists of keys, never dotted strings. That is why a key may contain a `.`,
for example `Products.ratingAvg` for the key `'rating.avg'`.

## Modes

- **emulator:** built into this package. Run `npx icebase dev` and the SDK talks to it.
- **firebase:** add [`icebase_flutter`](../icebase_flutter), call `Firebase.initializeApp(…)`,
  then `IceBaseFlutter.register()`.

## Custom auth

You can let IceBase run a sign-in method itself (`config.auth.custom`): your email or SMTP account,
your WhatsApp or SMS sender, your own Google OAuth client. The standard calls then go through your
senders and end in a normal Firebase session:

- `sendPasswordResetEmail`
- `signInWithPhoneNumber`
- `sendSignInLinkToEmail`

The step-by-step flows are `auth.customEmailAuth` (approval, link or code) and
`auth.customGoogleOAuth`.

## License

Apache-2.0
