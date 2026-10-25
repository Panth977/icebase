// Hosting in emulator mode: config.hosting served like Firebase Hosting serves firebase.json —
// redirects, then exact files, then rewrites (to a path or to a function on the IceBase
// server), headers, cleanUrls, trailingSlash, and 404.html.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib';
import type { AnyConfig } from '@panth977/icebase/config';
import { nodeListener } from '@panth977/icebase-server/internal';
import { Buffer } from 'node:buffer';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.webmanifest': 'application/manifest+json', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf', '.zip': 'application/zip', '.tgz': 'application/gzip', '.gz': 'application/gzip', '.ts': 'application/typescript; charset=utf-8', '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8', '.xml': 'application/xml', '.avif': 'image/avif', '.ttf': 'font/ttf', '.otf': 'font/otf', '.yaml': 'application/yaml', '.yml': 'application/yaml',
};

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|manifest\+json|xml|wasm)|image\/svg)/;

/** Firebase Hosting globs: ** any path, * one segment, {a,b} alternatives, a leading ! negates. */
export function globRe(glob: string): { test(path: string): boolean } {
  if (glob.startsWith('!')) {
    const re = globRe(glob.slice(1));
    return { test: (p) => !re.test(p) };
  }
  return globRegExp(glob);
}
function globRegExp(glob: string): RegExp {
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

export interface HostingOptions {
  config: AnyConfig;
  root: string;
  /** Run a function rewrite: the function's name, its region and the original path + query. */
  callFunction: (req: Request, fn: string, region: string, pathAndQuery: string) => Promise<Response>;
  /**
   * Production serving (`icebase serve`): files are read once and kept in memory with an ETag,
   * text is sent brotli / gzip compressed, and hashed build assets are cached for a year.
   */
  production?: boolean;
}

/** Hosting as a fetch handler — config.hosting, served as Firebase Hosting serves it. */
export function hostingHandler(opts: HostingOptions): (req: Request) => Promise<Response> {
  const h = opts.config.hosting!;
  const pub = resolve(opts.root, h.public);
  const region = opts.config.functions?.region ?? 'us-central1';
  const file = (p: string): string | null => {
    let rel: string;
    try {
      rel = decodeURIComponent(p);
    } catch {
      return null;
    }
    const full = normalize(join(pub, rel));
    if (full !== pub && !full.startsWith(pub + sep)) return null;
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
  // Production: each file read once (a deploy never changes under a running server).
  const cache = new Map<string, { raw: Buffer; etag: string; br?: Buffer; gzip?: Buffer }>();
  const cached = (f: string) => {
    let c = cache.get(f);
    if (!c) {
      const raw = readFileSync(f);
      c = { raw, etag: `"${createHash('sha1').update(raw).digest('base64url')}"` };
      cache.set(f, c);
    }
    return c;
  };
  const send = (req: Request, path: string, f: string, status = 200): Response => {
    const type = TYPES[extname(f).toLowerCase()] ?? 'application/octet-stream';
    if (!opts.production) return new Response(req.method === 'HEAD' ? null : new Uint8Array(readFileSync(f)), { status, headers: { 'content-type': type, 'cache-control': 'no-cache', ...headersFor(path) } });
    const c = cached(f);
    const headers: Record<string, string> = {
      'content-type': type,
      // Hosting's defaults: HTML revalidates; hashed build assets never change.
      'cache-control': f.endsWith('.html') ? 'no-cache' : /\/(immutable|assets)\//.test(path) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
      etag: c.etag,
      vary: 'accept-encoding',
      ...headersFor(path),
    };
    if (status === 200 && req.headers.get('if-none-match') === c.etag) return new Response(null, { status: 304, headers });
    let body = c.raw;
    const ae = req.headers.get('accept-encoding') ?? '';
    if (c.raw.length > 1024 && COMPRESSIBLE.test(type)) {
      if (/\bbr\b/.test(ae)) {
        body = c.br ??= brotliCompressSync(c.raw, { params: { [zlib.BROTLI_PARAM_QUALITY]: 9 } });
        headers['content-encoding'] = 'br';
      } else if (/\bgzip\b/.test(ae)) {
        body = c.gzip ??= gzipSync(c.raw, { level: 9 });
        headers['content-encoding'] = 'gzip';
      }
    }
    headers['content-length'] = String(body.length);
    return new Response(req.method === 'HEAD' ? null : new Uint8Array(body), { status, headers });
  };

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    let path = url.pathname;
    for (const r of h.redirects ?? []) if (globRe(r.source).test(path)) return new Response(null, { status: r.type ?? 301, headers: { location: r.destination } });
    if (h.cleanUrls && path.endsWith('.html')) return new Response(null, { status: 301, headers: { location: path.replace(/(index)?\.html$/, '') || '/' } });
    if (h.trailingSlash === true && !path.endsWith('/') && !extname(path)) return new Response(null, { status: 301, headers: { location: `${path}/` } });
    if (h.trailingSlash === false && path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const isRead = req.method === 'GET' || req.method === 'HEAD';
    // An existing file wins over every rewrite.
    const direct = isRead ? file(path) : null;
    if (direct) return send(req, path, direct);
    const rewrites = [...(h.rewrites ?? []), ...(h.spa ? [{ source: '**', destination: '/index.html' }] : [])];
    for (const r of rewrites) {
      if (!globRe(r.source).test(path)) continue;
      if ('function' in r) {
        // Same as Firebase Hosting: the function sees the original path.
        const fn = typeof r.function === 'string' ? { functionId: r.function, region: r.region } : r.function;
        const res = await opts.callFunction(req, fn.functionId, fn.region ?? r.region ?? region, `${path}${url.search}`);
        const hd = new Headers(res.headers);
        for (const [k, v] of Object.entries(headersFor(path))) hd.set(k, v);
        return new Response(res.body, { status: res.status, headers: hd });
      }
      const f = isRead ? file(r.destination) : null;
      if (f) return send(req, path, f);
    }
    const nf = file('/404.html');
    return nf ? send(req, path, nf, 404) : new Response('Not found', { status: 404 });
  };
}

export async function startHosting(opts: { config: AnyConfig; root: string; port: number; host?: string; functionsOrigin: string; projectId: string; log?: (l: string) => void }): Promise<{ url: string; close(): Promise<void> }> {
  const handler = hostingHandler({
    config: opts.config,
    root: opts.root,
    callFunction: async (req, fn, region, pathAndQuery) => {
      const res = await fetch(`${opts.functionsOrigin}/${opts.projectId}/${region}/${fn}${pathAndQuery}`, { method: req.method, headers: req.headers, ...(req.method !== 'GET' && req.method !== 'HEAD' ? { body: await req.arrayBuffer() } : {}) });
      const hd = new Headers(res.headers);
      hd.delete('content-encoding');
      return new Response(res.body, { status: res.status, headers: hd });
    },
  });
  const server: Server = createServer(nodeListener(handler));
  const host = opts.host ?? '127.0.0.1';
  await new Promise<void>((r, j) => {
    server.once('error', j);
    server.listen(opts.port, host, r);
  });
  const url = `http://${host}:${(server.address() as AddressInfo).port}`;
  opts.log?.(`hosting: ${opts.config.hosting!.public} on ${url}`);
  return { url, close: () => new Promise((r) => server.close(() => r())) };
}
