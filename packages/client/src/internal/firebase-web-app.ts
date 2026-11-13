// The Firebase web app behind an IceBase client app, shared by firestore, auth, database, storage,
// functions, remote config, messaging and app check.
//
// Services in firebase mode run on the app the caller adopted with initializeApp(config, env,
// { firebaseApp }) when there is one (its signed-in user stays signed in). Otherwise — and always
// for services in emulator / vm mode, which point their SDK at the IceBase server — IceBase creates
// its own `icebase:<name>` app once and deletes it with the IceBase app. The adopted app is never
// deleted by IceBase.

import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import { service, webConfigOf, type IceBaseApp } from '../app.ts';
import type { Service } from '../config.ts';

/** The Firebase app `svc` runs on: the adopted one in firebase mode, else IceBase's own (also with no `svc`). */
export function nativeWebApp(app: IceBaseApp, svc?: Service): FirebaseApp {
  if (svc && isAdopted(app, svc)) return app.options.firebaseApp!;
  return service(app, 'firebase:web', () => {
    const native = initializeApp(webConfigOf(app), `icebase:${app.name}`);
    app._onDelete.push(() => deleteApp(native));
    return native;
  });
}

/** Whether `svc` runs on an app the caller adopted (and so may already have initialized). */
export function isAdopted(app: IceBaseApp, svc: Service): boolean {
  return !!app.options.firebaseApp && app.modes[svc] === 'firebase';
}
