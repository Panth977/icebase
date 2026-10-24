# IceBase

Firebase's API with an explicit schema, declared composite indexes, and a local emulator
that enforces both — so you can build on Firebase without being locked into it.

```ts
import { collection, getDocs, orderBy, query, where } from 'icebase/firestore';
import { db } from './lib/icebase';
import { products } from '../icebase/schema';

const q = query(collection(db, products), where('category', '==', 'shoes'), orderBy('priceCents'));
const snap = await getDocs(q);           // snap.docs[0].data() is typed from the schema
```

- **Same API as Firebase.** `icebase/firestore`, `icebase/auth`, `icebase/database`,
  `icebase/storage`, `icebase/functions` and `icebase/functions/v2` keep Firebase's function
  names and call shapes. `icebase/admin` is firebase-admin's counterpart.
- **Schema.** Every collection, Realtime Database path and storage path is declared once.
  Writes are type-checked at compile time and validated at runtime in every mode; reads are typed.
- **Composite indexes are declared.** A query that needs an undeclared composite index is a
  *compile error* (`MissingCompositeIndex<"category" | "stock">`), and is refused at runtime
  before it leaves — in every mode, including the emulator. `icebase indexes check` lists
  every such query for CI.
- **Firebase rules.** `firestore.rules`, `storage.rules` and `database.rules.json` in Firebase's
  own syntax: deployed unchanged to Firebase, enforced by IceBase in the emulator.
- **Modes per service.** `firebase` (the real Firebase), `emulator` (the IceBase server on
  SQLite, for development and CI), and later `vm` (the same server on Postgres, self-hosted).
- **No auth lock-in.** Custom email, phone and Google sign-in with your own SMTP / WhatsApp /
  SMS / OAuth client, even in firebase mode — the session afterwards is a normal Firebase one.
- **Set a project up from code.** `icebase/manage` creates databases and buckets, deploys
  indexes and rules, enables sign-in providers, deploys hosting and connects domains.

## Start

```sh
npm i icebase firebase firebase-admin firebase-functions
npx icebase init            # icebase.config.ts, schema, rules, functions, src/lib/icebase.ts
npx icebase dev             # the emulator for every service in emulator mode, hosting, seed
npx icebase deploy --env prod
```

`icebase.config.ts` is the one config: schema, rules files, functions, hosting, auth, and per
environment which mode each service runs in.

```ts
export default defineConfig({
  name: 'acme-shop',
  schema,
  rules: { firestore: 'icebase/rules/firestore.rules', storage: 'icebase/rules/storage.rules' },
  functions: { source: 'icebase/functions' },
  hosting: { public: 'dist', spa: true, rewrites: [{ source: '/api/**', function: 'api' }] },
  firebase: { projectId: 'acme-shop', webConfigEnv: 'FIREBASE_WEB_CONFIG' },
  environments: {
    local: { mode: 'emulator' },
    prod: { mode: 'firebase' },
  },
});
```

## CLI

| Command | What it does |
| --- | --- |
| `icebase init [--import DIR] [--project ID --sample N]` | Create the project structure; import an existing Firebase project's rules and indexes, and draft a schema from sampled documents |
| `icebase dev [--env X]` | The IceBase emulator (Firestore, Auth, Realtime Database, Storage, Functions, custom auth) on one port, hosting on another, the seed script on an empty database, reloads on change |
| `icebase deploy --env X [--only …]` | Firestore indexes/TTL/exemptions from the schema, rules, auth providers, functions (bundled, with the custom-auth endpoint), hosting |
| `icebase indexes check` | Every query that needs an undeclared composite index, with file:line (exit 1 if any) |
| `icebase drivers --env X` | The mode of each service and the wiring problems between them |
| `icebase login` | Firebase login; deploy and the management APIs use it |

## Status

Phase 1 (firebase + emulator mode) for the services in
[`docs/prd/phase1-api-cut.html`](docs/prd/phase1-api-cut.html). The console GUI comes next;
vm mode (Postgres) is phase 3. See [`docs/prd/icebase-prd.html`](docs/prd/icebase-prd.html).

## License

Apache-2.0
