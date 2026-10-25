// `icebase check` — a dry run of the declarations: the schema and the API describe themselves
// consistently (describe().problems), and every declared endpoint is implemented by the functions
// source — no more, no less — with nothing undeclared reachable from outside.

import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { AnyConfig } from '@panth977/icebase/config';
import { describe, type ProjectDoc } from '@panth977/icebase/describe';

export interface CheckResult {
  doc: ProjectDoc;
  problems: string[];
  warnings: string[];
}

export async function checkProject(config: AnyConfig, root: string, opts: { strict?: boolean } = {}): Promise<CheckResult> {
  const doc = describe(config);
  const problems = [...doc.problems];
  const warnings: string[] = [];
  const declared = new Map(doc.endpoints.map((e) => [e.name, e]));
  const src = config.functions?.source;
  const dir = src ? resolve(root, src) : null;
  if (dir && existsSync(dir)) {
    const pkg = existsSync(join(dir, 'package.json')) ? (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { main?: string }) : {};
    const entry = resolve(dir, pkg.main ?? (existsSync(join(dir, 'src/index.ts')) ? 'src/index.ts' : 'index.js'));
    // Loading the functions source does not start anything: exports are only inspected.
    process.env.ICEBASE_CHECK = '1';
    const { importTs } = await import('./load.ts');
    const mod = (await importTs(pathToFileURL(entry).href)) as Record<string, { __icebase?: { kind: string; endpoint?: { name: string; http?: unknown } } }>;
    const implemented = new Set<string>();
    for (const [name, v] of Object.entries(mod)) {
      const r = v?.__icebase;
      if (!r) continue;
      if (r.kind !== 'call' && r.kind !== 'request') continue;
      if (r.endpoint) {
        if (r.endpoint.name !== name) problems.push(`export '${name}' implements api.${r.endpoint.name}: export it as '${r.endpoint.name}' (clients call it by that name)`);
        if (!declared.has(r.endpoint.name)) problems.push(`export '${name}' implements an endpoint that is not in config.api`);
        implemented.add(r.endpoint.name);
      } else {
        const msg = `${r.kind === 'call' ? 'callable' : 'HTTP function'} '${name}' has no declared schema: declare it in config.api and pass it to ${r.kind === 'call' ? 'onCall' : 'onRequest'}(api.${name}, …)`;
        (opts.strict ? problems : warnings).push(msg);
      }
    }
    for (const name of declared.keys()) if (!implemented.has(name)) problems.push(`api.${name} is declared but no function implements it`);
  } else if (doc.endpoints.length) {
    warnings.push('config.api declares endpoints but there is no functions source to check them against');
  }
  return { doc, problems, warnings };
}
