# IceBase

Firebase's API with an explicit schema, declared composite indexes, and a local emulator
that enforces both — so you can build on Firebase without being locked into it.

```ts
import { collection, getDocs, orderBy, query, where } from '@panth977/icebase/firestore';
import { db } from './lib/icebase';
import { products } from '../icebase/schema';

const q = query(collection(db, products), where('category', '==', 'shoes'), orderBy('priceCents'));
const snap = await getDocs(q);           // snap.docs[0].data() is typed from the schema
```

- **Same API as Firebase.** `@panth977/icebase/firestore`, `@panth977/icebase/auth`, `@panth977/icebase/database`,
  `@panth977/icebase/storage`, `@panth977/icebase/functions` and `@panth977/icebase-server/functions` keep Firebase's function
  names and call shapes. `@panth977/icebase-server/admin` is firebase-admin's counterpart.
- **Schema.** Every collection, Realtime Database path and storage path is declared once.
  Writes are type-checked at compile time and validated at runtime in every mode; reads are typed.
- **Every index is declared.** Single-field and composite: `index('stock')`,
  `index('category', desc('priceCents'))`. A query whose index is not declared is a *compile
  error* (`MissingIndex<"category" | "stock">`) and is refused at runtime before it leaves — in
  every mode. The emulator indexes exactly what is declared; firebase mode stops indexing the
  rest. `icebase indexes check` lists every such query for CI.
- **Key paths, never dots.** Nested fields are key arrays (`where(['address', 'city'], …)`,
  `updateDoc(ref, ['address', 'city'], 'Pune')`); `'rating.avg'` is one key.
- **Firebase rules.** `firestore.rules`, `storage.rules` and `database.rules.json` in Firebase's
  own syntax: deployed unchanged to Firebase, enforced by IceBase in the emulator.
- **Modes per service.** `firebase` (the real Firebase), `emulator` (the IceBase server on
  SQLite, for development and CI), and later `vm` (the same server on Postgres, self-hosted).
- **No auth lock-in.** Custom email, phone and Google sign-in with your own SMTP / WhatsApp /
  SMS / OAuth client, even in firebase mode — the session afterwards is a normal Firebase one.
- **Set a project up from code.** `@panth977/icebase-cli/manage` creates databases and buckets, deploys
  indexes and rules, enables sign-in providers, deploys hosting and connects domains.

## Start

Three packages on JSR: [`@panth977/icebase`](https://jsr.io/@panth977/icebase) (client),
[`@panth977/icebase-server`](https://jsr.io/@panth977/icebase-server) (admin, functions, custom-auth
endpoint) and [`@panth977/icebase-cli`](https://jsr.io/@panth977/icebase-cli) (CLI, management
APIs, emulator).

```sh
deno run -A jsr:@panth977/icebase-cli/cli init     # icebase.config.ts, schema, rules, functions, deno.json
deno run -A --unstable-sloppy-imports --config deno.json jsr:@panth977/icebase-cli/cli dev
deno run -A --unstable-sloppy-imports --config deno.json jsr:@panth977/icebase-cli/cli deploy --env prod
```

In a Node project: `npx jsr add @panth977/icebase @panth977/icebase-server` (plus `firebase`,
`firebase-admin`, `firebase-functions`).

For Dart and Flutter: [`packages/dart/icebase`](packages/dart/icebase) (the client SDK; emulator
mode built in) and [`packages/dart/icebase_flutter`](packages/dart/icebase_flutter) (firebase
mode over FlutterFire). `icebase gen dart` writes the typed models, fields and config from
`icebase.config.ts`.

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

## Moving an existing firebase-admin codebase

`@panth977/icebase-server/compat` is firebase-admin's Firestore API over IceBase:

- `collection('a').doc('b').get()`
- `where('counts.open', '>', 0)`
- `FieldValue.increment(1)`
- batches, transactions and `bulkWriter`
- numeric gRPC error codes

Every call still goes through IceBase. Each write is checked against the schema, each query
needs its indexes declared, and the backend is whatever mode the environment picks.

- **Declaring an existing schema:** `fromZod(Schema)` / `zodDocument(Schema)` (from
  `@panth977/icebase/zod`) turn existing zod schemas into IceBase fields.
- **Field types for real data:**
  - `f.record` for maps keyed by ids
  - `f.union`
  - `f.literal`
  - `f.nullable`
  - `f.any`
  - open documents (`rest`)
- **Discovering what the codebase needs:** learning mode (`getFirestore(app, { learn })`)
  reports every undeclared collection, missing index and non-matching write instead of refusing
  it. Run the test suite once in that mode to collect them.
- **Data whose shape users define:** collections such as `'artifacts/{a}/db/{path=**}'` with
  `autoIndex: true`.
- **Keys that are data:** index paths may use `'*'` for them (`index(['members', '*'])`).

**npm projects that install IceBase from JSR** (npm.jsr.io): the JSR build lists the
Firebase SDKs as dependencies. Keep one copy of each: pin them to the app's own with
overrides, e.g. pnpm's `"@jsr/panth977__icebase-server>firebase-admin": "^14.4.0"`. Two copies
of firebase-admin cannot share an app.

`startEmulator({ listen: false, name })` runs the IceBase server inside a backend process with
no port. Admin apps reach it with `{ emulator: { embedded: name, adminToken } }`. A single
VM's backend uses this to keep its data in IceBase (SQLite).

## CLI

| Command | What it does |
| --- | --- |
| `icebase init [--import DIR] [--project ID --sample N]` | Create the project structure; import an existing Firebase project's rules and indexes, and draft a schema from sampled documents |
| `icebase dev [--env X]` | The IceBase emulator (Firestore, Auth, Realtime Database, Storage, Functions, custom auth) on one port, hosting on another, the seed script on an empty database, reloads on change |
| `icebase deploy --env X [--only …]` | Firestore indexes/TTL/exemptions from the schema, rules, auth providers, functions (bundled, with the custom-auth endpoint), hosting |
| `icebase indexes check` | Every query that needs an undeclared composite index, with file:line (exit 1 if any) |
| `icebase drivers --env X` | The mode of each service and the wiring problems between them |
| `icebase gen dart [--out FILE]` | The Dart side of the config: model classes, typed fields, enums, dbPath/filePath holders, the schema and environments |
| `icebase login` | Firebase login; deploy and the management APIs use it |

## Status

Phase 1 (firebase + emulator mode) for the services in
[`docs/prd/phase1-api-cut.html`](docs/prd/phase1-api-cut.html). The console GUI comes next;
vm mode (Postgres) is phase 3. See [`docs/prd/icebase-prd.html`](docs/prd/icebase-prd.html).

## License

Apache-2.0
