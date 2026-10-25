import { getAdminFirestore, initializeAdminApp } from '@panth977/icebase-server/admin';
import { collection, doc, getDoc, getDocs, increment, query, runTransaction, updateDoc, where } from '@panth977/icebase/firestore';
import { HttpsError, onCall, onDocumentCreated, onRequest } from '@panth977/icebase-server/functions';
import config from '../../../icebase.config';
import { orders, products } from '../../schema';
import { api } from '../../api';

// ICEBASE_ENV is set by `icebase dev` and `icebase deploy`.
const app = initializeAdminApp(config, (process.env.ICEBASE_ENV ?? 'prod') as 'local' | 'prod');
const db = getAdminFirestore(app);

// Typed trigger: e.params.uid comes from the 'users/{uid}/orders' path, data() is the order type.
export const onOrderCreated = onDocumentCreated(orders, async (e) => {
  const order = e.data.data();
  for (const item of order.items) {
    await updateDoc(doc(collection(db, products), item.product.id), { stock: increment(-item.qty) });
  }
  console.log(`order ${e.params.docId} for user ${e.params.uid}: ${order.totalCents} cents`);
});

export const cancelOrder = onCall(api.cancelOrder, async (req) => {
  const ref = doc(collection(db, orders, req.auth!.uid), req.data.orderId);
  await runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.data()?.status !== 'pending') throw new HttpsError('failed-precondition', 'only pending orders');
    tx.update(ref, { status: 'cancelled' });
  });
  return { ok: true as const };
});

export const lowStock = onCall(api.lowStock, async () => {
  const snap = await getDocs(query(collection(db, products), where('active', '==', true)));
  return { names: snap.docs.filter((d) => d.data().stock < 5).map((d) => d.data().name) };
});

export const getProduct = onRequest(api.getProduct, async ({ input }) => {
  const p = (await getDoc(doc(collection(db, products), input.id))).data();
  if (!p) throw new HttpsError('not-found', `No product ${input.id}`);
  return p;
});

export const orderSummary = onRequest(api.orderSummary, async ({ input, request }) => {
  const token = (request.headers.get('authorization') ?? '').replace(/^Bearer /, '');
  if (!token) throw new HttpsError('unauthenticated', 'sign in first');
  const { getAdminAuth } = await import('@panth977/icebase-server/admin');
  const { uid } = await getAdminAuth(app).verifyIdToken(token);
  const o = (await getDoc(doc(collection(db, orders, uid), input.orderId))).data();
  if (!o) throw new HttpsError('not-found', 'No such order of yours');
  return { status: o.status, totalCents: o.totalCents };
});
