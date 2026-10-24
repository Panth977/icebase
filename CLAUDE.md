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
- Modes in phase 1: **firebase and emulator** (SQLite). vm mode is phase 3.
- Console GUI comes after the SDK and CLI.
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

- `packages/icebase/src/` — the package. One module per subpath export (`app`, `config`,
  `schema`, `firestore`, `auth`, `database`, `storage`, `functions`, `functions/v2`, `admin`,
  `manage`, `auth/server`). `drivers/` = one backend per service and mode (firebase web SDK,
  firebase-admin, IceBase emulator). `internal/` = shared pieces (query planner, wire format,
  custom-auth client/store/senders). `emulator/` = the IceBase server (SQLite engine, rules
  engine, auth / database / storage / functions / custom-auth services, hosting). `cli/` = the
  `icebase` command.
- `packages/icebase/test/` — `*.test.ts` run with no emulator (unit + the IceBase emulator,
  in-process). `*.emu.test.ts` need Firebase's emulators. `suites/` hold the shared
  conformance suites: the same assertions run against Firebase and against IceBase.
- `example-app/` — the PRD's example project. `tsc -p example-app` proves the compile-time
  checks (each `@ts-expect-error` line must fail for its stated reason).

## How to verify

- `npm run typecheck` — 0 errors.
- `npm test` — unit + IceBase emulator suites (no Java).
- `npm run test:firebase` and `npm run test:functions` — the same suites on Firebase's
  emulators (need Java 21+; `scripts/emu.sh` finds `/opt/homebrew/opt/openjdk@21`).
- `cd example-app && node ../packages/icebase/dist/cli/index.js dev` then
  `npx tsx scripts/smoke.ts` — end to end under `icebase dev` (build first: `npm run build`).
- Management APIs: `ICEBASE_LIVE_PROJECT=icebase-test-p977 npx tsx test/live/manage.live.ts`
  in `packages/icebase` (uses `gcloud auth print-access-token`; the project is IceBase's own
  test project, Spark plan: Auth "Get started" and the default Storage bucket need the console
  or Blaze).

## How to work here

- Node 22+, TypeScript strict, ESM. Runtime dependencies stay minimal: the Firebase SDKs
  (peers), `ws` (emulator socket), `tsx` + `esbuild` (CLI: load TS config, bundle functions).
  SQLite is `node:sqlite`.
- Every change ships with tests, in the shared suites when the behaviour exists in Firebase too.
- Firebase test project: `icebase-test-p977` (created 2026-10-24 for IceBase e2e). Never
  touch any other Firebase / GCP project (TaskManager, VardayiniDairy, Octupuz). Anything that
  needs billing (Blaze) or a credit card is Panth's to do; ask.
- Secrets are env-var names in config, values in `.env` (gitignored). Never commit a key.
- Do not publish to npm, push or open PRs unless the ticket asks for it in so many words.
