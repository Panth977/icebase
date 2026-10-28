<script lang="ts">
  import { api } from '../lib/api';
  import PageHead from '../components/PageHead.svelte';
  import Code from '../components/Code.svelte';
  import Empty from '../components/Empty.svelte';
  let svc = $state<'firestore' | 'storage' | 'database'>('firestore');
  let r = $state<{ file: string | null; text: string | null } | null>(null);
  let err = $state('');
  $effect(() => {
    const s = svc;
    r = null;
    err = '';
    api('rules', { service: s }).then((x) => (r = x)).catch((e) => (err = e.message));
  });
</script>

<div class="page">
  <PageHead title="Rules" sub="The security rules in force: who may read and write what." />
  <div class="tabs" role="tablist">
    {#each [['firestore', 'Firestore'], ['storage', 'Storage'], ['database', 'Realtime Database']] as [k, l]}<button role="tab" aria-selected={svc === k} class:on={svc === k} onclick={() => (svc = k as typeof svc)}>{l}</button>{/each}
  </div>
  <div class="surface box">
    {#if err}<p class="err">{err}</p>
    {:else if !r}<p class="muted">Loading…</p>
    {:else if !r.text}<Empty icon="rules" title="No rules">{r.file ? `Configured file: ${r.file}` : 'Without rules only the admin can read or write on an IceBase server.'}</Empty>
    {:else}
      {#if r.file}<p class="muted file mono">{r.file}</p>{/if}
      <Code code={r.text} lang={svc === 'database' ? 'json' : 'rules'} />
    {/if}
  </div>
</div>

<style>
  .page { padding: 24px 28px 40px; max-width: 1100px; }
  .tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: 8px; background: var(--line-2); margin-bottom: 12px; }
  .tabs button { border: 0; background: none; height: 28px; padding: 0 12px; border-radius: 6px; cursor: pointer; color: var(--ink-2); }
  .tabs button.on { background: var(--paper); color: var(--ink); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); font-weight: 500; }
  .box { padding: 16px 20px; }
  .file { margin: 0 0 10px; font-size: 12px; }
</style>
