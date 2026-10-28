<script lang="ts">
  import Icon from './components/Icon.svelte';
  import Toasts from './components/Toasts.svelte';
  import SignIn from './components/SignIn.svelte';
  import { route, go } from './lib/router.svelte';
  import { app, boot, switchTo, deploymentName } from './lib/state.svelte';
  import Overview from './pages/Overview.svelte';
  import Apis from './pages/Apis.svelte';
  import Firestore from './pages/Firestore.svelte';
  import Database from './pages/Database.svelte';
  import Schema from './pages/Schema.svelte';
  import Indexes from './pages/Indexes.svelte';
  import Rules from './pages/Rules.svelte';
  import Auth from './pages/Auth.svelte';
  import Storage from './pages/Storage.svelte';
  import Functions from './pages/Functions.svelte';
  import Hosting from './pages/Hosting.svelte';

  const NAV = [
    { group: '', items: [{ id: 'overview', label: 'Overview', icon: 'overview' }] },
    { group: 'Data', items: [{ id: 'firestore', label: 'Firestore', icon: 'firestore' }, { id: 'database', label: 'Realtime Database', icon: 'database' }, { id: 'storage', label: 'Storage', icon: 'storage' }] },
    { group: 'Users', items: [{ id: 'auth', label: 'Authentication', icon: 'users' }] },
    { group: 'Definition', items: [{ id: 'schema', label: 'Schema', icon: 'schema' }, { id: 'indexes', label: 'Indexes', icon: 'index' }, { id: 'rules', label: 'Rules', icon: 'rules' }] },
    { group: 'Backend', items: [{ id: 'apis', label: 'APIs', icon: 'api' }, { id: 'functions', label: 'Functions', icon: 'functions' }, { id: 'hosting', label: 'Hosting', icon: 'hosting' }] },
  ];
  const PAGES: Record<string, any> = { overview: Overview, apis: Apis, firestore: Firestore, database: Database, schema: Schema, indexes: Indexes, rules: Rules, auth: Auth, storage: Storage, functions: Functions, hosting: Hosting };
  const label = $derived(NAV.flatMap((g) => g.items).find((i) => i.id === route.page)?.label ?? 'Overview');
  const Page = $derived(PAGES[route.page] ?? Overview);

  boot();
</script>

<div class="shell">
  <aside>
    <div class="brand">
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true"><path d="M11 1.5 19.5 6.5v9L11 20.5 2.5 15.5v-9z" fill="none" stroke="currentColor" stroke-width="1.5" /><path d="M11 6.5 15 9v4l-4 2.5L7 13V9z" fill="currentColor" opacity=".85" /></svg>
      <div>
        <div class="name">IceBase</div>
        <div class="proj" title={app.overview?.projectId ?? ''}>{app.overview ? app.overview.name : '…'}</div>
      </div>
    </div>
    <nav>
      {#each NAV as g}
        {#if g.group}<div class="group">{g.group}</div>{/if}
        {#each g.items as it}
          <a href="#/{it.id}" class:on={route.page === it.id} aria-current={route.page === it.id ? 'page' : undefined}><Icon name={it.icon} /><span>{it.label}</span></a>
        {/each}
      {/each}
    </nav>
  </aside>

  <div class="main">
    <header class="top">
      <div class="crumbs">
        <button class="crumb" onclick={() => go(route.page)}>{label}</button>
        {#if route.rest}
          {#each route.rest.split('/') as seg, i}
            <Icon name="chevron" size={12} />
            <button class="crumb mono" onclick={() => go(route.page, route.rest.split('/').slice(0, i + 1).join('/'))}>{seg}</button>
          {/each}
        {/if}
      </div>
      <div class="right">
        {#if app.overview}<span class="pill" class:accent={app.overview.modes.firestore === 'emulator'} title="Where this deployment's data lives">{app.overview.modes.firestore === 'emulator' ? 'IceBase server' : 'Firebase'} · {app.overview.env}</span>{/if}
        {#if app.targets.length}
          <label class="switch">
            <span class="sr">Deployment</span>
            <select class="select" value={app.base} onchange={(e) => switchTo((e.target as HTMLSelectElement).value)}>
              <option value="">This server</option>
              {#each app.targets as t}<option value={t.url}>{t.name}</option>{/each}
            </select>
          </label>
        {/if}
      </div>
    </header>

    <main>
      {#if app.error && !app.overview}
        <div class="gate surface">
          <p><strong>Can't open {deploymentName()}.</strong></p>
          <p class="muted">{app.error}</p>
          <button class="btn primary" onclick={() => switchTo(app.base)}>Try again</button>
        </div>
      {:else if !app.overview}
        <div class="loading muted">Opening {deploymentName()}…</div>
      {:else}
        {#key `${app.epoch}:${route.page}`}
          <Page />
        {/key}
      {/if}
    </main>
  </div>
</div>
<SignIn />
<Toasts />

<style>
  .loading { padding: 40px 32px; }
  .shell { display: grid; grid-template-columns: 228px 1fr; height: 100vh; }
  aside { background: var(--side); color: var(--side-ink); display: flex; flex-direction: column; min-height: 0; }
  .brand { display: flex; gap: 10px; align-items: center; padding: 16px 16px 14px; color: #fff; }
  .brand svg { color: #6fd0d1; flex: none; }
  .name { font-weight: 650; letter-spacing: 0.01em; }
  .proj { font-size: 12px; color: var(--side-mute); max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  nav { padding: 4px 8px 16px; overflow: auto; }
  .group { padding: 14px 10px 4px; font-size: 11.5px; color: var(--side-mute); }
  nav a { display: flex; align-items: center; gap: 10px; height: 32px; padding: 0 10px; border-radius: var(--radius); color: var(--side-ink); text-decoration: none; }
  nav a:hover { background: var(--side-on); color: #fff; }
  nav a.on { background: var(--side-on); color: #fff; box-shadow: inset 2px 0 0 #6fd0d1; }
  .main { display: grid; grid-template-rows: 52px 1fr; min-width: 0; min-height: 0; }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 20px; background: var(--paper); border-bottom: 1px solid var(--line); }
  .crumbs { display: flex; align-items: center; gap: 4px; min-width: 0; overflow: hidden; color: var(--ink-3); }
  .crumb { border: 0; background: none; padding: 3px 6px; border-radius: 4px; cursor: pointer; color: var(--ink-2); white-space: nowrap; }
  .crumb:first-child { font-weight: 600; color: var(--ink); font-size: 15px; }
  .crumb:hover { background: var(--hover); }
  .crumb:last-child:not(:first-child) { color: var(--ink); }
  .right { display: flex; align-items: center; gap: 10px; flex: none; }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  main { overflow: auto; min-height: 0; }
  .gate { max-width: 460px; margin: 80px auto; padding: 24px; }
  @media (max-width: 760px) {
    .shell { grid-template-columns: 56px 1fr; }
    .brand div, nav a span, .group { display: none; }
  }
</style>
