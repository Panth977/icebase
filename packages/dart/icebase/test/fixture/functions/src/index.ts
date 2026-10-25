import { HttpsError, onCall, onRequest } from '@panth977/icebase-server/functions';
import { getAdminFirestore, initializeAdminApp } from '@panth977/icebase-server/admin';
import { collection, doc, getDoc, Timestamp } from '@panth977/icebase/firestore';
import config, { api } from '../../icebase.config.ts';

export const add = onCall<{ a: number; b: number }, { sum: number; uid: string | null }>((req) => {
  if (typeof req.data?.a !== 'number') throw new HttpsError('invalid-argument', 'a must be a number');
  return { sum: req.data.a + req.data.b, uid: req.auth?.uid ?? null };
});

const db = getAdminFirestore(initializeAdminApp(config, 'local'));
const products = Object.values(config.schema.collections).find((c) => c.path === 'products')!;

export const addNumbers = onCall(api.addNumbers, (req) => ({ sum: req.data.a + req.data.b, at: Timestamp.fromDate(new Date('2030-01-02T03:04:05Z')) }));
export const productById = onRequest(api.productById, async ({ input }) => {
  const p = (await getDoc(doc(collection(db, products as never), input.id))).data();
  if (!p) throw new HttpsError('not-found', `No product ${input.id}`);
  return p as never;
});
export const tagCount = onCall(api.tagCount, (req) => req.data.length);
