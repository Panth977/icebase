// Remote Config on the IceBase server: the template (firebase-admin's shape) with its versions, in
// the 'remoteconfig' store. Until one is published the template is config.remoteConfig.parameters
// at their defaults (version 0). Clients fetch the values (POST /v1/rc/fetch); a publish is pushed
// to the clients listening ({ s: 'rc' } on the realtime socket) so onConfigUpdate fires.
// Conditions are not evaluated here, so a template with conditions is refused.
//
//   POST /v1/rc/fetch                                     → { entries, templateVersion }
//   POST /__/icebase/admin/manage/remoteConfig/<op>       getTemplate, publishTemplate, validateTemplate, listVersions, getTemplateAtVersion, rollback

import { createHash } from 'node:crypto';
import type { RemoteConfigParams } from '@panth977/icebase/config';
import { IceBaseError } from '@panth977/icebase/errors';
import { checkTemplate, defaultTemplate, templateEntries, type RemoteConfigTemplate } from '@panth977/icebase/internal';
import { json, type EmulatorContext, type Live, type Service } from './server.ts';
import { remoteConfigTables } from './tables.ts';

const etagOf = (version: number, t: Pick<RemoteConfigTemplate, 'parameters' | 'conditions' | 'parameterGroups'>) => `etag-${version}-${createHash('sha256').update(JSON.stringify([t.conditions, t.parameters, t.parameterGroups])).digest('hex').slice(0, 16)}`;

export async function remoteConfigService(ctx: EmulatorContext): Promise<Service> {
  const sql = await ctx.stores.open('remoteconfig');
  await remoteConfigTables(sql);
  const params = (ctx.config.remoteConfig?.parameters ?? {}) as RemoteConfigParams;
  // Sockets listening for publishes: each (socket, listen id).
  const listeners = new Map<Live, Set<string>>();

  const at = async (version?: number): Promise<RemoteConfigTemplate> => {
    const row = version === undefined ? await sql.get<{ version: number; template: string; at: number }>(`SELECT version, template, at FROM versions ORDER BY version DESC LIMIT 1`) : await sql.get<{ version: number; template: string; at: number }>(`SELECT version, template, at FROM versions WHERE version = ?`, version);
    if (!row) {
      if (version !== undefined && version !== 0) throw new IceBaseError('not-found', `Remote Config: no version ${version}`);
      const t = defaultTemplate(params);
      return { ...t, etag: etagOf(0, t) };
    }
    const t = JSON.parse(row.template) as RemoteConfigTemplate;
    return { ...t, etag: etagOf(Number(row.version), t), version: { ...t.version, versionNumber: String(row.version), updateTime: new Date(Number(row.at)).toUTCString() } };
  };

  const publish = async (t: RemoteConfigTemplate, opts: { force?: boolean; rollbackSource?: string; description?: string } = {}): Promise<RemoteConfigTemplate> => {
    checkTemplate(params, t, { conditions: false });
    const out = await sql.transaction(async (tx) => {
      const row = await tx.get<{ version: number; template: string }>(`SELECT version, template FROM versions ORDER BY version DESC LIMIT 1`);
      const cur = row ? Number(row.version) : 0;
      const curEtag = row ? etagOf(cur, JSON.parse(row.template) as RemoteConfigTemplate) : etagOf(0, defaultTemplate(params));
      if (!opts.force && t.etag !== '*' && t.etag !== curEtag) throw new IceBaseError('failed-precondition', 'Remote Config: the template changed since it was read (etag mismatch); get it again, or publish with { force: true }');
      const version = cur + 1;
      const stored = {
        conditions: [],
        parameters: t.parameters,
        parameterGroups: t.parameterGroups ?? {},
        version: { updateOrigin: 'ADMIN_SDK_NODE', updateType: opts.rollbackSource ? 'ROLLBACK' : 'INCREMENTAL_UPDATE', ...(opts.rollbackSource ? { rollbackSource: opts.rollbackSource } : {}), ...((opts.description ?? t.version?.description) ? { description: opts.description ?? t.version?.description } : {}) },
      };
      await tx.run(`INSERT INTO versions (version, template, at) VALUES (?, ?, ?)`, version, JSON.stringify(stored), Date.now());
      return version;
    });
    for (const [live, ids] of listeners) for (const id of ids) live.send({ s: 'rc', id, t: 'updated', version: out });
    return at(out);
  };

  return {
    async handle(req, url) {
      if (url.pathname !== '/v1/rc/fetch') return null;
      if (req.method !== 'POST') return json({ error: { code: 'invalid-argument', message: 'POST' } }, 400);
      const t = await at();
      return json({ entries: templateEntries(t), templateVersion: Number(t.version?.versionNumber ?? 0), state: 'UPDATE' });
    },
    socket(live, msg) {
      const id = String(msg.id);
      if (msg.t === 'listen') {
        let ids = listeners.get(live);
        if (!ids) {
          listeners.set(live, (ids = new Set()));
          live.onClose(() => listeners.delete(live));
        }
        ids.add(id);
      } else if (msg.t === 'unlisten') listeners.get(live)?.delete(id);
    },
    async manage(op, b) {
      switch (op) {
        case 'getTemplate':
          return at();
        case 'getTemplateAtVersion':
          return at(Number(b.versionNumber));
        case 'validateTemplate':
          checkTemplate(params, b.template as RemoteConfigTemplate, { conditions: false });
          return b.template;
        case 'publishTemplate':
          return publish(b.template as RemoteConfigTemplate, { force: !!b.force });
        case 'rollback': {
          const v = Number(b.versionNumber);
          const old = await at(v);
          return publish({ ...old, etag: '*' }, { rollbackSource: String(v) });
        }
        case 'listVersions': {
          const rows = await sql.all<{ version: number; template: string; at: number }>(`SELECT version, template, at FROM versions ORDER BY version DESC LIMIT ?`, Math.min(Number(b.pageSize ?? 100), 300));
          return { versions: rows.map((r) => ({ ...(JSON.parse(r.template) as RemoteConfigTemplate).version, versionNumber: String(r.version), updateTime: new Date(Number(r.at)).toUTCString() })) };
        }
      }
      throw new IceBaseError('invalid-argument', `remoteConfig: no management operation '${op}'`);
    },
  };
}
