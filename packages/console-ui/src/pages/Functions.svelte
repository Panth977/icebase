<script lang="ts">
  import { api } from '../lib/api';
  import Icon from '../components/Icon.svelte';
  import PageHead from '../components/PageHead.svelte';
  import Empty from '../components/Empty.svelte';
  import { toast } from '../components/Toasts.svelte';
  type Fn = { name: string; kind: string; trigger: string };
  let fns = $state<Fn[] | null>(null);
  let tasks = $state<{ id: string; fn: string; run_at: number; attempts: number }[]>([]);
  let err = $state('');
  let q = $state('');
  let running = $state('');
  api<{ functions: Fn[] }>('fn.list').then((r) => (fns = r.functions)).catch((e) => (err = e.message));
  api<{ tasks: typeof tasks }>('fn.tasks').then((r) => (tasks = r.tasks)).catch(() => {});
  const KIND: Record<string, string> = { call: 'Callable', request: 'HTTPS', https: 'HTTPS', schedule: 'Scheduled', document: 'Firestore trigger', database: 'Database trigger', storage: 'Storage trigger', auth: 'Auth trigger', task: 'Task queue', event: 'Event' };
  const groups = $derived.by(() => {
    const m = new Map<string, Fn[]>();
    for (const f of (fns ?? []).filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase()))) m.set(KIND[f.kind] ?? f.kind, [...(m.get(KIND[f.kind] ?? f.kind) ?? []), f]);
    return [...m];
  });
  async function run(name: string) {
    running = name;
    try {
      const r = await api<{ ms: number }>('fn.run', { name });
      toast(`${name} ran in ${r.ms} ms`);
    } catch (e) {
      toast((e as Error).message, true);
    }
    running = '';
  }
</script>

<div class="page">
  <PageHead title="Functions" sub="What runs on this deployment, and what starts it.">
    {#snippet actions()}<div class="search"><Icon name="search" size={14} /><input placeholder="Find a function" bind:value={q} /></div>{/snippet}
  </PageHead>
  {#if err}<p class="err">{err}</p>
  {:else if !fns}<p class="muted">Loading…</p>
  {:else if !fns.length}<Empty icon="functions" title="No functions deployed" />
  {:else}
    <div class="groups">
      {#each groups as [g, list]}
        <section class="surface">
          <h2>{g} <span>{list.length}</span></h2>
          {#each list as f}
            <div class="fn">
              <span class="mono name">{f.name}</span>
              <span class="trig mono">{f.trigger}</span>
              {#if f.kind === 'schedule'}<button class="btn sm" disabled={running === f.name} onclick={() => run(f.name)}><Icon name="play" size={12} />{running === f.name ? 'Running…' : 'Run now'}</button>{/if}
            </div>
          {/each}
        </section>
      {/each}
    </div>
    <section class="surface queue">
      <h2>Task queue <span>{tasks.length}</span></h2>
      {#if !tasks.length}<p class="muted pad">Nothing waiting.</p>
      {:else}<table class="grid"><thead><tr><th>Function</th><th>Runs at</th><th>Attempts</th></tr></thead><tbody>{#each tasks as t}<tr><td class="mono">{t.fn}</td><td class="muted">{new Date(t.run_at).toLocaleString()}</td><td>{t.attempts}</td></tr>{/each}</tbody></table>{/if}
    </section>
  {/if}
</div>

<style>
  .page { padding: 24px 28px 40px; }
  .search { display: flex; align-items: center; gap: 6px; width: 260px; height: 32px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); color: var(--ink-3); }
  .search input { border: 0; outline: none; background: none; flex: 1; }
  .groups { display: grid; grid-template-columns: repeat(auto-fill, minmax(420px, 1fr)); gap: 16px; align-items: start; }
  section { overflow: hidden; }
  h2 { margin: 0; padding: 11px 16px; font-size: 13.5px; border-bottom: 1px solid var(--line); }
  h2 span { color: var(--ink-3); font-weight: 400; margin-left: 4px; }
  .fn { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--line-2); min-height: 40px; }
  .fn:last-child { border-bottom: 0; }
  .name { font-weight: 500; }
  .trig { flex: 1; color: var(--ink-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; }
  .queue { margin-top: 16px; }
  .pad { padding: 12px 16px; margin: 0; }
  .sm { height: 28px; font-size: 12.5px; }
</style>
