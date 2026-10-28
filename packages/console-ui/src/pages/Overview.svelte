<script lang="ts">
  // The deployment at a glance: where each service runs, what is declared, what needs attention.
  import { app } from '../lib/state.svelte';
  import { go } from '../lib/router.svelte';
  import Icon from '../components/Icon.svelte';

  const o = $derived(app.overview!);
  const SERVICES: [string, string, string][] = [
    ['firestore', 'Firestore', 'firestore'],
    ['database', 'Realtime Database', 'database'],
    ['auth', 'Authentication', 'auth'],
    ['storage', 'Storage', 'storage'],
    ['functions', 'Functions', 'functions'],
    ['hosting', 'Hosting', 'hosting'],
  ];
  const ICON: Record<string, string> = { firestore: 'firestore', database: 'database', auth: 'users', storage: 'storage', functions: 'functions', hosting: 'hosting' };
  const modeText = (m: string | undefined) => (m === 'firebase' ? 'Firebase' : m === 'icebase' ? 'IceBase server' : m === 'emulator' ? 'Emulator' : m ?? 'off');
  const missing = $derived(o.secrets.filter((s) => !s.set));
</script>

<div class="page">
  <header class="hero">
    <div>
      <h1>{o.name}</h1>
      <p class="sub">Environment <b>{o.env}</b>{#if o.projectId}, Firebase project <span class="mono">{o.projectId}</span>{/if}.</p>
    </div>
    {#if o.health}
      <div class="health" class:bad={!o.health.ok}>
        <span class="dot"></span>
        <div><div class="h1">{o.health.ok ? 'Healthy' : 'Unhealthy'}</div><div class="muted">{o.health.documents.toLocaleString()} documents stored</div></div>
      </div>
    {/if}
  </header>

  {#if o.problems.length || missing.length}
    <section class="attn surface">
      <h2>Needs attention</h2>
      <ul>
        {#each o.problems as p}<li>{p}</li>{/each}
        {#each missing as s}<li>Secret <span class="mono">{s.name}</span> is not set: the sender that reads it cannot send.</li>{/each}
      </ul>
    </section>
  {/if}

  <h2 class="sec">Services</h2>
  <div class="services">
    {#each SERVICES as [key, label, page]}
      <button class="svc" onclick={() => go(page === 'auth' ? 'auth' : page)}>
        <span class="ic"><Icon name={ICON[key]!} size={18} /></span>
        <span class="lbl">{label}</span>
        <span class="mode m-{o.modes[key] ?? 'off'}">{modeText(o.modes[key])}</span>
      </button>
    {/each}
  </div>

  <div class="cols">
    <section class="surface">
      <h2>Declared in icebase.config</h2>
      <dl>
        <dt><button class="lnk" onclick={() => go('schema')}>Collections</button></dt><dd>{o.counts.collections}</dd>
        <dt><button class="lnk" onclick={() => go('schema')}>Realtime Database paths</button></dt><dd>{o.counts.paths}</dd>
        <dt><button class="lnk" onclick={() => go('schema')}>Storage paths</button></dt><dd>{o.counts.files}</dd>
        <dt><button class="lnk" onclick={() => go('apis')}>API endpoints</button></dt><dd>{o.counts.endpoints}</dd>
        <dt><button class="lnk" onclick={() => go('rules')}>Rules files</button></dt><dd>{Object.keys(o.rules).length}</dd>
      </dl>
    </section>
    <section class="surface">
      <h2>Sign-in</h2>
      {#if o.customAuth}
        <dl>
          <dt>Email codes</dt><dd>{o.customAuth.email ?? 'off'}</dd>
          <dt>Phone codes</dt><dd>{o.customAuth.phone ?? 'off'}</dd>
          <dt>Google</dt><dd>{o.customAuth.google ? 'on' : 'off'}</dd>
        </dl>
      {:else}<p class="muted pad">Firebase Authentication's own providers. See <button class="lnk" onclick={() => go('auth')}>Authentication</button>.</p>{/if}
      {#if o.secrets.length}
        <h3>Secrets</h3>
        <ul class="secrets">{#each o.secrets as s}<li><span class="mono">{s.name}</span><span class="pill" class:ok={s.set} class:danger={!s.set}>{s.set ? 'set' : 'missing'}</span></li>{/each}</ul>
      {/if}
    </section>
    <section class="surface">
      <h2>Environments</h2>
      <ul class="envs">{#each o.environments as e}<li class:cur={e === o.env}><span class="mono">{e}</span>{#if e === o.env}<span class="pill accent">this one</span>{/if}</li>{/each}</ul>
      {#if o.hosting}<h3>Hosting</h3><p class="pad0">Serves <span class="mono">{o.hosting.public}/</span>{#if o.hosting.site} as site <span class="mono">{o.hosting.site}</span>{/if}.</p>{/if}
    </section>
  </div>
</div>

<style>
  .page { padding: 28px 32px 48px; max-width: 1200px; }
  .hero { display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--line); margin-bottom: 20px; }
  h1 { margin: 0; font-size: 26px; letter-spacing: -0.02em; }
  .sub { margin: 6px 0 0; color: var(--ink-2); }
  .health { display: flex; gap: 12px; align-items: center; padding: 10px 16px; border-radius: 10px; background: color-mix(in srgb, var(--ok) 10%, transparent); }
  .health.bad { background: color-mix(in srgb, var(--danger) 10%, transparent); }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 25%, transparent); }
  .health.bad .dot { background: var(--danger); box-shadow: 0 0 0 4px color-mix(in srgb, var(--danger) 25%, transparent); }
  .h1 { font-weight: 600; }
  .attn { padding: 14px 18px; margin-bottom: 20px; border-left: 3px solid var(--danger); }
  .attn ul { margin: 6px 0 0; padding-left: 18px; color: var(--ink-2); }
  .attn li { margin: 3px 0; }
  h2 { margin: 0; font-size: 14px; }
  .sec { margin: 4px 0 10px; }
  .services { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 10px; margin-bottom: 24px; }
  .svc { display: grid; grid-template-columns: auto 1fr; grid-template-rows: auto auto; gap: 2px 10px; align-items: center; text-align: left; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--paper); cursor: pointer; color: var(--ink); }
  .svc:hover { border-color: var(--accent); }
  .ic { grid-row: span 2; width: 34px; height: 34px; border-radius: 8px; display: grid; place-items: center; background: var(--mist); color: var(--ink-2); }
  .lbl { font-weight: 550; }
  .mode { font-size: 12px; color: var(--ink-3); }
  .mode.m-icebase, .mode.m-emulator { color: var(--accent-ink); }
  .mode.m-firebase { color: var(--t-number); }
  .cols { display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; align-items: start; }
  .cols section { padding: 14px 18px; }
  .cols h2 { margin-bottom: 10px; }
  h3 { margin: 16px 0 8px; font-size: 12.5px; color: var(--ink-2); }
  dl { display: grid; grid-template-columns: 1fr auto; gap: 7px 12px; margin: 0; }
  dt { color: var(--ink-2); }
  dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 550; text-align: right; }
  .lnk { border: 0; background: none; padding: 0; color: var(--accent-ink); cursor: pointer; font: inherit; }
  .lnk:hover { text-decoration: underline; }
  ul.secrets, ul.envs { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  ul.secrets li, ul.envs li { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
  .pad { margin: 0; }
  .pad0 { margin: 0; color: var(--ink-2); }
  @media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } }
</style>
