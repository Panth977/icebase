# @panth977/icebase

Firebase's client API — `initializeApp`, `getFirestore`, `query`, `where`, `getAuth`,
`signInWithEmailAndPassword`, `getDatabase`, `getStorage`, `httpsCallable` — with an explicit
schema, declared indexes and a mode per service: `firebase` (the real Firebase SDK, typed and
checked) or `emulator` (the IceBase server on SQLite, from `@panth977/icebase-cli`).

```ts
import { collection as defineCollection, defineSchema, desc, f, index, initializeApp, defineConfig } from '@panth977/icebase';
import { collection, getDocs, orderBy, query, where, getFirestore } from '@panth977/icebase/firestore';

const products = defineCollection('products', {
  fields: { name: f.string(), category: f.enum(['shoes', 'bags']), priceCents: f.number({ int: true }), address: f.optional(f.map({ city: f.string() })) },
  // Every index a query uses is declared, single-field ones too.
  indexes: [index('name'), index('category', desc('priceCents')), index(['address', 'city'])],
});

const config = defineConfig({
  name: 'shop',
  schema: defineSchema({ products }),
  firebase: { projectId: 'shop', webConfigEnv: 'FIREBASE_WEB_CONFIG' },
  environments: { local: { mode: 'emulator' }, prod: { mode: 'firebase' } },
});

const db = getFirestore(initializeApp(config, 'local'));
const cheap = await getDocs(query(collection(db, products), where('category', '==', 'shoes'), orderBy('priceCents', 'desc')));
```

- **Typed.** Documents, query values and writes are typed from the schema; writes are validated at runtime too.
- **Indexes.** A query whose index is not declared is a compile error (`MissingIndex<"category" | "stock">`) and is refused at runtime before it leaves.
- **Key paths.** Nested fields are key arrays (`['address', 'city']`); strings are never split on dots, so `'rating.avg'` is one key.
- **Custom auth.** Sign in with your own email / WhatsApp / SMS senders and Google OAuth client through Firebase's own function names (`sendSignInLinkToEmail`, `signInWithPhoneNumber`, `signInWithPopup`) — see `@panth977/icebase-server/auth`.

Modules: `@panth977/icebase` (app, config, schema) · `/firestore` · `/auth` · `/database` · `/storage` · `/functions` · `/errors`.
Server side: [`@panth977/icebase-server`](https://jsr.io/@panth977/icebase-server). CLI, emulator and management APIs: [`@panth977/icebase-cli`](https://jsr.io/@panth977/icebase-cli).

Source and docs: <https://github.com/Panth977/icebase> · Apache-2.0
