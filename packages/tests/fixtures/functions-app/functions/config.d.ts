// Types for config.js (the fixture's functions source is plain JavaScript).
import type { AnyConfig } from '@panth977/icebase/config';
import type { Collection, DbPath } from '@panth977/icebase/schema';
import type { Timestamp } from '@panth977/icebase/firestore';

export declare const products: Collection<'products', { name: string; stock: number }, any>;
export declare const orders: Collection<'users/{uid}/orders', { product: import('@panth977/icebase/firestore').DocumentReference<{ name: string; stock: number }>; qty: number; note?: string }, any>;
export declare const seen: Collection<'seen', { kind: string; detail: unknown; attempt?: number }, any>;
export declare const rooms: DbPath<'rooms/{roomId}/messages/{msgId}', { text: string }, never>;
declare const config: AnyConfig;
export default config;
export type { Timestamp };
