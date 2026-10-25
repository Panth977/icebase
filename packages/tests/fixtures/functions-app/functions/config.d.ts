// Types for config.js (the fixture's functions source is plain JavaScript).
import type { AnyConfig } from '@panth977/icebase/config';
import type { Collection, DbPath } from '@panth977/icebase/schema';
import type { Timestamp } from '@panth977/icebase/firestore';

export declare const products: Collection<'products', { name: string; stock: number }, any>;
export declare const orders: Collection<'users/{uid}/orders', { product: import('@panth977/icebase/firestore').DocumentReference<{ name: string; stock: number }>; qty: number; note?: string }, any>;
export declare const seen: Collection<'seen', { kind: string; detail: unknown; attempt?: number }, any>;
export declare const rooms: DbPath<'rooms/{roomId}/messages/{msgId}', { text: string }, never>;
export declare const api: import('@panth977/icebase/api').Api<{
  addOne: import('@panth977/icebase/api').Endpoint<{ n: number }, { n: number }>;
  productInfo: import('@panth977/icebase/api').Endpoint<{ id: string; upper?: boolean }, { name: string; stock: number }>;
  badOutput: import('@panth977/icebase/api').Endpoint<Record<string, never>, { n: number }>;
  whoAmI: import('@panth977/icebase/api').Endpoint<Record<string, never>, { uid: string }>;
}>;
declare const config: AnyConfig;
export default config;
export type { Timestamp };
