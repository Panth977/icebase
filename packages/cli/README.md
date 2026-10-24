# @panth977/icebase-cli

The `icebase` command, the management APIs and the IceBase emulator server, for
[`@panth977/icebase`](https://jsr.io/@panth977/icebase) projects.

| Command | What it does |
| --- | --- |
| `icebase init [--import DIR] [--project ID --sample N]` | Create `icebase.config.ts`, schema, rules, functions; import an existing Firebase project's rules and indexes and draft a schema from sampled documents |
| `icebase dev [--env X]` | The emulator (Firestore, Auth, Realtime Database, Storage, Functions, custom auth) on one port, hosting on another, the seed script, reloads on change |
| `icebase deploy --env X [--only …]` | Firestore indexes/TTL/exemptions from the schema, rules, auth providers, functions (bundled with the custom-auth endpoint), hosting |
| `icebase indexes check` | Every query whose index is not declared, with file:line (exit 1 if any) |
| `icebase drivers --env X` | The mode of each service and wiring problems |
| `icebase login` | Firebase login, used by deploy and the management APIs |

Run it with Deno (no install):

```sh
deno run -A jsr:@panth977/icebase-cli/cli init        # writes deno.json with the import map
deno run -A --unstable-sloppy-imports --config deno.json jsr:@panth977/icebase-cli/cli dev
```

(`--config deno.json` gives your project's import map to the CLI; `--unstable-sloppy-imports` lets
`icebase.config.ts` import `./icebase/schema` without an extension.)
With Node 22+, from a clone of the repository: `npm install && npm run build`, then `node packages/cli/dist/cli/index.js <command>`.

**Management APIs** (`@panth977/icebase-cli/manage`): set a project up from code —
`manageFirestore(app).createDb() / setSchema() / setIndexes() / setRules()`,
`manageDatabase(app).createDb() / setRules()`, `manageStorage(app).createBucket() / setRules()`,
`manageAuth(app).enable() / setProviders() / setAuthorizedDomains()`,
`manageHosting(app).createSite() / deploy() / setDNS()`.

**Emulator** (`@panth977/icebase-cli/emulator`): `startEmulator({ config })` — the IceBase server
on SQLite, enforcing your schema, declared indexes and Firebase rules files; it speaks the
Firebase Auth and Storage REST APIs, so the Firebase SDKs work against it unchanged.

Source and docs: <https://github.com/Panth977/icebase> · Apache-2.0
