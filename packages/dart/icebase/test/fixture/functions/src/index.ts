import { HttpsError, onCall } from '@panth977/icebase-server/functions';

export const add = onCall<{ a: number; b: number }, { sum: number; uid: string | null }>((req) => {
  if (typeof req.data?.a !== 'number') throw new HttpsError('invalid-argument', 'a must be a number');
  return { sum: req.data.a + req.data.b, uid: req.auth?.uid ?? null };
});
