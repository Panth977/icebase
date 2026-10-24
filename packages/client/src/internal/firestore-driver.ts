// What a Firestore backend must do. icebase/firestore validates, checks indexes and builds
// typed snapshots; a driver only moves data. Values crossing this boundary are IceBase values
// (Timestamp, GeoPoint, FieldValue, and references as { type: 'document', path }).

import type { QuerySpec } from './plan.ts';

export interface RawDoc {
  id: string;
  path: string;
  /** null when the document does not exist. */
  data: Record<string, unknown> | null;
  createTime?: { seconds: number; nanoseconds: number };
  updateTime?: { seconds: number; nanoseconds: number };
  fromCache?: boolean;
  hasPendingWrites?: boolean;
  /** The SDK's own snapshot, so cursors (startAfter(snap)) can use it. */
  native?: unknown;
}

export interface RawChange {
  type: 'added' | 'modified' | 'removed';
  doc: RawDoc;
  oldIndex: number;
  newIndex: number;
}

export interface RawQueryResult {
  docs: RawDoc[];
  changes?: RawChange[];
  fromCache?: boolean;
  hasPendingWrites?: boolean;
}

export type Aggregate = { op: 'count' } | { op: 'sum' | 'avg'; field: string };

export interface Unsubscribe {
  (): void;
}

export interface TxDriver {
  get(path: string): Promise<RawDoc>;
  set(path: string, data: Record<string, unknown>, merge: boolean): void;
  /** Each entry sets the field at its key path. */
  update(path: string, fields: [string[], unknown][]): void;
  delete(path: string): void;
}

export interface BatchDriver {
  set(path: string, data: Record<string, unknown>, merge: boolean): void;
  update(path: string, fields: [string[], unknown][]): void;
  delete(path: string): void;
  commit(): Promise<void>;
}

export interface FirestoreDriver {
  readonly kind: 'web' | 'admin' | 'emulator';
  get(path: string): Promise<RawDoc>;
  query(spec: QuerySpec): Promise<RawQueryResult>;
  aggregate(spec: QuerySpec, aggs: Record<string, Aggregate>): Promise<Record<string, number | null>>;
  set(path: string, data: Record<string, unknown>, merge: boolean): Promise<void>;
  /** Create only; fails with already-exists when the document is there. */
  create(path: string, data: Record<string, unknown>): Promise<void>;
  /** Each entry sets the field at its key path (never split on dots). */
  update(path: string, fields: [string[], unknown][]): Promise<void>;
  delete(path: string): Promise<void>;
  listenDoc(path: string, next: (d: RawDoc) => void, error: (e: Error) => void): Unsubscribe;
  listenQuery(spec: QuerySpec, next: (r: RawQueryResult) => void, error: (e: Error) => void): Unsubscribe;
  transaction<R>(fn: (tx: TxDriver) => Promise<R>, opts?: { maxAttempts?: number }): Promise<R>;
  batch(): BatchDriver;
  terminate(): Promise<void>;
  /** Admin only. */
  getAll?(paths: string[]): Promise<RawDoc[]>;
  listCollections?(docPath: string | null): Promise<string[]>;
  recursiveDelete?(path: string): Promise<void>;
  /** Admin only: an SDK snapshot (e.g. from a trigger event) as a RawDoc. */
  fromNative?(snapshot: unknown): RawDoc;
}

/** Firestore's auto-id: 20 chars from [A-Za-z0-9]. */
export function autoId(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(40);
  globalThis.crypto.getRandomValues(bytes);
  let id = '';
  for (let i = 0; i < bytes.length && id.length < 20; i++) if (bytes[i]! < 248) id += chars[bytes[i]! % 62];
  while (id.length < 20) id += chars[Math.floor(Math.random() * 62)];
  return id;
}
