// The console's API: POST api/<op> on the deployment serving this page, with its token. A console
// manages that one deployment only: it knows of no other.

const TOKEN_KEY = 'icebase-console-token';

export const session = {
  token(): string | null {
    return sessionStorage.getItem(TOKEN_KEY);
  },
  setToken(token: string): void {
    sessionStorage.setItem(TOKEN_KEY, token);
  },
  forget(): void {
    sessionStorage.removeItem(TOKEN_KEY);
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
export const auth = { ask: null as null | ((reason: string) => Promise<boolean>) };

export async function api<T = any>(op: string, body: Record<string, unknown> = {}): Promise<T> {
  const url = `api/${op}`;
  const token = session.token();
  let r: Response;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  } catch (e) {
    throw new ApiError(`Could not reach ${location.host}: ${(e as Error).message}`, 0, 'unavailable');
  }
  const j = (await r.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
  if (r.status === 401 || r.status === 403) {
    if (auth.ask && (await auth.ask(token ? 'That token was refused.' : ''))) return api<T>(op, body);
    throw new ApiError('Not signed in', r.status, 'permission-denied');
  }
  if (!r.ok || j.error) throw new ApiError(j.error?.message ?? `HTTP ${r.status}`, r.status, j.error?.code ?? 'internal');
  return j as T;
}
