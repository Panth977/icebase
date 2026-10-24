// One WebSocket per app to the IceBase server, shared by Firestore and the Realtime Database
// listeners. Reconnects and re-subscribes; re-authenticates when the caller's token changes.

import { IceBaseError } from '../errors.js';

type Handler = { onMessage(m: Record<string, unknown>): void; onError(e: Error): void; subscribe: Record<string, unknown> };

export class RealtimeClient {
  private ws: WebSocket | null = null;
  private open: Promise<void> | null = null;
  private readonly subs = new Map<string, Handler>();
  private token: string | null = null;
  private closed = false;
  private retry = 250;

  constructor(
    private readonly url: string,
    private readonly getToken: () => Promise<string | null>,
  ) {}

  private key(s: string, id: string) {
    return `${s}:${id}`;
  }

  private connect(): Promise<void> {
    if (this.open) return this.open;
    this.open = new Promise<void>((resolve, reject) => {
      const WS = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
      if (!WS) return reject(new IceBaseError('unavailable', 'realtime listeners need a global WebSocket (Node 22+ or a browser)'));
      const ws = new WS(this.url);
      this.ws = ws;
      ws.onopen = async () => {
        this.retry = 250;
        this.token = await this.getToken();
        ws.send(JSON.stringify({ t: 'auth', token: this.token }));
        for (const h of this.subs.values()) ws.send(JSON.stringify(h.subscribe));
        resolve();
      };
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data)) as Record<string, unknown>;
        if (m.t === 'authed') return;
        const h = this.subs.get(this.key(String(m.s), String(m.id)));
        if (!h) return;
        if (m.t === 'error') {
          const e = m.error as { code: IceBaseError['code']; message: string };
          this.subs.delete(this.key(String(m.s), String(m.id)));
          h.onError(new IceBaseError(e.code, e.message));
        } else h.onMessage(m);
      };
      ws.onclose = () => {
        this.ws = null;
        this.open = null;
        if (this.closed || this.subs.size === 0) return;
        setTimeout(() => void this.connect().catch(() => {}), (this.retry = Math.min(this.retry * 2, 5000)));
      };
      ws.onerror = () => reject(new IceBaseError('unavailable', `cannot reach the IceBase emulator at ${this.url}`));
    });
    return this.open;
  }

  /** Subscribe; returns the unsubscribe. */
  listen(s: string, id: string, subscribe: Record<string, unknown>, onMessage: Handler['onMessage'], onError: Handler['onError']): () => void {
    const h: Handler = { onMessage, onError, subscribe: { s, id, t: 'listen', ...subscribe } };
    this.subs.set(this.key(s, id), h);
    void (async () => {
      try {
        const wasOpen = !!this.ws && this.ws.readyState === 1;
        await this.connect();
        // Signed in or out since the socket authenticated: tell the server before subscribing.
        const t = await this.getToken();
        if (t !== this.token) {
          this.token = t;
          this.ws?.send(JSON.stringify({ t: 'auth', token: t }));
        }
        if (wasOpen && this.subs.get(this.key(s, id)) === h) this.ws?.send(JSON.stringify(h.subscribe));
      } catch (e) {
        if (this.subs.get(this.key(s, id)) === h) {
          this.subs.delete(this.key(s, id));
          onError(e as Error);
        }
      }
    })();
    return () => {
      if (this.subs.get(this.key(s, id)) !== h) return;
      this.subs.delete(this.key(s, id));
      if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ s, id, t: 'unlisten' }));
    };
  }

  /** Send one message and wait for its { t: 'ok' } (or error). */
  request(s: string, msg: Record<string, unknown>): Promise<void> {
    const id = nextId();
    return new Promise<void>((resolve, reject) => {
      const h: Handler = {
        subscribe: { s, id, ...msg },
        onMessage: () => {
          this.subs.delete(this.key(s, id));
          resolve();
        },
        onError: reject,
      };
      this.subs.set(this.key(s, id), h);
      // A socket that opens now sends every pending message itself; an open one needs this send.
      const wasOpen = this.ws?.readyState === 1;
      void this.connect().then(
        () => wasOpen && this.ws?.send(JSON.stringify(h.subscribe)),
        (e) => {
          this.subs.delete(this.key(s, id));
          reject(e);
        },
      );
    });
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
  }
}

let seq = 0;
export const nextId = () => `l${++seq}`;
