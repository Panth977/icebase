import { getAdminFirestore, initializeAdminApp } from 'icebase/admin';
import { collection, doc, getDoc, increment, updateDoc } from 'icebase/firestore';
import { HttpsError, onCall, onDocumentCreated, onDocumentUpdated, onRequest } from 'icebase/functions/v2';
import { f } from 'icebase/schema';
import config, { orders, products } from './config.js';

// ICEBASE_ENV picks the environment: `icebase dev` and `icebase deploy` set it.
const db = getAdminFirestore(initializeAdminApp(config, process.env.ICEBASE_ENV ?? 'test'));

export const add = onCall({ input: f.map({ a: f.number(), b: f.number() }) }, (req) => ({ sum: req.data.a + req.data.b, uid: req.auth?.uid ?? null }));

export const stockOf = onCall(async (req) => {
  if (typeof req.data?.id !== 'string') throw new HttpsError('invalid-argument', 'id');
  return { stock: (await getDoc(doc(collection(db, products), req.data.id))).data()?.stock ?? null };
});

export const hello = onRequest(async (req) => new Response(JSON.stringify({ path: new URL(req.url).pathname, method: req.method, body: req.method === 'POST' ? await req.json() : null }), { headers: { 'content-type': 'application/json', 'x-icebase': '1' } }));

export const onOrderCreated = onDocumentCreated(orders, async (e) => {
  const order = e.data.data();
  await updateDoc(order.product, { stock: increment(-order.qty) });
  await updateDoc(e.data.ref, { note: `uid=${e.params.uid} docId=${e.params.docId}` });
});

export const onOrderUpdated = onDocumentUpdated(orders, async (e) => {
  if (e.data.before.data().qty !== e.data.after.data().qty) {
    await updateDoc(e.data.after.data().product, { stock: increment(e.data.before.data().qty - e.data.after.data().qty) });
  }
});
