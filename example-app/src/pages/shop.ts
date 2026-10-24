// Frontend usage — reads exactly like Firebase, but everything is typed from icebase/schema.
import {
  addDoc,
  arrayUnion,
  collection,
  doc,
  getAggregateFromServer,
  getCountFromServer,
  getDoc,
  getDocs,
  increment,
  limit,
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  startAfter,
  sum,
  updateDoc,
  where,
  writeBatch,
} from 'icebase/firestore';
import { signInWithEmailAndPassword } from 'icebase/auth';
import { httpsCallable } from 'icebase/functions';
import type { cancelOrder as cancelOrderFn } from '../../icebase/functions/src/orders';
import { auth, db, functions } from '../lib/icebase';
import { orders, products, users } from '../../icebase/schema';

// Single field: needs its declared single-field index (index('name'), index('email'), index('stock')).
export const byName = query(collection(db, products), where('name', '==', 'Boot'));
export const byEmail = query(collection(db, users), where('email', '==', 'a@b.c'));
export const newest = query(collection(db, products), orderBy('stock', 'desc'), limit(10));
// Equality on several fields: their single-field indexes are merged, as in Firebase.
export const activeShoes = query(collection(db, products), where('category', '==', 'shoes'), where('active', '==', true));

// Range + orderBy on the SAME field is still single-field.
export const midPrice = query(collection(db, products), where('priceCents', '>', 1000), orderBy('priceCents'));
// array-contains + orderBy → uses the declared composite ['tags contains', 'priceCents asc'].
export const tagged = query(collection(db, products), where('tags', 'array-contains', 'new'), orderBy('priceCents'));

// Composite: equality + orderBy on another field → needs the declared index ['category', 'priceCents asc'].
export async function cheapShoes() {
  const q = query(collection(db, products), where('category', '==', 'shoes'), orderBy('priceCents', 'asc'), limit(20));
  const snap = await getDocs(q);
  return snap.docs.map((d) => d.data().name); // d.data() is { name: string; priceCents: number; … }
}

export async function nextPage(after: Awaited<ReturnType<typeof getDocs>>['docs'][number]) {
  return getDocs(query(collection(db, products), orderBy('stock', 'desc'), startAfter(after), limit(10)));
}

export function watchMyOrders(uid: string, cb: (n: number) => void) {
  // 'users/{uid}/orders' → collection(db, orders, uid). Uses the declared composite ['status', 'createdAt desc'].
  return onSnapshot(query(collection(db, orders, uid), where('status', '==', 'pending'), orderBy('createdAt', 'desc')), (s) => cb(s.size));
}

export async function placeOrder(uid: string, productId: string) {
  await signInWithEmailAndPassword(auth, 'a@b.c', 'pw');
  const product = doc(collection(db, products), productId);
  await addDoc(collection(db, orders, uid), { status: 'pending', items: [{ product, qty: 1 }], totalCents: 1200, createdAt: serverTimestamp() });
  await updateDoc(product, { stock: increment(-1), tags: arrayUnion('ordered') });
}

export async function stats() {
  const n = (await getCountFromServer(collection(db, products))).data().count; // number
  const totals = (await getAggregateFromServer(collection(db, products), { stock: sum('stock') })).data().stock; // number
  return { n, totals };
}

export async function restock(ids: string[]) {
  const batch = writeBatch(db);
  for (const id of ids) batch.update(doc(collection(db, products), id), { stock: 100 });
  await batch.commit();
  return runTransaction(db, async (tx) => {
    const s = await tx.get(doc(collection(db, products), ids[0]!));
    tx.update(s.ref, { active: (s.data()?.stock ?? 0) > 0 });
    return s.data()?.name;
  });
}

export async function readUser(uid: string) {
  const s = await getDoc(doc(collection(db, users), uid));
  return s.data()?.role; // 'admin' | 'member' | undefined
}

// Typed from the server definition (a type-only import: no server code in the bundle).
export const cancelOrder = httpsCallable<typeof cancelOrderFn>(functions, 'cancelOrder');
export async function cancel(orderId: string) {
  const r = await cancelOrder({ orderId });
  return r.data.ok; // true
}

// Nested fields are key arrays; a key with a dot is one key.
export const inPune = query(collection(db, users), where(['address', 'city'], '==', 'Pune'));
export const topRated = query(collection(db, products), orderBy('rating.avg', 'desc'), limit(5));
export async function moveTo(uid: string, city: string) {
  await updateDoc(doc(collection(db, users), uid), ['address', 'city'], city);
}

// ── What the types refuse (each line is a compile error; tsc proves it via @ts-expect-error) ──
export function refused(uid: string) {
  // @ts-expect-error displayName has no index declared
  getDocs(query(collection(db, users), orderBy('displayName')));
  // @ts-expect-error ['address', 'pin'] has no index declared
  getDocs(query(collection(db, users), where(['address', 'pin'], '==', '411001')));
  // @ts-expect-error ['address', 'town'] is not a field of users
  query(collection(db, users), where(['address', 'town'], '==', 'x'));
  // @ts-expect-error a city is a string
  updateDoc(doc(collection(db, users), uid), ['address', 'city'], 42);
  // @ts-expect-error category + stock needs a composite index that is not declared
  getDocs(query(collection(db, products), where('category', '==', 'shoes'), orderBy('stock')));
  // @ts-expect-error status + totalCents needs a composite index that is not declared
  getDocs(query(collection(db, orders, uid), where('status', '==', 'paid'), orderBy('totalCents')));
  // @ts-expect-error two range fields need a composite index that is not declared
  getDocs(query(collection(db, products), where('priceCents', '>', 1), where('stock', '<', 5)));
  // @ts-expect-error 'socks' is not a valid category value
  query(collection(db, products), where('category', '==', 'socks'));
  // @ts-expect-error 'colour' is not a field of products
  query(collection(db, products), where('colour', '==', 'red'));
  // @ts-expect-error subcollection needs its {uid} path parameter
  collection(db, orders);
  // @ts-expect-error missing required fields (items, totalCents, createdAt)
  addDoc(collection(db, orders, uid), { status: 'pending' });
  // @ts-expect-error tags is string[] → array-contains takes one string, not a number
  query(collection(db, products), where('tags', 'array-contains', 3));
  // @ts-expect-error increment() only fits number fields
  updateDoc(doc(collection(db, products), 'p1'), { name: increment(1) });
  // @ts-expect-error orderBy on a field that is not in the schema
  query(collection(db, products), orderBy('colour'));
}
