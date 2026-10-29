// Remote Config pieces shared by the client, the admin SDK, the management API and the IceBase
// server: the template (firebase-admin's shape), parameter values as strings and back, and the
// checks of a template against config.remoteConfig.parameters.

import type { RemoteConfigParam, RemoteConfigParams } from '../config.ts';
import { IceBaseError } from '../errors.ts';
import { validateValue } from '../schema.ts';

export type RemoteConfigParameterValue = { value: string } | { useInAppDefault: boolean };
export type RemoteConfigTemplateValueType = 'STRING' | 'BOOLEAN' | 'NUMBER' | 'JSON';

export interface RemoteConfigTemplateParameter {
  defaultValue?: RemoteConfigParameterValue;
  conditionalValues?: Record<string, RemoteConfigParameterValue>;
  description?: string;
  valueType?: RemoteConfigTemplateValueType;
}

export interface RemoteConfigCondition {
  name: string;
  expression: string;
  tagColor?: string;
}

export interface RemoteConfigVersion {
  versionNumber?: string;
  updateTime?: string;
  updateOrigin?: string;
  updateType?: string;
  updateUser?: { email: string; name?: string; imageUrl?: string };
  description?: string;
  rollbackSource?: string;
  isLegacy?: boolean;
}

/** firebase-admin's RemoteConfigTemplate. */
export interface RemoteConfigTemplate {
  conditions: RemoteConfigCondition[];
  parameters: Record<string, RemoteConfigTemplateParameter>;
  parameterGroups: Record<string, { description?: string; parameters: Record<string, RemoteConfigTemplateParameter> }>;
  readonly etag: string;
  version?: RemoteConfigVersion;
}

const TYPE: Record<RemoteConfigParam<unknown>['valueType'], RemoteConfigTemplateValueType> = { string: 'STRING', number: 'NUMBER', boolean: 'BOOLEAN', json: 'JSON' };
export const templateValueType = (p: RemoteConfigParam<unknown>): RemoteConfigTemplateValueType => TYPE[p.valueType];

/** A parameter's value as Remote Config carries it (a string). */
export function paramToString(p: RemoteConfigParam<unknown>, value: unknown): string {
  return p.valueType === 'json' ? JSON.stringify(value) : String(value);
}

/** A string from Remote Config as the parameter's declared type, or why it is not one. */
export function parseParam(p: RemoteConfigParam<unknown>, raw: string, where = 'value'): { ok: true; value: unknown } | { ok: false; error: string } {
  let v: unknown = raw;
  if (p.valueType === 'number') {
    v = raw.trim() === '' ? NaN : Number(raw);
    if (!Number.isFinite(v as number)) return { ok: false, error: `${where}: '${raw}' is not a number` };
  } else if (p.valueType === 'boolean') {
    if (raw !== 'true' && raw !== 'false') return { ok: false, error: `${where}: '${raw}' is not true or false` };
    v = raw === 'true';
  } else if (p.valueType === 'json') {
    try {
      v = JSON.parse(raw);
    } catch {
      return { ok: false, error: `${where}: not JSON` };
    }
  }
  try {
    validateValue(p.schema, v, where);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  return { ok: true, value: v };
}

/** The template config.remoteConfig.parameters describe: each parameter at its in-app default. */
export function defaultTemplate(params: RemoteConfigParams, etag = 'etag-0'): RemoteConfigTemplate {
  const parameters: Record<string, RemoteConfigTemplateParameter> = {};
  for (const [k, p] of Object.entries(params)) parameters[k] = { defaultValue: { value: paramToString(p, p.defaultValue) }, valueType: templateValueType(p), ...(p.description ? { description: p.description } : {}) };
  return { conditions: [], parameters, parameterGroups: {}, etag };
}

/** Every parameter of a template, groups included. */
export function allParameters(t: Pick<RemoteConfigTemplate, 'parameters' | 'parameterGroups'>): Record<string, RemoteConfigTemplateParameter> {
  const out: Record<string, RemoteConfigTemplateParameter> = { ...t.parameters };
  for (const g of Object.values(t.parameterGroups ?? {})) Object.assign(out, g.parameters);
  return out;
}

/**
 * What is wrong with a template for these declarations: a parameter that is not declared, a value
 * type that is not the declared one, a value that does not parse or fit. `conditions: false` (the
 * IceBase server) also refuses conditions, which it does not evaluate.
 */
export function templateIssues(params: RemoteConfigParams, t: Pick<RemoteConfigTemplate, 'parameters' | 'parameterGroups' | 'conditions'>, opts: { conditions?: boolean } = {}): string[] {
  const issues: string[] = [];
  const declared = Object.keys(params).length > 0;
  if (opts.conditions === false && (t.conditions ?? []).length) issues.push('conditions: the IceBase server does not evaluate conditions (firebase mode only)');
  const conds = new Set((t.conditions ?? []).map((c) => c.name));
  for (const [k, tp] of Object.entries(allParameters(t))) {
    const p = params[k];
    if (!p) {
      if (declared) issues.push(`${k}: not declared in config.remoteConfig.parameters`);
      continue;
    }
    if (tp.valueType && tp.valueType !== templateValueType(p)) issues.push(`${k}: valueType ${tp.valueType}, declared ${templateValueType(p)}`);
    const check = (v: RemoteConfigParameterValue | undefined, where: string) => {
      if (!v || 'useInAppDefault' in v) return;
      if (typeof v.value !== 'string') return void issues.push(`${where}: value must be a string`);
      const r = parseParam(p, v.value, where);
      if (!r.ok) issues.push(r.error);
    };
    check(tp.defaultValue, `${k} default`);
    for (const [c, v] of Object.entries(tp.conditionalValues ?? {})) {
      if (opts.conditions === false) issues.push(`${k}: conditional values need conditions (firebase mode only)`);
      else if (!conds.has(c)) issues.push(`${k}: condition '${c}' is not in the template's conditions`);
      check(v, `${k} (${c})`);
    }
  }
  return issues;
}

export function checkTemplate(params: RemoteConfigParams, t: RemoteConfigTemplate, opts: { conditions?: boolean } = {}): void {
  if (!t || typeof t !== 'object' || typeof t.parameters !== 'object') throw new IceBaseError('invalid-argument', 'a Remote Config template needs { parameters, conditions, parameterGroups, etag }', { reason: 'schema', service: 'remoteConfig' });
  const issues = templateIssues(params, t, opts);
  if (issues.length) throw new IceBaseError('invalid-argument', `Remote Config template does not match config.remoteConfig.parameters:\n${issues.map((i) => `  - ${i}`).join('\n')}`, { reason: 'schema', service: 'remoteConfig' });
}

export interface TemplateSync {
  template: RemoteConfigTemplate;
  added: string[];
  removed: string[];
  /** Values that were kept (they still fit their declaration). */
  kept: string[];
  /** Values reset to the declared default (they no longer fit). */
  reset: string[];
  changed: boolean;
}

/**
 * The template that matches the declarations, starting from `current`: declared parameters get their
 * type and description; a value that still fits is kept, one that does not goes back to the
 * declared default; parameters no longer declared are removed. Conditions are kept.
 */
export function syncTemplate(params: RemoteConfigParams, current: RemoteConfigTemplate): TemplateSync {
  const have = allParameters(current);
  const added: string[] = [];
  const kept: string[] = [];
  const reset: string[] = [];
  const parameters: Record<string, RemoteConfigTemplateParameter> = {};
  const conds = new Set((current.conditions ?? []).map((c) => c.name));
  for (const [k, p] of Object.entries(params)) {
    const def: RemoteConfigParameterValue = { value: paramToString(p, p.defaultValue) };
    const fits = (v: RemoteConfigParameterValue | undefined) => !!v && ('useInAppDefault' in v || (typeof v.value === 'string' && parseParam(p, v.value).ok));
    const old = have[k];
    if (!old) added.push(k);
    else if (fits(old.defaultValue) && (!old.valueType || old.valueType === templateValueType(p))) kept.push(k);
    else reset.push(k);
    const conditional = Object.fromEntries(Object.entries(old?.conditionalValues ?? {}).filter(([c, v]) => conds.has(c) && fits(v)));
    parameters[k] = {
      defaultValue: old && kept.includes(k) ? old.defaultValue! : def,
      valueType: templateValueType(p),
      ...(p.description ? { description: p.description } : {}),
      ...(Object.keys(conditional).length ? { conditionalValues: conditional } : {}),
    };
  }
  const removed = Object.keys(have).filter((k) => !params[k]);
  const template: RemoteConfigTemplate = { conditions: current.conditions ?? [], parameters, parameterGroups: {}, etag: current.etag };
  const changed = added.length + removed.length + reset.length > 0 || JSON.stringify(sortKeys(parameters)) !== JSON.stringify(sortKeys(allParameters(current)));
  return { template, added, removed, kept, reset, changed };
}

const sortKeys = (o: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, v && typeof v === 'object' && !Array.isArray(v) ? sortKeys(v as Record<string, unknown>) : v]));

/** What a client's fetch gets: each parameter's value as a string (in-app defaults left out). */
export function templateEntries(t: RemoteConfigTemplate): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, p] of Object.entries(allParameters(t))) if (p.defaultValue && 'value' in p.defaultValue) out[k] = p.defaultValue.value;
  return out;
}
