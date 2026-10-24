// Optional backend (your own API / scripts) — same typed API, admin mode bypasses rules.
import { getAdminFirestore, initializeAdminApp } from 'icebase/admin';
import { collectionGroup, getDocs, query, where } from 'icebase/firestore';
import config from '../icebase.config';
import { orders } from '../icebase/schema';

const db = getAdminFirestore(initializeAdminApp(config, 'prod'));

export async function paidOrdersAcrossUsers() {
  const snap = await getDocs(query(collectionGroup(db, orders), where('status', '==', 'paid')));
  return snap.docs.reduce((sum, d) => sum + d.data().totalCents, 0);
}
