// The console's API: POST <base>api/<op> with the deployment's token. `base` is '' for the
// deployment serving this page, else another deployment's console URL (config.console.targets).

export interface Target {
  name: string;
  url: string;
}

const BASE_KEY = 'icebase-console-base';
const tokenKey = (base: string) => `icebase-console-token:${base}`;

interface Session {
  base: string;
  token(base?: string): string | null;
  setToken(token: string, base?: string): void;
  forget(base?: string): void;
}

export const session: Session = {
  get base(): string {
    return sessionStorage.getItem(BASE_KEY) ?? '';
  },
  set base(v: string) {
    sessionStorage.setItem(BASE_KEY, v);
  },
  token(base: string = session.base): string | null {
    return sessionStorage.getItem(tokenKey(base));
  },
  setToken(token: string, base: string = session.base): void {
    sessionStorage.setItem(tokenKey(base), token);
  },
  forget(base: string = session.base): void {
    sessionStorage.removeItem(tokenKey(base));
  },
};

// A token in the address (#token=…): kept for this tab, removed from the address.
{
  const m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
  if (m) {
    session.setToken(decodeURIComponent(m[1]!));
    history.replaceState(null, '', location.pathname + location.hash.replace(/(^#|&)token=[^&]+/, '$1').replace(/^#&/, '#'));
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

/** Set by the shell: called when the deployment refuses the token, resolves once a new one is entered. */
export const auth = { ask: null as null | ((base: string, reason: string) => Promise<boolean>) };

export async function api<T = any>(op: string, body: Record<string, unknown> = {}, base = session.base): Promise<T> {
  const url = `${base ? base.replace(/\/?$/, '/') : ''}api/${op}`;
  const token = session.token(base);
  let r: Response;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  } catch (e) {
    throw new ApiError(`Could not reach ${base || location.host}: ${(e as Error).message}`, 0, 'unavailable');
  }
  const j = (await r.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  if (r.status === 401 || r.status === 403) {
    if (auth.ask && (await auth.ask(base, token ? 'That token was refused.' : ''))) return api<T>(op, body, base);
    throw new ApiError('Not signed in to this deployment', r.status, 'permission-denied');
  }
  if (!r.ok || j.error) throw new ApiError(j.error?.message ?? `HTTP ${r.status}`, r.status, j.error?.code ?? 'internal');
  return j as T;
}

export async function targets(): Promise<Target[]> {
  try {
    return ((await (await fetch('targets.json')).json()) as { targets: Target[] }).targets ?? [];
  } catch {
    return [];
  }
}
