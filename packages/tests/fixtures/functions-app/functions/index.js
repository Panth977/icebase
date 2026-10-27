import { getAdminFirestore, getAdminMessaging, initializeAdminApp, taskQueue } from '@panth977/icebase-server/admin';
import { collection, doc, getDoc, increment, updateDoc } from '@panth977/icebase/firestore';
import { HttpsError, beforeUserCreated, onCall, onDocumentCreated, onDocumentDeleted, onDocumentUpdated, onDocumentWritten, onSchedule, onObjectFinalized, onRequest, onTaskDispatched, onUserCreated, onValueCreated } from '@panth977/icebase-server/functions';
import { f } from '@panth977/icebase/schema';
import config, { api, orders, products, rooms, seen } from './config.js';

// ICEBASE_ENV picks the environment: `icebase dev` and `icebase deploy` set it.
const app = initializeAdminApp(config, process.env.ICEBASE_ENV ?? 'test');
const db = getAdminFirestore(app);
const record = (id, kind, detail, attempt) => import('@panth977/icebase/firestore').then(({ setDoc }) => setDoc(doc(collection(db, seen), id), { kind, detail, ...(attempt !== undefined ? { attempt } : {}) }));

export const onUpload = onObjectFinalized(async (e) => record(`upload-${e.data.name.replace(/\//g, '_')}`, 'upload', { name: e.data.name, size: e.data.size, contentType: e.data.contentType }));

export const onMessage = onValueCreated(rooms, async (e) => record(`msg-${e.params.roomId}-${e.params.msgId}`, 'rtdb', { text: e.data.val().text, params: e.params }));

export const work = onTaskDispatched({ retryConfig: { maxAttempts: 3, minBackoffSeconds: 0.1 } }, async (req) => {
  if (req.data.failOnce && req.retryCount === 0) throw new Error('first attempt fails');
  await record(`task-${req.data.key}`, 'task', req.data, req.retryCount);
});
export const enqueueWork = onCall(async (req) => {
  await taskQueue(app, 'work').enqueue(req.data, req.data.delay ? { scheduleDelaySeconds: req.data.delay } : {});
  return { ok: true };
});

export const onSignUp = onUserCreated(async (u) => record(`user-${u.uid}`, 'user', { email: u.email ?? null }));
export const gate = beforeUserCreated((e) => {
  if (e.data.email?.endsWith('@blocked.test')) throw new HttpsError('permission-denied', 'blocked domain');
  return { displayName: 'Gated', customClaims: { tier: 'free' } };
});

export const notify = onCall(async (req) => ({ id: await getAdminMessaging(app).send({ token: req.data.token, notification: { title: 'Hi' } }) }));

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

// Declared endpoints: input and output checked against config.api.
export const addOne = onCall(api.addOne, (req) => ({ n: req.data.n + 1 }));
export const productInfo = onRequest(api.productInfo, async ({ input }) => {
  const p = (await getDoc(doc(collection(db, products), input.id))).data();
  if (!p) throw new HttpsError('not-found', `No product ${input.id}`);
  return { name: input.upper ? p.name.toUpperCase() : p.name, stock: p.stock };
});
export const badOutput = onCall(api.badOutput, () => ({ n: 'not a number' }));
export const whoAmI = onCall(api.whoAmI, (req) => ({ uid: req.auth.uid }));
export const echoTyped = onCall(api.echoTyped, (req) => ({ at: req.data.at, product: req.data.product, year: req.data.at.toDate().getUTCFullYear() }));

// A string pattern: firebase-functions' own event shape (firebase-admin snapshots) on both platforms.
export const onProductWritten = onDocumentWritten('products/{productId}', async (e) =>
  record(`pattern-${e.params.productId}`, 'pattern', { params: e.params, before: e.data.before.exists, after: e.data.after.exists ? e.data.after.data().stock : null, ref: e.data.after.ref.path }),
);

// Auth emails on a signed server (icebase serve): the link, to mail it yourself.
export const sendAuthEmail = async (m) => record(`mail-${m.kind}-${m.to.replace(/[^a-z0-9]/g, '_')}`, 'mail', { kind: m.kind, to: m.to, link: m.link });

// A deleted document: the snapshot as it was.
export const onProductDeleted = onDocumentDeleted('products/{productId}', async (e) => record(`deleted-${e.params.productId}`, 'deleted', { id: e.params.productId, name: e.data?.data()?.name ?? null }));

// A scheduled function (the IceBase server runs it on its schedule, or now: /__/icebase/functions/run).
export const nightly = onSchedule('every 24 hours', async () => record('schedule-nightly', 'schedule', { ran: true }));

// An HttpsError reaches the caller with its code, message and details.
export const refuse = onCall(() => {
  throw new HttpsError('failed-precondition', 'not today', { why: 'closed' });
});
