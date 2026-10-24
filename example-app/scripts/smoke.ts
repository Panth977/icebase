// Smoke test against `icebase dev`: the example app's own code paths, emulator mode.
import { initializeApp } from 'icebase/app';
import { createUserWithEmailAndPassword, getAuth } from 'icebase/auth';
import { addDoc, collection, doc, getCountFromServer, getDoc, getFirestore, serverTimestamp, setDoc } from 'icebase/firestore';
import { getFunctions, httpsCallable } from 'icebase/functions';
import { getStorage, ref, uploadBytes, getDownloadURL } from 'icebase/storage';
import config from '../icebase.config';
import { orders, products, users } from '../icebase/schema';
import type { cancelOrder as CancelOrder, lowStock as LowStock } from '../icebase/functions/src/orders';

const ok = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`FAIL ${what}`);
  console.log(`ok   ${what}`);
};
const app = initializeApp(config, 'local');
const db = getFirestore(app);
const auth = getAuth(app);

ok((await getCountFromServer(collection(db, products))).data().count === 1000, 'seed: 1000 products');
const { user } = await createUserWithEmailAndPassword(auth, `smoke${Date.now()}@example.com`, 'secret12');
await setDoc(doc(collection(db, users), user.uid), { email: user.email!, displayName: 'Smoke', role: 'member', createdAt: serverTimestamp() });
ok((await getDoc(doc(collection(db, users), user.uid))).data()?.role === 'member', 'rules: member creates own profile');
const p1 = doc(collection(db, products), 'p1');
const before = (await getDoc(p1)).data()!.stock;
const order = await addDoc(collection(db, orders, user.uid), { status: 'pending', items: [{ product: p1, qty: 1 }], totalCents: 501, createdAt: serverTimestamp() });
for (let i = 0; i < 50 && (await getDoc(p1)).data()!.stock !== before - 1; i++) await new Promise((r) => setTimeout(r, 100));
ok((await getDoc(p1)).data()!.stock === before - 1, 'trigger: onOrderCreated decremented stock');
const cancel = httpsCallable<typeof CancelOrder>(getFunctions(app), 'cancelOrder');
ok((await cancel({ orderId: order.id })).data.ok === true, 'callable: cancelOrder (auth from the client)');
ok((await getDoc(order)).data()?.status === 'cancelled', 'callable: transaction wrote cancelled');
try {
  await cancel({ orderId: order.id });
  ok(false, 'callable error');
} catch (e) {
  ok((e as { code?: string }).code === 'functions/failed-precondition', 'callable: HttpsError reaches the client');
}
const low = httpsCallable<typeof LowStock>(getFunctions(app), 'lowStock');
ok((await low()).data.names.length > 0, 'callable: lowStock');
const st = getStorage(app);
const avatar = ref(st, `avatars/${user.uid}/me.png`);
await uploadBytes(avatar, new Uint8Array([137, 80, 78, 71]), { contentType: 'image/png' });
ok((await (await fetch(await getDownloadURL(avatar))).arrayBuffer()).byteLength === 4, 'storage: upload + download URL (storage.rules)');
try {
  await uploadBytes(ref(st, `avatars/someone-else/me.png`), new Uint8Array([1]), { contentType: 'image/png' });
  ok(false, 'storage rules');
} catch (e) {
  ok(/unauthorized|permission/i.test(String((e as { code?: string }).code)), 'storage: rules refuse another user’s folder');
}
const home = await fetch('http://127.0.0.1:5002/');
ok(home.status === 200 && (await home.text()).includes('Acme shop'), 'hosting: index.html');
const spa = await fetch('http://127.0.0.1:5002/some/client/route');
ok((await spa.text()).includes('Acme shop'), 'hosting: SPA fallback');
const api = (await (await fetch('http://127.0.0.1:5002/api/hello')).json()) as { path: string };
ok(api.path === '/api/hello', 'hosting: /api/** rewrites to the api function');
process.exit(0);
