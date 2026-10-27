// Hosting's management API on the IceBase server (icebase/manage in emulator mode): sites,
// releases deployed from code, and custom domains. A release is kept in the data directory and
// served instead of config.hosting.public; a custom domain serves its site to requests whose
// Host is that domain. Only `icebase serve` (hosting on the same port) serves them.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { isIP } from 'node:net';
import { Buffer } from 'node:buffer';
import { IceBaseError } from '@panth977/icebase/errors';
import type { EmulatorContext, Service } from './server.ts';
import { callerOrigin } from './storage-service.ts';

interface SitesState {
  sites: Record<string, { release?: string; releasedAt?: string; message?: string }>;
  domains: Record<string, string>;
}

/** A Hosting site id as Firebase takes it: 6–30 of a-z 0-9 -, not starting or ending with -. */
const SITE_ID = /^[a-z0-9][a-z0-9-]{4,28}[a-z0-9]$/;

export interface HostingSites extends Service {
  /** The directory to serve for a request (null: config.hosting.public), or 'none' for a site with nothing released. */
  dirFor(host: string): { site: string; dir: string | null } | 'none';
}

export function hostingSites(ctx: EmulatorContext): HostingSites {
  const base = ctx.dataDir === ':memory:' ? mkdtempSync(join(tmpdir(), 'icebase-hosting-')) : join(ctx.dataDir, 'hosting');
  mkdirSync(base, { recursive: true });
  const stateFile = join(base, 'sites.json');
  const defaultSite = ctx.config.hosting?.site ?? ctx.projectId;
  const state: SitesState = existsSync(stateFile) ? (JSON.parse(readFileSync(stateFile, 'utf8')) as SitesState) : { sites: {}, domains: {} };
  state.sites[defaultSite] ??= {};
  const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const siteInfo = (id: string, origin: string) => ({ name: `projects/${ctx.projectId}/sites/${id}`, defaultUrl: id === defaultSite ? origin : `${origin} (Host: a custom domain of ${id})` });
  const siteOf = (b: Record<string, unknown>) => {
    const id = typeof b.site === 'string' ? b.site : defaultSite;
    if (!state.sites[id]) throw new IceBaseError('not-found', `no Hosting site '${id}' (create it with createSite('${id}'))`);
    return id;
  };

  return {
    handle: () => null,
    dirFor(host) {
      const site = state.domains[host.toLowerCase()] ?? defaultSite;
      const s = state.sites[site];
      if (s?.release) return { site, dir: join(base, site, s.release) };
      return site === defaultSite ? { site, dir: null } : 'none';
    },
    manage(op, b, req) {
      const origin = req ? callerOrigin(req, ctx.origin) : ctx.origin;
      switch (op) {
        case 'listSites':
          return { sites: Object.keys(state.sites).map((id) => siteInfo(id, origin)) };
        case 'createSite': {
          const id = String(b.siteId ?? '');
          if (!SITE_ID.test(id)) throw new IceBaseError('invalid-argument', `createSite('${id}'): a site id is 6–30 characters of a-z, 0-9 and -`);
          if (state.sites[id]) throw new IceBaseError('already-exists', `Hosting site '${id}' already exists`);
          state.sites[id] = {};
          save();
          return siteInfo(id, origin);
        }
        case 'deploy': {
          const site = siteOf(b);
          const files = (b.files ?? {}) as Record<string, string>;
          if (!Object.keys(files).length) throw new IceBaseError('invalid-argument', 'deploy: no files');
          const version = `v${Date.now().toString(36)}`;
          const root = join(base, site, version);
          for (const [p, b64] of Object.entries(files)) {
            const full = normalize(join(root, p));
            if (!full.startsWith(root + sep)) throw new IceBaseError('invalid-argument', `deploy: '${p}' is outside the site`);
            mkdirSync(dirname(full), { recursive: true });
            writeFileSync(full, Buffer.from(b64, 'base64'));
          }
          state.sites[site] = { release: version, releasedAt: new Date().toISOString(), ...(typeof b.message === 'string' ? { message: b.message } : {}) };
          save();
          const n = Object.keys(files).length;
          return { version: `sites/${site}/versions/${version}`, release: `sites/${site}/releases/${version}`, files: n, uploaded: n, url: siteInfo(site, origin).defaultUrl };
        }
        case 'setDNS': {
          const site = siteOf(b);
          const domain = String(b.domain ?? '').toLowerCase();
          if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new IceBaseError('invalid-argument', `setDNS('${domain}'): not a domain name`);
          state.domains[domain] = site;
          save();
          // Point the domain at this server: an A record for an IP address, else a CNAME.
          const host = new URL(origin).hostname;
          const records = [{ domainName: domain, type: isIP(host) ? 'A' : 'CNAME', rdata: host, requiredAction: 'ADD' }];
          return { domain, hostState: 'HOST_ACTIVE', ownershipState: 'OWNERSHIP_ACTIVE', records };
        }
      }
      throw new IceBaseError('invalid-argument', `hosting: no management operation '${op}'`);
    },
  };
}
