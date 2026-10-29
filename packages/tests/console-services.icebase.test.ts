// The console's Remote Config, Messaging and App Check operations on the IceBase server.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineConfig, param } from '@panth977/icebase/config';
import { defineSchema, f } from '@panth977/icebase/schema';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';

describe('console · Remote Config, Messaging, App Check', () => {
  let s: RunningEmulator;
  const config = defineConfig({
    name: 'console-svc',
    schema: defineSchema({}),
    remoteConfig: { parameters: { banner: param.string('Hi', { description: 'Top banner' }), limit: param.number(5) } },
    messaging: { messages: { ping: { n: f.number() } } },
    appCheck: { enforce: ['messaging'] },
    environments: { local: { mode: 'emulator' } },
  });
  const api = async (op: string, body: Record<string, unknown> = {}) => {
    const r = await fetch(`${s.url}/__/icebase/console/api/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer svc-admin' }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as Record<string, any> };
  };
  const ok = async (op: string, body: Record<string, unknown> = {}) => {
    const r = await api(op, body);
    if (r.status !== 200) throw new Error(`${op}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  };
  beforeAll(async () => {
    s = await startEmulator({ config, env: 'local', port: 0, dataDir: ':memory:', adminToken: 'svc-admin', without: ['functions'], log: () => {} });
  });
  afterAll(() => s.close());

  it('Remote Config: parameters with their declared type and default; publish values (checked); roll back', async () => {
    const r = await ok('rc.get');
    expect(r.version).toBe('0');
    expect(r.parameters).toEqual([
      { name: 'banner', declared: true, valueType: 'STRING', defaultValue: 'Hi', description: 'Top banner', value: 'Hi', useInAppDefault: false, conditional: [] },
      { name: 'limit', declared: true, valueType: 'NUMBER', defaultValue: '5', description: null, value: '5', useInAppDefault: false, conditional: [] },
    ]);
    expect((await api('rc.publish', { values: { limit: 'many' } })).status).toBe(400);
    expect((await ok('rc.publish', { values: { limit: '9', banner: null } })).version).toBe('1');
    const after = await ok('rc.get');
    expect(after.parameters.map((p: { value: string | null; useInAppDefault: boolean }) => [p.value, p.useInAppDefault])).toEqual([[null, true], ['9', false]]);
    expect(after.versions.map((v: { versionNumber: string }) => v.versionNumber)).toEqual(['1']);
    expect((await ok('rc.rollback', { version: '0' })).version).toBe('2');
    expect((await ok('rc.get')).parameters[1].value).toBe('5');
  });

  it('Messaging: kinds, send (typed), outbox, tokens, topics', async () => {
    const reg = await fetch(`${s.url}/v1/fcm/register`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer svc-admin' }, body: '{}' });
    const { token } = (await reg.json()) as { token: string };
    expect((await api('fcm.send', { token, kind: 'ping', data: { n: 'x' } })).status).toBe(400);
    await ok('fcm.send', { token, kind: 'ping', data: { n: 1 }, title: 'Hey' });
    const st = await ok('fcm.state');
    expect(st.kinds).toEqual([{ kind: 'ping', fields: [{ name: 'n', type: 'number', optional: false }] }]);
    expect(st.messages).toHaveLength(1);
    expect(st.messages[0]).toMatchObject({ targets: 1, delivered: 0, message: { token, notification: { title: 'Hey' }, data: { icebaseKind: 'ping', n: '1' } } });
    expect(st.tokens).toMatchObject([{ token, listening: false, topics: [] }]);
    expect(st.topics).toEqual([]);
  });

  it('App Check: enforcement and debug tokens', async () => {
    expect(await ok('ac.get')).toEqual({ enforce: ['messaging'], mode: 'emulator', tokens: [] });
    const t = await ok('ac.createDebugToken', { name: 'CI' });
    expect((await ok('ac.get')).tokens).toEqual([{ name: 'CI', token: t.token }]);
    await ok('ac.deleteDebugToken', { token: t.token });
    expect((await ok('ac.get')).tokens).toEqual([]);
  });
});
