/**
 * IceBase — Firebase's API with an explicit schema, declared indexes and a self-hostable
 * emulator. This entry point has the setup pieces; each service is its own module:
 * `@panth977/icebase/firestore`, `/auth`, `/database`, `/storage`, `/functions`.
 *
 * ```ts
 * import { defineConfig, initializeApp, collection, f, index } from '@panth977/icebase';
 * ```
 * @module
 */

export * from './app.ts';
export * from './config.ts';
export * from './schema.ts';
