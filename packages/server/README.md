# @panth977/icebase-server

IceBase on the server, for [`@panth977/icebase`](https://jsr.io/@panth977/icebase) projects:

- `@panth977/icebase-server/admin` — `initializeAdminApp(config, env)`, `getAdminFirestore` (the same typed `@panth977/icebase/firestore` functions, bypassing rules), `getAdminAuth` (custom claims typed from `config.auth.claims`), `getAdminDatabase`, `getAdminStorage`.
- `@panth977/icebase-server/functions` — `onCall` (with input/output validation), fetch-style `onRequest`, typed Firestore triggers (`onDocumentCreated(orders, e => e.params.uid …)`), `onSchedule`. The same source deploys to Cloud Functions or runs on the IceBase emulator.
- `@panth977/icebase-server/auth` — the custom-auth endpoint (`createAuthHandler`, deployed as `icebaseAuth`): challenges, rate limits, blocks, approval / reset / verify pages, Google OAuth, and built-in senders (SMTP, Resend, WhatsApp Cloud API, Infobip, Twilio, MSG91) or your own.

```ts
import { getAdminFirestore, initializeAdminApp } from '@panth977/icebase-server/admin';
import { HttpsError, onCall, onDocumentCreated } from '@panth977/icebase-server/functions';
import { doc, increment, updateDoc, collection } from '@panth977/icebase/firestore';
import config from '../../icebase.config.ts';
import { orders, products } from '../schema/index.ts';

const db = getAdminFirestore(initializeAdminApp(config, 'prod'));

export const onOrderCreated = onDocumentCreated(orders, async (e) => {
  for (const item of e.data.data().items) await updateDoc(doc(collection(db, products), item.product.id), { stock: increment(-item.qty) });
});
```

Source and docs: <https://github.com/Panth977/icebase> · Apache-2.0
