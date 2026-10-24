// The firebase-admin app behind an IceBase admin app in firebase mode.

import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { applicationDefault, cert, deleteApp, initializeApp, refreshToken, type App, type Credential, type ServiceAccount } from 'firebase-admin/app';
import { service, type IceBaseApp } from '../app.js';
import { configError } from '../errors.js';
import { readEnv } from '../config.js';

// The Firebase CLI's OAuth client, read from the installed firebase-tools (lib/api.js), so
// `firebase login` / `icebase login` can stand in for a key file on a developer's machine.
function firebaseCliClient(): { id: string; secret: string } | null {
  try {
    const req = createRequire(join(process.cwd(), 'package.json'));
    const api = req('firebase-tools/lib/api.js') as { clientId(): string; clientSecret(): string };
    return { id: api.clientId(), secret: api.clientSecret() };
  } catch {
    return null;
  }
}

function hasApplicationDefault(): boolean {
  if (readEnv('GOOGLE_APPLICATION_CREDENTIALS') || readEnv('K_SERVICE') || readEnv('FUNCTION_TARGET') || readEnv('GOOGLE_CLOUD_PROJECT')) return true;
  const adc = process.platform === 'win32' ? join(readEnv('APPDATA') ?? '', 'gcloud', 'application_default_credentials.json') : join(homedir(), '.config', 'gcloud', 'application_default_credentials.json');
  return existsSync(adc);
}

function firebaseCliLogin(): Credential | null {
  try {
    const store = JSON.parse(readFileSync(join(readEnv('XDG_CONFIG_HOME') ?? join(homedir(), '.config'), 'configstore', 'firebase-tools.json'), 'utf8')) as { tokens?: { refresh_token?: string } };
    const rt = store.tokens?.refresh_token;
    const client = firebaseCliClient();
    return rt && client ? refreshToken({ type: 'authorized_user', client_id: client.id, client_secret: client.secret, refresh_token: rt }) : null;
  } catch {
    return null;
  }
}

/** The management APIs' credential: like adminCredential, but on a developer machine without
 * application default credentials it falls back to the Firebase CLI login (`icebase login`).
 * (firebase-admin's Firestore and Storage clients refuse that kind of credential, so the SDK app never uses it.) */
export function managementCredential(app: IceBaseApp): Credential {
  const explicit = (app.options as { credential?: Credential }).credential ?? (app.config.firebase?.serviceAccountEnv && readEnv(app.config.firebase.serviceAccountEnv));
  if (explicit || hasApplicationDefault()) return adminCredential(app);
  return firebaseCliLogin() ?? adminCredential(app);
}

/** The admin SDK credential: options.credential, then config.firebase.serviceAccountEnv (JSON or a path), then application default credentials. */
export function adminCredential(app: IceBaseApp): Credential {
  const opt = (app.options as { credential?: Credential }).credential;
  if (opt) return opt;
  const envName = app.config.firebase?.serviceAccountEnv;
  const value = envName ? readEnv(envName) : undefined;
  if (!value) return applicationDefault();
  const text = value.trim().startsWith('{') ? value : readFileSync(value, 'utf8');
  try {
    return cert(JSON.parse(text) as ServiceAccount);
  } catch {
    throw configError(`env var ${envName} (firebase.serviceAccountEnv) is neither service-account JSON nor a path to a readable JSON file`);
  }
}

export function nativeAdminApp(app: IceBaseApp): App {
  return service(app, 'firebase:admin', () => {
    const fb = app.config.firebase;
    if (!fb?.projectId) throw configError('firebase mode needs `firebase.projectId` in icebase.config');
    const native = initializeApp(
      {
        credential: adminCredential(app),
        projectId: fb.projectId,
        // The default Realtime Database instance, unless config names another.
        databaseURL: fb.databaseURL ?? `https://${fb.projectId}-default-rtdb.firebaseio.com`,
        ...(fb.storageBucket ? { storageBucket: fb.storageBucket } : {}),
      },
      `icebase:${app.name}`,
    );
    app._onDelete.push(() => deleteApp(native));
    return native;
  });
}
