# IceBase

IceBase is a Firebase wrapper with Firebase's own API names that lets an app move off
Firebase without a rewrite. Apps import `icebase/*` instead of `firebase/*`; a single
`icebase.config.ts` declares the schema, composite indexes, rules, functions, hosting and,
per environment, which **mode** each service runs in: `firebase` (real Firebase SDKs plus
type / schema / index checks), `emulator` (local IceBase server on SQLite) and, later, `vm`
(same server on Postgres, one Docker image).

GitHub: <https://github.com/Panth977/icebase> (public). License: Apache-2.0.

## Read first

- `docs/prd/icebase-prd.html` — the PRD (rev 8). Schema DSL §6, index rules §7, rules §8,
  the verified type-level design §9 and the example app in the appendix.
- `docs/prd/phase1-api-cut.html` — **the phase-1 scope, approved by Panth 2026-10-24.**
  Only those APIs. Anything not on it is out until Panth says otherwise.
- `docs/prd/custom-auth.html` — custom email / phone / Google OAuth with your own senders,
  even in firebase mode (Panth, 2026-10-24). Reference implementation:
  `~/Dev/VDP/backend/functions/src/` (`challenge.ts`, `limits.ts`, `policy-limits.ts`,
  `whatsapp.ts`, `email.ts`, `sessions.ts`, the `auth*` endpoints in `index.ts`). Read it,
  never edit it.

## Phase 1 decisions (Panth, 2026-10-24)

- Services: app, auth (+ custom auth), Firestore, Realtime Database, Storage, Hosting, and
  the minimum of Functions (`httpsCallable`, `onCall`, `onRequest`, document triggers,
  `onSchedule`).
- Each service also gets IceBase's management APIs (`createDb`, `setSchema`, `setIndexes`,
  `setRules`, `createBucket`, `createSite`, `deploy`, `setDNS`, `setProviders`) so a project
  can be set up from code instead of the Firebase console.
- Modes in phase 1: **firebase and emulator** (SQLite). vm mode is phase 3 — started 2026-10-29
  (branch `phase3-postgres`): the server on Postgres, `icebase migrate`, vm mode in the SDK; see below.
- Console GUI comes after the SDK and CLI. Done 2026-10-28 (v1): `packages/cli/src/console/` —
  `api.ts` (operations over the admin APIs), `page.ts` (plain DOM, strict CSP), served by the
  server at `/__/icebase/console` and by `icebase console --env X`. Not yet: logs tail, usage/cost,
  rules playground, import/export. Remote Config / Messaging / App Check pages came with phase 4.
- Firebase names and call shapes exactly. No new query language. Typed from the schema.

## Build order (worked on ORCH-26, no separate board)

1. Foundation: package layout and subpath exports, schema DSL + runtime validator,
   type-level composite-index check (`MissingCompositeIndex`), `defineConfig`, mode router,
   `example-app/` that type-checks (PRD §9 and appendix).
2. Firestore — firebase mode (client + admin + management).
3. Auth — firebase mode (client + admin + `setProviders`).
4. Custom auth — firebase mode (`custom-auth.html`).
5. Realtime Database — firebase mode.
6. Storage — firebase mode.
7. Functions — firebase mode.
8. Hosting — management APIs + deploy.
9. CLI: `icebase init`, `icebase deploy --env X`, `icebase indexes check`.
10. Emulator server: gateway, SQLite document engine, query planner, realtime hub.
11. Emulator rules engine (firestore.rules, storage.rules, database.rules.json).
12. Emulator auth (incl. custom auth), RTDB, storage, functions, hosting; `icebase dev`.
13. Conformance suite: the same tests against firebase mode, the official emulator and the
    IceBase emulator.

## Layout

Three packages, published to JSR (and built to `dist/` for Node):

- `packages/client` — `@panth977/icebase`: app, config, schema, firestore, auth, database,
  storage, functions (client), errors; `drivers/` (firebase web SDK and IceBase emulator per
  service); `internal/` (query planner, wire format, custom-auth client). `./internal` is the
  API the other two packages build on.
- `packages/server` — `@panth977/icebase-server`: admin (firebase-admin drivers), functions
  (firebase-functions v2 wrappers, typed triggers), auth (the custom-auth endpoint, senders,
  templates, store).
- `packages/cli` — `@panth977/icebase-cli`: the `icebase` command (`src/cli`), management
  APIs (`manage.ts`), the emulator server (`src/emulator`: SQLite engine, rules engine, auth /
  database / storage / functions / custom-auth services, hosting).
- `packages/tests` — `*.test.ts` run with no emulator (unit + the IceBase emulator in-process);
  `*.emu.test.ts` need Firebase's emulators; `suites/` hold the shared conformance suites (the
  same assertions against Firebase and IceBase). `fixtures/functions-app` is a functions source.
- `packages/dart/icebase` — the Dart client SDK (pub package `icebase`): the same schema checks,
  index planner and wire format as `packages/client`, emulator drivers for every service built
  in; `src/cli/gen-dart.ts` writes the typed `icebase.g.dart` from a config. Tests start the
  emulator from `tool/emulator.ts` (Node + tsx from this repository).
- `packages/dart/icebase_flutter` — firebase mode for Dart over FlutterFire
  (`IceBaseFlutter.register()`); `pubspec_overrides.yaml` points at the local `icebase`.
- `example-app/` — the PRD's example project; `tsc -p example-app` proves the compile-time
  checks (each `@ts-expect-error` must fail for its stated reason); `scripts/smoke.ts` runs it
  end to end under `icebase dev`.

- `packages/server/src/compat.ts` is the firebase-admin-compatible Firestore. In it, string
  field paths are split on dots, as firebase-admin does. `packages/client/src/zod.ts` holds
  `fromZod`. TaskManager runs on both (ORCH-26, branch `icebase`).

- `packages/client/src/api.ts` declares endpoints (defineApi / endpoint, docOf / pick / fieldOf,
  toWire / fromWire, JSON Schema, samples). `describe.ts` turns the config into the data that
  `cli/docs.ts`, `check.ts`, openapi and gen-dart all use.
- Functions now also cover storage, RTDB, task queue and auth triggers, plus messaging. On the
  IceBase server, services publish events through `ctx.hooks` and functions-service dispatches
  them. Tasks are stored in `tasks.sqlite`.

- Storage engine (phase 3): the services speak SQL through the async `Store` in
  `cli/src/emulator/store.ts` — SQLite (`node:sqlite`, one `<name>.sqlite` per store in the data
  directory) or Postgres (`pg`, imported lazily; one schema `<prefix><name>` per store, named in a
  schema comment). The tables are in `tables.ts`; SQL the two dialects disagree on (JSON, collation,
  catalogs) branches on `store.dialect` (mostly in `firestore-engine.ts`). A transaction is the
  store's only writer (SQLite `BEGIN IMMEDIATE` + an in-process gate; Postgres an advisory lock per
  schema). Rules' `get()` reads documents through `RulesRequest.load` (async, re-evaluated until no
  new document is asked for). Postgres when `ICEBASE_DATABASE_URL` / `startEmulator({ databaseUrl })`
  is set, or `serve --env` of a vm environment (`vm.databaseUrlEnv`); a ':memory:' server on Postgres
  gets throwaway schemas. `icebase migrate` (`migrate.ts`) copies stores either way. `npm run test:pg`
  (`ICEBASE_PG_URL`) runs every suite on Postgres; `postgres.icebase.test.ts` covers ordering,
  concurrent commits, migrate and vm mode. Not built: Docker image, deploy to a VM, backups, S3 blobs,
  cross-process listeners (LISTEN/NOTIFY).

- Phase 4 (branch `phase4-services`, 2026-10-29): Remote Config, Cloud Messaging, App Check. Services
  `remoteConfig`, `messaging`, `appCheck` in `config.SERVICES` (own mode per environment; gen-dart leaves
  them out). Declarations: `remoteConfig.parameters` (`param.*` in config.ts), `messaging.messages`
  (kind → FieldMap), `appCheck.enforce`; `IceBaseConfig` gained generics R, M (`ParamsOf`, `MessageKindsOf`).
  Shared logic in `client/src/internal/remote-config-shared.ts` (template checks, `syncTemplate` used by
  deploy) and `messaging-shared.ts` (typed data ⇄ FCM strings, kind in `icebaseKind`, topic conditions).
  Server: `remote-config-service.ts` (store 'remoteconfig', versions; refuses conditions),
  `messaging-service.ts` (store 'messaging': tokens, topics, outbox, inbox; socket `{ s: 'fcm' }`),
  `appcheck-service.ts` (store 'appcheck': HS256 tokens, debug tokens; `ctx.appCheck.verify`). Enforcement
  is in server.ts (`appCheckServiceOf`, socket auth carries `appCheck`) and functions-service (callables
  only). The client's `post()` and the realtime socket send the App Check token; in emulator mode
  `initializeAppCheck` also registers a CustomProvider on the native web app so the Firebase SDKs IceBase
  drives (storage, functions, auth) attach it. FCM tokens the server never issued are refused (as on FCM).

Rules the code keeps: every index a query uses is declared with `index(…)` (single-field ones
too); fields are key paths (`['address', 'city']`) and strings are never split on dots.

## Releasing

Bump `version` in `packages/*/deno.json` and `package.json` (all three move together; the
server and CLI pin the client exactly), commit, tag `vX.Y.Z` and push the tag: CI runs every
suite and publishes the three packages to JSR (linked to this repository, OIDC, no token).

## How to verify

- `npm run typecheck` — 0 errors.
- `npm test` — unit + IceBase emulator suites (no Java).
- `npm run test:pg` — the same on Postgres (Docker: `docker run -d --name icebase-pg-test -e
  POSTGRES_PASSWORD=pg -p 55432:5432 postgres:16`; `colima start` first if `docker info` fails).
- `npm run test:firebase` and `npm run test:functions` — the same suites on Firebase's
  emulators (need Java 21+; `scripts/emu.sh` finds `/opt/homebrew/opt/openjdk@21`).
- `cd example-app && node ../packages/cli/dist/cli/index.js dev` (or `deno run -A
  --unstable-sloppy-imports ../packages/cli/src/cli/index.ts dev`) then `npx tsx scripts/smoke.ts`
  — end to end under `icebase dev` (build first: `npm run build`).
- Dart: `npm run build`, then `cd packages/dart/icebase && dart analyze --fatal-infos && dart test`
  (regenerate the fixture with `node --import tsx ../../../../cli/src/cli/index.ts gen dart --out
  icebase.g.dart` in `test/fixture`); `cd packages/dart/icebase_flutter && flutter analyze && flutter test`.
  Not on pub.dev yet: publishing needs Panth's pub.dev account.
- Live conformance (Firestore via the web SDK, RTDB via admin; rules opened for the run and locked
  after): `ICEBASE_LIVE_PROJECT=icebase-test-p977 npx vitest run live/` in `packages/tests`.
- Management APIs: `ICEBASE_LIVE_PROJECT=icebase-test-p977 npx tsx live/manage.live.ts`
  in `packages/tests` (uses `gcloud auth print-access-token`; the project is IceBase's own
  test project, Spark plan: Auth "Get started" and the default Storage bucket need the console
  or Blaze).

## How to work here

- Node 22+ or Deno 2, TypeScript strict, ESM, `.ts` import extensions (tsc rewrites them for
  `dist`). Runtime dependencies stay minimal: the Firebase SDKs (peers), `ws` (emulator socket),
  `tsx` + `esbuild` (CLI on Node: load TS config, bundle functions), `pg` (vm mode only, imported
  when used). SQLite is `node:sqlite`.
- JSR rules: explicit return types on exported functions (`deno publish --dry-run` checks).
- Every change ships with tests, in the shared suites when the behaviour exists in Firebase too.
- Firebase test project: `icebase-test-p977` (created 2026-10-24 for IceBase e2e). Never
  touch any other Firebase / GCP project (TaskManager, VardayiniDairy, Octupuz). Anything that
  needs billing (Blaze) or a credit card is Panth's to do; ask.
- Secrets are env-var names in config, values in `.env` (gitignored). Never commit a key.
- Push to `main` and JSR releases are approved (Panth, ORCH-26, 2026-10-24). npm publishing is not.
