// Serve a fetch-style handler (Request → Response) on node:http. Used by the IceBase
// emulator server and to mount handlers inside firebase-functions' onRequest.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Buffer } from 'node:buffer';

export type FetchHandler = (req: Request) => Promise<Response> | Response;

/** Turn a node request into a fetch Request. `base` is the public origin (+ path prefix) the handler sees. */
export async function toRequest(req: IncomingMessage & { rawBody?: Buffer; body?: unknown }, base?: string, signal?: AbortSignal): Promise<Request> {
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost';
  const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? 'http';
  const url = base ? `${base.replace(/\/$/, '')}${req.url ?? '/'}` : `${proto}://${host}${req.url ?? '/'}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach((x) => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  if (!headers.has('x-forwarded-for') && req.socket.remoteAddress) headers.set('x-forwarded-for', req.socket.remoteAddress);
  let body: Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (req.rawBody) body = req.rawBody; // firebase-functions has already read the stream
    else {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = Buffer.concat(chunks);
    }
  }
  return new Request(url, { method: req.method ?? 'GET', headers, ...(signal ? { signal } : {}), ...(body && body.length ? { body: new Uint8Array(body) } : {}) });
}

export async function sendResponse(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => {
    if (k === 'set-cookie') headers[k] = [...((headers[k] as string[] | undefined) ?? []), v];
    else headers[k] = v;
  });
  res.writeHead(r.status, headers);
  if (r.body) {
    const reader = r.body.getReader();
    // The client went away: stop reading (a stream such as server-sent events ends here).
    const gone = () => void reader.cancel().catch(() => {});
    res.once('close', gone);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done || res.destroyed) break;
        res.write(value);
      }
    } finally {
      res.off('close', gone);
    }
  }
  res.end();
}

/** Run a fetch handler for a node request: the Request's signal aborts when the client disconnects. */
export async function serveFetch(req: IncomingMessage & { rawBody?: Buffer }, res: ServerResponse, handler: FetchHandler, base?: string): Promise<void> {
  const ac = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  await sendResponse(res, await handler(await toRequest(req, base, ac.signal)));
}

/** A node (req, res) listener for a fetch handler. */
export function nodeListener(handler: FetchHandler, base?: string): (req: IncomingMessage, res: ServerResponse) => void {
  return (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        await serveFetch(req, res, handler, base);
      } catch (e) {
        console.error('[icebase]', e);
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
    })();
  };
}

export async function serve(handler: FetchHandler, port = 0, host = '127.0.0.1'): Promise<{ server: Server; url: string; close(): Promise<void> }> {
  const server = createServer(nodeListener(handler));
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const a = server.address() as AddressInfo;
  return { server, url: `http://${host}:${a.port}`, close: () => new Promise((r) => server.close(() => r())) };
}
