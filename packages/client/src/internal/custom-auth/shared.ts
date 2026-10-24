// Shared by the custom-auth client and server.

import { emulatorOrigin, type IceBaseApp } from '../../app.ts';
import type { AnyConfig } from '../../config.ts';
import { resolveModes } from '../../config.ts';

/** Where the custom-auth endpoint lives for this config + environment. */
export function authEndpoint(config: AnyConfig, env: string, app?: IceBaseApp): string {
  const custom = config.auth?.custom;
  if (custom?.endpoint) return custom.endpoint.replace(/\/$/, '');
  const mode = resolveModes(config, env).auth;
  if (mode === 'emulator') return `${app ? emulatorOrigin(app) : `http://${config.emulator?.host ?? 'localhost'}:${config.emulator?.port ?? 4400}`}/__/icebase/auth`;
  const region = config.functions?.region ?? 'us-central1';
  return `https://${region}-${config.firebase?.projectId}.cloudfunctions.net/icebaseAuth`;
}

/** Error codes, Firebase-style, so `e.code === 'auth/too-many-requests'` keeps working. */
export type AuthErrorCode =
  | 'auth/too-many-requests'
  | 'auth/invalid-email'
  | 'auth/invalid-phone-number'
  | 'auth/invalid-verification-code'
  | 'auth/code-expired'
  | 'auth/invalid-action-code'
  | 'auth/expired-action-code'
  | 'auth/user-disabled'
  | 'auth/user-not-found'
  | 'auth/operation-not-allowed'
  | 'auth/unauthorized-domain'
  | 'auth/weak-password'
  | 'auth/invalid-id-token'
  | 'auth/argument-error'
  | 'auth/internal-error'
  | 'auth/popup-closed-by-user'
  | 'auth/popup-blocked';

export const STORE_DEFAULT_PATH = '_icebase/auth';
