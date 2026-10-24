// `icebase dev` runs this once on an empty emulator (SQLite) database.
import { getAdminFirestore, initializeAdminApp } from '@panth977/icebase-server/admin';
import { collection, doc, writeBatch } from '@panth977/icebase/firestore';
import config from '../../icebase.config';
import { products } from '../schema';

const db = getAdminFirestore(initializeAdminApp(config, 'local'));
const batch = writeBatch(db);
for (let i = 0; i < 1000; i++) {
  batch.set(doc(collection(db, products), `p${i}`), {
    name: `Product ${i}`, priceCents: 500 + i, category: (['shoes', 'shirts', 'bags'] as const)[i % 3], tags: ['new'], stock: i % 20, active: true,
  });
}
await batch.commit();
