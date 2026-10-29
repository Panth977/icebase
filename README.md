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
  SQLite, for development and CI), and `vm` (the same server on Postgres, self-hosted).
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

## The API's schema, declared like the database's

Every endpoint is declared in `icebase/api`: a callable or an HTTP route, with its input, its
output and the errors it may answer. The field types are the same as the database schema's, and
most can be taken straight from it: `docOf(collection)`, `pick(collection, ['a', 'b'])`,
`fieldOf(collection, path)`, `partial(…)`, `listOf(…)`.

```ts
export const api = defineApi({
  getProduct: endpoint({
    http: { method: 'GET', path: '/products/{id}' },
    input: f.map({ id: f.string() }),
    output: docOf(products),
    errors: { 'not-found': 'No product with that id' },
    auth: 'none',
  }),
  cancelOrder: endpoint({ input: f.map({ orderId: f.string() }), output: f.map({ ok: f.literal(true) }) }),
});
// server:  export const getProduct = onRequest(api.getProduct, async ({ input }) => …);
//          export const cancelOrder = onCall(api.cancelOrder, async (req) => …);
// client:  await request(getFunctions(app), api.getProduct, { id });   await callable(fns, api.cancelOrder)({ orderId });
// Dart:    await IceBaseFunctions.instance.call(Api.getProduct, ProductByIdInput(id: 'p1'));
```

- **Runtime validation, both sides:** the input is checked before it leaves and again on the
  server. The output is checked on the server (a mismatch is an `internal` error) and again on
  the client.
- **Types on the wire:** timestamps, references and geopoints travel as JSON and arrive typed.
  Types are inferred, so nothing is written twice.
- **`icebase check`:** a dry run. It verifies the declarations agree with each other, every
  declared endpoint is implemented under its name, and every implemented function is declared
  (`--strict` turns an undeclared callable into an error).
- **`icebase docs [--serve]`:** a browsable reference of the database and the API in one
  self-contained page. It covers:
  - collections, with their fields, indexes and a sample document
  - Realtime Database paths and storage paths
  - endpoints, with input and output tables, errors, examples, and TypeScript / Dart / curl snippets

  Next to the page it writes `project.json` and `openapi.json`.
- **`icebase openapi`:** OpenAPI 3.1 for any other language's generator.
- **`icebase gen dart`:** typed `Api.*` endpoints for Dart and Flutter.

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

## Running a Firebase app on the IceBase server

`icebase serve` is the IceBase server for production, on one port (PORT, default 8080):
every service, the functions and `config.hosting`. Function rewrites run in the same process.

- **Tokens:** ID tokens are signed (HMAC; the key stays in the data directory).
- **Admin token:** `ICEBASE_ADMIN_TOKEN`, or one made once and kept in `DATA/admin-token`.
  The emulator's well-known `owner` is refused.
- **Locked down:** with no rules file, only the admin reads and writes, as on a live Firebase
  project. The emulator's open doors are admin only: account deletion, out-of-band links, the
  GCS API and `/emulator/*`.
- **Hosting:** files are cached and compressed (brotli / gzip) with ETags. Hashed assets get
  long cache headers. Rewrites use firebase.json's form, including `{ functionId, region }` and
  `!` globs.
- **Auth emails:** a `sendAuthEmail({ kind, to, link })` export in the functions source mails
  sign-in, reset, verify and change-email links. The links go straight to the app's
  `continueUrl`.
- **Storage:** `getSignedUrl` works without a service account (the server signs, on
  `ICEBASE_PUBLIC_URL`). Range requests and `file.copy()` work too.
- **Realtime Database over REST:** `GET /__/icebase/rtdb/{path}.json?auth=<ID token>` answers the value,
  or streams it with `Accept: text/event-stream` (Firebase's protocol: `put`, `keep-alive`,
  `auth_revoked`).
- **Moving users in:** `importAuthUsers(app, users)` keeps uids. Passwords hashed as
  `scrypt$N$r$p$salt$key` keep working.

The web app keeps Firebase's modular API:

- **Firestore and the Realtime Database:** alias `firebase/firestore` and `firebase/database`
  to `@panth977/icebase/compat/firestore` and `@panth977/icebase/compat/database`. Paths are
  strings; the server checks the schema, the indexes and the rules.
- **Auth and Storage:** keep Firebase's own SDKs, aimed at the page's origin
  (`connectAuthEmulator(auth, location.origin)`).
- **Wiring:** `configureIceBase({ idToken })` hands the signed-in user's token to the compat
  modules; `refreshIceBaseAuth()` re-runs open listeners when it changes.

Behind a proxy that upgrades WebSockets on one path only: `emulator: { socketPath: '/live' }` in the
config, and `configureIceBase({ socketPath: '/live' })` in the web app.

Debugging: `ICEBASE_LOG_ERRORS=1` logs every refused or failed request and listener;
`ICEBASE_LOG_REQUESTS=1` logs every request.

## vm mode: the IceBase server on Postgres

The same server keeps its data in Postgres instead of SQLite files: one schema per store
(`icebase_firestore`, `icebase_auth`, `icebase_storage`, `icebase_tasks`, `icebase_database`,
and one per named Firestore database or RTDB instance) in one database. The protocol is the
emulator's, so an environment in `vm` mode reaches the server at `vm.url` exactly as emulator
mode reaches `icebase dev`, and services mix with `firebase` per service.

```ts
export default defineConfig({
  // …
  vm: { url: 'https://app.example.com', databaseUrlEnv: 'DATABASE_URL', blobs: { kind: 'disk', dir: '/data/blobs' } },
  environments: { prod: { mode: 'vm' }, local: { mode: 'emulator' } },
});
```

- **Serving:** `icebase serve --env prod` on the VM reads the connection string from the env var
  `vm.databaseUrlEnv` names (it refuses to start without it). Any server also takes
  `ICEBASE_DATABASE_URL` (or `startEmulator({ databaseUrl })`); `ICEBASE_DATABASE_PREFIX` changes the
  schema prefix (default `icebase_`) so several deployments can share a database.
- **The data directory stays:** the signing key, the admin token, hosting releases and, with
  `blobs: { kind: 'disk' }` (the default is `DATA/storage`), the stored files. `blobs: { kind: 's3' }`
  is not built yet.
- **Semantics:** a Firestore commit takes a per-store advisory lock, as SQLite's write lock:
  transactions, batches, versions and the realtime feed behave the same. Strings order by code point
  (`COLLATE "C"`), as Firestore's do. One server process per database (listeners are in-process).
- **Migrating:** `icebase migrate --from sqlite:.icebase --to env:DATABASE_URL` copies every store
  (documents with their versions and times, users with their password hashes, RTDB trees, storage
  metadata, queued tasks); `--from env:DATABASE_URL --to sqlite:DIR` goes back. Stop the server first;
  the target must be empty unless `--replace`. Stored files are not copied: keep the data directory.
- **Tests:** `npm run test:pg` runs every IceBase-server suite on Postgres (`ICEBASE_PG_URL`, default
  `postgres://postgres:pg@127.0.0.1:55432/postgres`, e.g.
  `docker run -d --name icebase-pg-test -e POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16`).
  The `pg` package is imported only when a Postgres URL is given.

## CLI

| Command | What it does |
| --- | --- |
| `icebase init [--import DIR] [--project ID --sample N]` | Create the project structure; import an existing Firebase project's rules and indexes, and draft a schema from sampled documents |
| `icebase serve [--env X] [--port N] [--data DIR]` | Production server on one port: every service, the functions and hosting; signed tokens; locked down. SQLite in DIR, or Postgres for a vm environment |
| `icebase migrate --from SRC --to DST [--replace]` | Copy the server's data between SQLite (`sqlite:DIR`) and Postgres (`postgres://…`, `env:NAME`), either way |
| `icebase dev [--env X]` | The IceBase emulator (Firestore, Auth, Realtime Database, Storage, Functions, custom auth) on one port, hosting on another, the seed script on an empty database, reloads on change |
| `icebase deploy --env X [--only …]` | Firestore indexes/TTL/exemptions from the schema, rules, auth providers, functions (bundled, with the custom-auth endpoint), hosting |
| `icebase indexes check` | Every query that needs an undeclared composite index, with file:line (exit 1 if any) |
| `icebase drivers --env X` | The mode of each service and the wiring problems between them |
| `icebase gen dart [--out FILE]` | The Dart side of the config: model classes, typed fields, enums, dbPath/filePath holders, the schema and environments |
| `icebase check [--strict]` | Dry run: the schema and API declarations agree, and every endpoint is implemented |
| `icebase docs [--out DIR] [--serve]` | The database + API reference (one HTML page, project.json, openapi.json) |
| `icebase openapi [--out FILE]` | The declared endpoints as OpenAPI 3.1 |
| `icebase console --env X [--port N]` | The console on this machine for environment X (on the IceBase server it is also at `/__/icebase/console`, admin only) |
| `icebase login` | Firebase login; deploy and the management APIs use it |

## Console

One web app for every mode: project overview (mode per service, health, secrets by env-var name),
Firestore browser and editor (writes go through the schema), a query runner that only runs what the
declared indexes allow, schema and indexes (build state on Firebase, SQL indexes on the IceBase
server), the Realtime Database tree, users and sign-in methods with custom auth's security view
(attempts, blocks, limits), a Storage browser, functions (run a schedule now, the task queue),
Hosting sites and domains, and the rules in force. It opens with `ICEBASE_CONSOLE_TOKEN` (set it in the
server's environment; the console-only token reaches no data service) or the admin token.

## Indexes, as Firestore really checks them

Checked on a live project: a composite index serves only the directions it was declared with
(`orderBy('x', 'desc')` needs `desc('x')`), `limitToLast` needs the reversed index, and `sum()` /
`average()` fields are part of the index. IceBase refuses the same queries before they leave, and
on the IceBase server, so an index that works locally works on Firebase.

## Management APIs in every mode

`icebase/manage` sets a project up from code on Firebase and on the IceBase server alike:
`createDb` (named Firestore databases and Realtime Database instances), `setSchema` / `setIndexes`
(`wait: true` until every index is READY), `setRules`, `createBucket`, `setProviders`,
`setAuthorizedDomains`, `createSite`, `deploy`, `setDNS` (on the IceBase server a custom domain
serves its site on the same port).

Custom auth's admin side: `getAuthSecurity(app)` (`listAttempts`, `resetLimits`, `unblock`,
`cleanup`), `linkCustomIdentity` / `unlinkCustomIdentity`, an audit trail of starts, failures,
blocks and sign-ins, cleaned daily by `icebaseAuthCleanup`.

## Status

Phase 1 (firebase + emulator mode, and the console) for the services in
[`docs/prd/phase1-api-cut.html`](docs/prd/phase1-api-cut.html) is complete. The conformance suites
run against Firebase's emulators, the IceBase server and a live project
(`ICEBASE_LIVE_PROJECT=icebase-test-… npx vitest run live/` in `packages/tests`). Phase 3, vm mode:
the IceBase server on Postgres, `icebase migrate` both ways and vm mode in the SDK are built, and every
IceBase-server suite passes on Postgres (`npm run test:pg`); the Docker image, login / deploy to a VM,
backups and S3 blobs are not yet. See [`docs/prd/icebase-prd.html`](docs/prd/icebase-prd.html).

## License

Apache-2.0
