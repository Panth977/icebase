// Remote Config, emulator mode: the IceBase server keeps the template; clients fetch typed values.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteApp, initializeApp, type IceBaseApp } from '@panth977/icebase/app';
import { defineConfig, param } from '@panth977/icebase/config';
import { defineSchema, f } from '@panth977/icebase/schema';
import { activate, fetchAndActivate, fetchConfig, getAll, getBoolean, getNumber, getParameter, getRemoteConfig, getString, getValue, onConfigUpdate } from '@panth977/icebase/remote-config';
import { getAdminRemoteConfig, initializeAdminApp } from '@panth977/icebase-server/admin';
import { manageRemoteConfig } from '@panth977/icebase-cli/manage';
import { startEmulator, type RunningEmulator } from '@panth977/icebase-cli/emulator';

const make = (port?: number) =>
  defineConfig({
    name: 'rc-emu',
    schema: defineSchema({}),
    remoteConfig: {
      parameters: {
        welcome: param.string('Hello', { description: 'Home banner' }),
        maxItems: param.number(10, { int: true, min: 1, max: 100 }),
        newCheckout: param.boolean(false),
        theme: param.json(f.map({ color: f.string(), dark: f.boolean() }), { color: 'blue', dark: false }),
        plan: param.enum(['free', 'pro'], 'free'),
      },
    },
    ...(port ? { emulator: { port } } : {}),
    environments: { local: { mode: 'emulator' } },
  });

describe('remote config · emulator mode', () => {
  let emu: RunningEmulator;
  let app: IceBaseApp<ReturnType<typeof make>>;
  let admin: IceBaseApp<ReturnType<typeof make>>;
  beforeAll(async () => {
    emu = await startEmulator({ config: make(), port: 0, dataDir: ':memory:', without: ['functions'], log: () => {} });
    app = initializeApp(make(emu.port), 'local', { name: 'rc-web' });
    admin = initializeAdminApp(make(emu.port), 'local', { name: 'rc-admin' });
  });
  afterAll(async () => {
    await deleteApp(app);
    await deleteApp(admin);
    await emu.close();
  });

  it('before any fetch: the declared defaults, typed', () => {
    const rc = getRemoteConfig(app);
    expect(getString(rc, 'welcome')).toBe('Hello');
    expect(getNumber(rc, 'maxItems')).toBe(10);
    expect(getBoolean(rc, 'newCheckout')).toBe(false);
    expect(getParameter(rc, 'theme')).toEqual({ color: 'blue', dark: false });
    expect(getValue(rc, 'welcome').getSource()).toBe('default');
    expect(rc.defaultConfig.theme).toBe('{"color":"blue","dark":false}');
    expect(rc.lastFetchStatus).toBe('no-fetch-yet');
    // Typed keys: getNumber takes number parameters only, getValue declared ones only.
    // @ts-expect-error 'welcome' is a string parameter
    getNumber(rc, 'welcome');
    // @ts-expect-error not declared
    getValue(rc, 'nope');
    const plan: 'free' | 'pro' = getParameter(rc, 'plan');
    expect(plan).toBe('free');
  });

  it('the server template starts as the declarations (version 0); fetchAndActivate gets it', async () => {
    const t = await getAdminRemoteConfig(admin).getTemplate();
    expect(t.parameters.maxItems).toEqual({ defaultValue: { value: '10' }, valueType: 'NUMBER' });
    expect(t.parameters.welcome!.description).toBe('Home banner');
    const rc = getRemoteConfig(app);
    expect(await fetchAndActivate(rc)).toBe(true);
    expect(getValue(rc, 'maxItems').getSource()).toBe('remote');
    expect(rc.lastFetchStatus).toBe('success');
    expect(Object.keys(getAll(rc)).sort()).toEqual(['maxItems', 'newCheckout', 'plan', 'theme', 'welcome']);
  });

  it('publish: checked against the declarations, etag-guarded, versioned; clients see it after the fetch interval', async () => {
    const rcAdmin = getAdminRemoteConfig(admin);
    const t = await rcAdmin.getTemplate();
    t.parameters.maxItems = { defaultValue: { value: '25' }, valueType: 'NUMBER' };
    t.parameters.theme = { defaultValue: { value: JSON.stringify({ color: 'red', dark: true }) }, valueType: 'JSON' };
    // Wrong types and undeclared parameters never reach the server.
    await expect(rcAdmin.publishTemplate({ ...t, parameters: { ...t.parameters, maxItems: { defaultValue: { value: 'lots' } } } })).rejects.toThrow(/maxItems default: 'lots' is not a number/);
    await expect(rcAdmin.publishTemplate({ ...t, parameters: { ...t.parameters, extra: { defaultValue: { value: 'x' } } } })).rejects.toThrow(/extra: not declared/);
    await expect(rcAdmin.publishTemplate({ ...t, parameters: { ...t.parameters, theme: { defaultValue: { value: '{"color":1}' } } } })).rejects.toThrow(/theme default/);
    await expect(rcAdmin.publishTemplate({ ...t, conditions: [{ name: 'ios', expression: "device.os == 'ios'" }] })).rejects.toThrow(/conditions/);
    // …and the server checks too (a caller that skips the SDK).
    const raw = await fetch(`${emu.url}/__/icebase/admin/manage/remoteConfig/publishTemplate`, { method: 'POST', headers: { authorization: 'Bearer owner', 'content-type': 'application/json' }, body: JSON.stringify({ template: { ...t, parameters: { maxItems: { defaultValue: { value: 'x' } } } } }) });
    expect(raw.status).toBe(400);

    const v1 = await rcAdmin.publishTemplate(t);
    expect(v1.version?.versionNumber).toBe('1');
    // The old etag is stale now.
    await expect(rcAdmin.publishTemplate(t)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect((await rcAdmin.publishTemplate(t, { force: true })).version?.versionNumber).toBe('2');

    const rc = getRemoteConfig(app);
    await fetchConfig(rc);
    expect(rc.lastFetchStatus).toBe('throttle'); // 12 hours by default, like Firebase
    rc.settings = { ...rc.settings, minimumFetchIntervalMillis: 0 };
    await fetchConfig(rc);
    expect(getNumber(rc, 'maxItems')).toBe(10); // fetched, not active yet
    expect(await activate(rc)).toBe(true);
    expect(getNumber(rc, 'maxItems')).toBe(25);
    expect(getParameter(rc, 'theme')).toEqual({ color: 'red', dark: true });
    expect(await activate(rc)).toBe(false);
  });

  it('versions and rollback', async () => {
    const rcAdmin = getAdminRemoteConfig(admin);
    const { versions } = await rcAdmin.listVersions();
    expect(versions.map((v) => v.versionNumber)).toEqual(['2', '1']);
    const back = await rcAdmin.rollback(1);
    expect(back.version).toMatchObject({ versionNumber: '3', updateType: 'ROLLBACK', rollbackSource: '1' });
    expect((await rcAdmin.getTemplateAtVersion(0)).parameters.maxItems!.defaultValue).toEqual({ value: '10' });
  });

  it('onConfigUpdate: a publish is pushed to listening clients with the keys that changed', async () => {
    const rc = getRemoteConfig(app);
    rc.settings = { ...rc.settings, minimumFetchIntervalMillis: 0 };
    await fetchAndActivate(rc);
    const got = new Promise<Set<string>>((resolve, reject) => {
      const off = onConfigUpdate(rc, { next: (u) => (off(), resolve(u.getUpdatedKeys())), error: reject, complete: () => {} });
    });
    await new Promise((r) => setTimeout(r, 150));
    const rcAdmin = getAdminRemoteConfig(admin);
    const t = await rcAdmin.getTemplate();
    t.parameters.welcome = { defaultValue: { value: 'Welcome back' }, valueType: 'STRING' };
    await rcAdmin.publishTemplate(t);
    expect([...(await got)]).toEqual(['welcome']);
    await activate(rc);
    expect(getString(rc, 'welcome')).toBe('Welcome back');
  });

  it('manageRemoteConfig.setParameters: what deploy does — the template follows the declarations', async () => {
    const rcAdmin = getAdminRemoteConfig(admin);
    // Values that fit stay; the description the last publish dropped comes back (a new version)…
    const first = await manageRemoteConfig(admin).setParameters();
    expect(first).toMatchObject({ added: [], removed: [], reset: [] });
    expect(first.version).not.toBeNull();
    expect((await rcAdmin.getTemplate()).parameters.welcome).toEqual({ defaultValue: { value: 'Welcome back' }, valueType: 'STRING', description: 'Home banner' });
    // …and then there is nothing to publish.
    expect((await manageRemoteConfig(admin).setParameters()).version).toBeNull();
    // A config that drops a parameter, adds one and narrows another.
    const next = defineConfig({
      name: 'rc-emu',
      schema: defineSchema({}),
      remoteConfig: { parameters: { welcome: param.string('Hello'), maxItems: param.number(5, { max: 20 }), banner: param.boolean(true) } },
      emulator: { port: emu.port },
      environments: { local: { mode: 'emulator' } },
    });
    const admin2 = initializeAdminApp(next, 'local', { name: 'rc-admin-2' });
    try {
      // The server checks against its own config, so only the client-side sync logic is exercised here.
      const { syncTemplate } = await import('@panth977/icebase/internal');
      const s = syncTemplate(next.remoteConfig!.parameters, await rcAdmin.getTemplate());
      expect(s).toMatchObject({ added: ['banner'], removed: ['newCheckout', 'theme', 'plan'], reset: ['maxItems'], kept: ['welcome'] });
      expect(s.template.parameters.welcome!.defaultValue).toEqual({ value: 'Welcome back' });
      expect(s.template.parameters.maxItems!.defaultValue).toEqual({ value: '5' });
    } finally {
      await deleteApp(admin2);
    }
  });
});
