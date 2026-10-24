// The Firebase web app behind an IceBase client app in firebase mode, created once and shared
// by firestore, auth, database, storage and functions.

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { service, webConfigOf, type IceBaseApp } from '../app.js';

export function nativeWebApp(app: IceBaseApp): FirebaseApp {
  return service(app, 'firebase:web', () => {
    const native = initializeApp(webConfigOf(app), `icebase:${app.name}`);
    app._onDelete.push(() => deleteApp(native));
    return native;
  });
}
