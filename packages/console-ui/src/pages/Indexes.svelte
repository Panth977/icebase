<script lang="ts">
  import { api } from '../lib/api';
  import PageHead from '../components/PageHead.svelte';
  import Empty from '../components/Empty.svelte';
  type IndexJson = { collectionGroup: string; queryScope: string; fields: { fieldPath: string; order?: string; arrayConfig?: string }[] };
  let r = $state<{ declared: { indexes: IndexJson[]; fieldOverrides: unknown[] }; built: any } | null>(null);
  let err = $state('');
  api('fs.indexes').then((x) => (r = x)).catch((e) => (err = e.message));
  const built = $derived.by(() => {
    const b = r?.built;
    if (!b) return [];
    if (Array.isArray(b)) return b as { collectionGroup: string; fields: string; state: string; queryScope?: string }[];
    if (b.databases) return (b.databases as { id: string; sqlIndexes: string[] }[]).flatMap((d) => d.sqlIndexes.map((x) => ({ collectionGroup: x.split(':')[0]!, fields: x.split(':').slice(1).join(':').trim(), state: 'READY', queryScope: d.id === '(default)' ? '' : d.id })));
    return [];
  });
  const groups = $derived([...new Set((r?.declared.indexes ?? []).map((i) => i.collectionGroup))].sort());
  const dir = (f: { order?: string; arrayConfig?: string }) => (f.arrayConfig ? 'contains' : f.order === 'DESCENDING' ? 'desc' : 'asc');
</script>

<div class="page">
  <PageHead title="Indexes" sub="Composite indexes the schema declares, and what the database has built. A query no index serves is refused." />
  {#if err}<p class="err">{err}</p>
  {:else if !r}<p class="muted">Loading…</p>
  {:else}
    <div class="cols">
      <section class="surface">
        <h2>Declared <span>{r.declared.indexes.length}</span></h2>
        {#if !groups.length}<Empty icon="index" title="No composite indexes">Single-field indexes need no composite.</Empty>{/if}
        {#each groups as g}
          <div class="grp">
            <div class="g mono">{g}</div>
            {#each r.declared.indexes.filter((i) => i.collectionGroup === g) as ix}
              <div class="ix">
                {#each ix.fields as f, i}{#if i}<span class="plus">+</span>{/if}<span class="f"><span class="mono">{f.fieldPath}</span><span class="d d-{dir(f)}">{dir(f)}</span></span>{/each}
                {#if ix.queryScope === 'COLLECTION_GROUP'}<span class="pill">group</span>{/if}
              </div>
            {/each}
          </div>
        {/each}
      </section>
      <section class="surface">
        <h2>Built <span>{built.length}</span></h2>
        <table class="grid">
          <thead><tr><th>Collection</th><th>Fields</th><th>State</th></tr></thead>
          <tbody>
            {#each built as b}<tr><td class="mono">{b.collectionGroup}</td><td class="mono small">{b.fields}</td><td><span class="pill" class:ok={b.state === 'READY'} class:accent={b.state !== 'READY'}>{b.state.toLowerCase()}</span></td></tr>{/each}
          </tbody>
        </table>
      </section>
    </div>
  {/if}
</div>

<style>
  .page { padding: 24px 28px 40px; }
  .cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  section { overflow: hidden; }
  h2 { margin: 0; padding: 12px 16px; font-size: 14px; border-bottom: 1px solid var(--line); }
  h2 span { color: var(--ink-3); font-weight: 400; margin-left: 4px; }
  .grp { padding: 10px 16px; border-bottom: 1px solid var(--line-2); }
  .g { font-weight: 600; margin-bottom: 6px; }
  .ix { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 3px 0; }
  .f { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--mist); }
  .d { font-size: 11px; color: var(--ink-3); }
  .d-desc { color: var(--t-number); }
  .d-contains { color: var(--t-boolean); }
  .plus { color: var(--ink-3); }
  .small { font-size: 12px; }
  @media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } }
</style>
