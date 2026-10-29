// Remote Config, Cloud Messaging and App Check without a server: the declarations, the shared
// encoding and checks, and firebase mode's checks before anything reaches Firebase (Firebase has no
// emulator for these three, so firebase mode is covered at this level).
import { afterAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp } from '@panth977/icebase/app';
import { defineConfig, param } from '@panth977/icebase/config';
import { defineSchema, f } from '@panth977/icebase/schema';
import { checkMessage, decodeMessageData, defaultTemplate, encodeMessageData, matchCondition, parseCondition, syncTemplate, templateIssues } from '@panth977/icebase/internal';
import { getAdminMessaging, getAdminRemoteConfig, initializeAdminApp, type TypedMessage } from '@panth977/icebase-server/admin';
import { DebugProvider, initializeAppCheck } from '@panth977/icebase/app-check';
import { getAll, getBoolean, getNumber, getParameter, getRemoteConfig, getValue } from '@panth977/icebase/remote-config';

const kinds = { shipped: { orderId: f.string(), eta: f.optional(f.number()), tags: f.array(f.enum(['a', 'b'])) } };
const params = { title: param.string('Hi'), limit: param.number(3, { int: true, min: 1 }), on: param.boolean(false), cfg: param.json(f.map({ n: f.number() }), { n: 1 }) };
const cfg = defineConfig({
  name: 'svc-unit',
  schema: defineSchema({}),
  firebase: { projectId: 'demo-svc-unit', webConfig: { apiKey: 'x', projectId: 'demo-svc-unit', appId: '1:1:web:1' } },
  remoteConfig: { parameters: params },
  messaging: { messages: kinds },
  environments: { prod: { mode: 'firebase' } },
});

describe('declarations', () => {
  const base = { name: 'x', schema: defineSchema({}), environments: { local: { mode: 'emulator' as const } } };
  it('refuses bad parameter names, defaults that do not fit, reserved message keys, unknown App Check services', () => {
    expect(() => defineConfig({ ...base, remoteConfig: { parameters: { '1bad': param.string('x') } } })).toThrow(/parameter name/);
    expect(() => defineConfig({ ...base, remoteConfig: { parameters: { n: param.number(0, { min: 1 }) } } })).toThrow(/n default/);
    expect(() => defineConfig({ ...base, messaging: { messages: { k: { icebaseKind: f.string() } } } })).toThrow(/reserved/);
    expect(() => defineConfig({ ...base, messaging: { messages: { k: { at: f.timestamp() } } } })).toThrow(/cannot travel/);
    expect(() => defineConfig({ ...base, appCheck: { enforce: ['auth' as never] } })).toThrow(/appCheck.enforce/);
    expect(() => defineConfig({ ...base, environments: { local: { mode: 'emulator', services: { remoteConfig: 'firebase' } } }, firebase: { projectId: 'p' } })).not.toThrow();
  });
});

describe('messaging encoding', () => {
  it('typed data ⇄ FCM strings', () => {
    const wire = encodeMessageData(kinds, 'shipped', { orderId: 'o1', eta: 2, tags: ['a'] });
    expect(wire).toEqual({ icebaseKind: 'shipped', orderId: 'o1', eta: '2', tags: '["a"]' });
    expect(decodeMessageData(kinds, wire)).toEqual({ kind: 'shipped', data: { orderId: 'o1', eta: 2, tags: ['a'] } });
    expect(decodeMessageData(kinds, { x: '1' })).toEqual({ kind: undefined, data: { x: '1' } });
    expect(decodeMessageData(kinds, { icebaseKind: 'shipped', orderId: 'o', tags: '["z"]' }).kind).toBeUndefined();
    expect(() => encodeMessageData(kinds, 'shipped', { orderId: 'o' })).toThrow(/tags/);
  });
  it('targets, topics and conditions', () => {
    expect(() => checkMessage(kinds, { token: 't', topic: 'x' })).toThrow(/exactly one/);
    expect(() => checkMessage(kinds, { topic: 'bad topic' })).toThrow(/topic name/);
    expect(() => checkMessage({}, { token: 't', data: { n: 1 } })).toThrow(/strings/);
    expect(() => checkMessage(kinds, { tokens: [] }, { multicast: true })).toThrow(/tokens/);
    const c = parseCondition("'a' in topics && ('b' in topics || !('c' in topics))");
    expect(matchCondition(c, new Set(['a']))).toBe(true);
    expect(matchCondition(c, new Set(['a', 'c']))).toBe(false);
    expect(matchCondition(c, new Set(['a', 'b', 'c']))).toBe(true);
    expect(() => parseCondition("'a' in topics || 'b' in topics || 'c' in topics || 'd' in topics || 'e' in topics || 'f' in topics")).toThrow(/five/);
  });
  it('types: a declared kind and its data', () => {
    const ok: TypedMessage<typeof cfg> = { token: 't', kind: 'shipped', data: { orderId: 'o', tags: ['b'] } };
    // @ts-expect-error tags is required
    const missing: TypedMessage<typeof cfg> = { token: 't', kind: 'shipped', data: { orderId: 'o' } };
    // @ts-expect-error raw data is not allowed once kinds are declared
    const raw: TypedMessage<typeof cfg> = { token: 't', data: { a: 'b' } };
    expect([ok, missing, raw].length).toBe(3);
  });
});

describe('remote config templates', () => {
  it('the declared template, its checks, and the deploy sync', () => {
    const t = defaultTemplate(params);
    expect(t.parameters.cfg).toEqual({ defaultValue: { value: '{"n":1}' }, valueType: 'JSON' });
    expect(templateIssues(params, t)).toEqual([]);
    const bad = { ...t, parameters: { ...t.parameters, limit: { defaultValue: { value: '1.5' }, valueType: 'NUMBER' as const }, on: { defaultValue: { value: 'yes' } }, extra: { defaultValue: { value: 'x' } } } };
    const issues = templateIssues(params, bad);
    expect(issues).toHaveLength(3);
    expect(issues[0]).toMatch(/limit default: expected integer/);
    expect(issues.slice(1)).toEqual(["on default: 'yes' is not true or false", 'extra: not declared in config.remoteConfig.parameters']);
    // Conditions: fine for Firebase, refused by the IceBase server.
    const cond = { ...t, conditions: [{ name: 'ios', expression: "device.os == 'ios'" }], parameters: { ...t.parameters, title: { defaultValue: { value: 'Hi' }, conditionalValues: { ios: { value: 'Hey' } } } } };
    expect(templateIssues(params, cond)).toEqual([]);
    expect(templateIssues(params, cond, { conditions: false }).length).toBe(2);
    const s = syncTemplate(params, cond);
    expect(s.template.parameters.title!.conditionalValues).toEqual({ ios: { value: 'Hey' } });
    expect(s.changed).toBe(true); // valueType + description filled in
  });
});

describe('firebase mode: checked before Firebase is reached', () => {
  const admin = initializeAdminApp(cfg, 'prod', { name: 'svc-unit-admin' });
  afterAll(() => deleteApp(admin));
  it('admin messaging refuses a message that does not match its kind', async () => {
    await expect(getAdminMessaging(admin).send({ token: 't', kind: 'shipped', data: { orderId: 3 } } as never)).rejects.toThrow(/orderId: expected string/);
    await expect(getAdminMessaging(admin).sendEachForMulticast({ tokens: [], notification: {} })).rejects.toThrow(/tokens/);
  });
  it('admin Remote Config refuses an undeclared parameter or a wrong value', async () => {
    const t = defaultTemplate(params);
    await expect(getAdminRemoteConfig(admin).publishTemplate({ ...t, parameters: { ...t.parameters, limit: { defaultValue: { value: 'x' } } } })).rejects.toThrow(/limit default/);
    expect(getAdminRemoteConfig(admin).createTemplateFromJSON(JSON.stringify(t)).parameters.title).toEqual(t.parameters.title);
  });
  it('client Remote Config: the Firebase SDK with the declared defaults as its defaultConfig', async () => {
    const app = initializeApp(cfg, 'prod', { name: 'svc-unit-rc' });
    try {
      const rc = getRemoteConfig(app);
      expect((rc._backend as unknown as { active(k: string): string | undefined }).active('limit')).toBeUndefined();
      expect(getNumber(rc, 'limit')).toBe(3);
      expect(getBoolean(rc, 'on')).toBe(false);
      expect(getParameter(rc, 'cfg')).toEqual({ n: 1 });
      expect(getValue(rc, 'title').getSource()).toBe('default');
      expect(Object.keys(getAll(rc)).sort()).toEqual(['cfg', 'limit', 'on', 'title']);
      // @ts-expect-error 'title' is a string parameter
      getBoolean(rc, 'title');
    } finally {
      await deleteApp(app);
    }
  });
  it('client App Check: Firebase\'s SDK with the provider (DebugProvider = Firebase debug mode)', async () => {
    const app = initializeApp(cfg, 'prod', { name: 'svc-unit-web' });
    try {
      const ac = initializeAppCheck(app, { provider: new DebugProvider('dbg-token') });
      expect((globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN).toBe('dbg-token');
      expect(ac._icebaseToken).toBeNull();
      expect(() => initializeAppCheck(app, { provider: new DebugProvider() })).toThrow(/already/);
    } finally {
      delete (globalThis as { FIREBASE_APPCHECK_DEBUG_TOKEN?: unknown }).FIREBASE_APPCHECK_DEBUG_TOKEN;
      await deleteApp(app);
    }
  });
});
