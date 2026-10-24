// Google REST calls for the management APIs in firebase mode, authorised with the admin
// app's credential (service account or application default).

import type { IceBaseApp } from '@panth977/icebase/app';
import { IceBaseError } from '@panth977/icebase/errors';
import { managementCredential } from '@panth977/icebase-server/internal';

export interface GoogleClient {
  readonly projectId: string;
  call<T = unknown>(method: string, url: string, body?: unknown, opts?: { allow404?: boolean; headers?: Record<string, string>; raw?: BodyInit }): Promise<T>;
  /** Wait for a long-running operation ({ name, done }) at `base`. */
  wait<T = unknown>(base: string, op: { name: string; done?: boolean; response?: T; error?: { message: string } }, timeoutMs?: number): Promise<T | undefined>;
}

const STATUS: Record<number, IceBaseError['code']> = { 400: 'invalid-argument', 401: 'unauthenticated', 403: 'permission-denied', 404: 'not-found', 409: 'already-exists', 412: 'failed-precondition', 429: 'resource-exhausted', 501: 'unimplemented', 503: 'unavailable' };

export function googleClient(app: IceBaseApp, service: string): GoogleClient {
  const projectId = app.config.firebase?.projectId;
  if (!projectId) throw new IceBaseError('failed-precondition', 'management APIs in firebase mode need firebase.projectId in icebase.config', { reason: 'config' });
  const cred = managementCredential(app);
  let token: { value: string; until: number } | null = null;
  const auth = async () => {
    if (!token || token.until < Date.now() + 60_000) {
      const t = await cred.getAccessToken();
      token = { value: t.access_token, until: Date.now() + t.expires_in * 1000 };
    }
    return token.value;
  };
  const call = async <T>(method: string, url: string, body?: unknown, opts: { allow404?: boolean; headers?: Record<string, string>; raw?: BodyInit } = {}): Promise<T> => {
    const res = await fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await auth()}`,
        'x-goog-user-project': projectId,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...opts.headers,
      },
      ...(opts.raw !== undefined ? { body: opts.raw } : body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404 && opts.allow404) return undefined as T;
    const text = await res.text();
    if (!res.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text;
      } catch {
        /* not JSON */
      }
      throw new IceBaseError(STATUS[res.status] ?? (res.status >= 500 ? 'internal' : 'unknown'), `${service}: ${method} ${url.replace(/\?.*$/, '')} → ${res.status}: ${message}`, { reason: 'management', service, status: res.status });
    }
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const wait = async <T>(base: string, op: { name: string; done?: boolean; response?: T; error?: { message: string } }, timeoutMs = 300_000): Promise<T | undefined> => {
    const until = Date.now() + timeoutMs;
    let cur = op;
    let delay = 1000;
    while (!cur.done) {
      if (Date.now() > until) throw new IceBaseError('deadline-exceeded', `${service}: operation ${op.name} did not finish in ${timeoutMs / 1000}s`, { reason: 'management', service });
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 10_000);
      cur = await call('GET', `${base}/${cur.name}`);
    }
    if (cur.error) throw new IceBaseError('internal', `${service}: ${cur.error.message}`, { reason: 'management', service });
    return cur.response;
  };
  return { projectId, call, wait };
}
