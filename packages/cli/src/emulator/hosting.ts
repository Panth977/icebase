// Hosting in emulator mode: config.hosting served like Firebase Hosting serves firebase.json —
// redirects, then exact files, then rewrites (to a path or to a function on the IceBase
// server), headers, cleanUrls, trailingSlash, and 404.html.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve } from 'node:path';
import type { AnyConfig } from '@panth977/icebase/config';
import { nodeListener } from '@panth977/icebase-server/internal';
import { Buffer } from 'node:buffer';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.pdf': 'application/pdf',
};

/** Firebase Hosting globs: ** any path, * one segment, {a,b} alternatives. */
export function globRe(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      re += `(?:${glob.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
      i = end;
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export async function startHosting(opts: { config: AnyConfig; root: string; port: number; host?: string; functionsOrigin: string; projectId: string; log?: (l: string) => void }): Promise<{ url: string; close(): Promise<void> }> {
  const h = opts.config.hosting!;
  const pub = resolve(opts.root, h.public);
  const region = opts.config.functions?.region ?? 'us-central1';
  const file = (p: string): string | null => {
    const full = normalize(join(pub, decodeURIComponent(p)));
    if (!full.startsWith(pub)) return null;
    if (existsSync(full) && statSync(full).isFile()) return full;
    if (existsSync(full) && statSync(full).isDirectory() && existsSync(join(full, 'index.html'))) return join(full, 'index.html');
    if (h.cleanUrls && existsSync(`${full}.html`)) return `${full}.html`;
    return null;
  };
  const headersFor = (p: string) => {
    const out: Record<string, string> = {};
    for (const x of h.headers ?? []) if (globRe(x.source).test(p)) Object.assign(out, x.headers);
    return out;
  };
  const send = (path: string, f: string, status = 200) => new Response(readFileSync(f), { status, headers: { 'content-type': TYPES[extname(f).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...headersFor(path) } });

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    let path = url.pathname;
    for (const r of h.redirects ?? []) if (globRe(r.source).test(path)) return new Response(null, { status: r.type ?? 301, headers: { location: r.destination } });
    if (h.cleanUrls && path.endsWith('.html')) return new Response(null, { status: 301, headers: { location: path.replace(/(index)?\.html$/, '') || '/' } });
    if (h.trailingSlash === true && !path.endsWith('/') && !extname(path)) return new Response(null, { status: 301, headers: { location: `${path}/` } });
    if (h.trailingSlash === false && path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const direct = file(path);
    if (direct) return send(path, direct);
    const rewrites = [...(h.rewrites ?? []), ...(h.spa ? [{ source: '**', destination: '/index.html' }] : [])];
    for (const r of rewrites) {
      if (!globRe(r.source).test(path)) continue;
      if ('function' in r) {
        // Same as Firebase Hosting: the function sees the original path.
        const target = new URL(`${opts.functionsOrigin}/${opts.projectId}/${r.region ?? region}/${r.function}${path}${url.search}`);
        const res = await fetch(target, { method: req.method, headers: req.headers, ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: await req.arrayBuffer() } : {}) });
        const hd = new Headers(res.headers);
        for (const [k, v] of Object.entries(headersFor(path))) hd.set(k, v);
        hd.delete('content-encoding');
        return new Response(res.body, { status: res.status, headers: hd });
      }
      const f = file(r.destination);
      if (f) return send(path, f);
    }
    const nf = file('/404.html');
    return nf ? send(path, nf, 404) : new Response('Not found', { status: 404 });
  };

  const server: Server = createServer(nodeListener(handler));
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((r, j) => {
    server.once('error', j);
    server.listen(opts.port, host, r);
  });
  const url = `http://${host}:${(server.address() as AddressInfo).port}`;
  opts.log?.(`hosting: ${h.public} on ${url}`);
  return { url, close: () => new Promise((r) => server.close(() => r())) };
}
