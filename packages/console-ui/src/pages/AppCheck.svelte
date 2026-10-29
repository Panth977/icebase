<script lang="ts">
  import { api } from '../lib/api';
  import Icon from '../components/Icon.svelte';
  import PageHead from '../components/PageHead.svelte';
  import { toast } from '../components/Toasts.svelte';
  type State = { enforce: string[]; mode: string; tokens: { name: string; token: string }[] | { error: string } };
  const ALL = ['firestore', 'database', 'storage', 'functions', 'remoteConfig', 'messaging'];
  let st = $state<State | null>(null);
  let err = $state('');
  let name = $state('');
  const load = () => api<State>('ac.get').then((r) => (st = r)).catch((e) => (err = e.message));
  load();
  async function create(e: Event) {
    e.preventDefault();
    try {
      const t = await api<{ token: string }>('ac.createDebugToken', { name });
      toast(`Debug token ${t.token} registered`);
      name = '';
      await load();
    } catch (x) {
      toast((x as Error).message, true);
    }
  }
  async function remove(token: string) {
    try {
      await api('ac.deleteDebugToken', { token });
      await load();
    } catch (x) {
      toast((x as Error).message, true);
    }
  }
</script>

<div class="page">
  <PageHead title="App Check" sub="Which services refuse requests without an App Check token (config.appCheck.enforce), and the debug tokens apps may attest with." />
  {#if err}<p class="err">{err}</p>{:else if !st}<p class="muted">Loading…</p>{:else}
    <div class="cols">
      <section class="surface"><h2>Enforcement</h2>
        {#each ALL as s}<div class="row"><span class="name">{s}</span>{#if st.enforce.includes(s)}<span class="pill accent">enforced</span>{:else}<span class="muted">not enforced</span>{/if}</div>{/each}
      </section>
      <section class="surface"><h2>Debug tokens</h2>
        {#if 'error' in st.tokens}<p class="muted pad">{st.tokens.error}</p>
        {:else if !st.tokens.length}<p class="muted pad">None registered{st.mode === 'emulator' ? ' (a developer emulator takes any debug token; a server that signs its tokens takes these only)' : ''}.</p>
        {:else}{#each st.tokens as t}<div class="row"><span class="name">{t.name}</span><span class="mono small tok">{t.token}</span><button class="btn sm ghost" title="Delete" onclick={() => remove(t.token)}><Icon name="trash" size={13} /></button></div>{/each}{/if}
        <form class="add" onsubmit={create}><input class="input" placeholder="name (e.g. CI)" bind:value={name} /><button class="btn primary sm" disabled={!name}><Icon name="plus" size={13} />Add debug token</button></form>
      </section>
    </div>
  {/if}
</div>

<style>
  .page { padding: 24px 28px 40px; max-width: 1100px; }
  section { overflow: hidden; }
  .cols { display: grid; grid-template-columns: 1fr 1.4fr; gap: 16px; align-items: start; }
  h2 { margin: 0; padding: 11px 16px; font-size: 13.5px; border-bottom: 1px solid var(--line); }
  .row { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--line-2); min-height: 38px; }
  .name { font-weight: 500; flex: none; min-width: 110px; }
  .tok { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .small { font-size: 12px; }
  .pad { padding: 12px 16px; margin: 0; }
  .add { display: flex; gap: 8px; padding: 12px 16px; }
  .add .input { flex: 1; }
  .sm { height: 30px; font-size: 12.5px; }
  @media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
</style>
