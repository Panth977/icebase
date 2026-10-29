<script lang="ts">
  import { api } from '../lib/api';
  import Icon from '../components/Icon.svelte';
  import PageHead from '../components/PageHead.svelte';
  import Empty from '../components/Empty.svelte';
  import { toast } from '../components/Toasts.svelte';
  type Param = { name: string; declared: boolean; valueType: string; defaultValue: string | null; description: string | null; value: string | null; useInAppDefault: boolean; conditional: string[] };
  type State = { version: string; conditions: string[]; versions: { versionNumber?: string; updateTime?: string; updateType?: string; description?: string }[]; parameters: Param[] };
  let st = $state<State | null>(null);
  let err = $state('');
  let edits = $state<Record<string, string | null>>({});
  let busy = $state(false);
  const load = () => api<State>('rc.get').then((r) => { st = r; edits = {}; }).catch((e) => (err = e.message));
  load();
  const dirty = $derived(Object.keys(edits).length > 0);
  const shown = (p: Param) => (p.name in edits ? edits[p.name] : p.useInAppDefault ? null : p.value);
  async function publish() {
    busy = true;
    try {
      const r = await api<{ version: string }>('rc.publish', { values: edits });
      toast(`Published version ${r.version}`);
      await load();
    } catch (e) {
      toast((e as Error).message, true);
    }
    busy = false;
  }
  async function rollback(v: string) {
    try {
      const r = await api<{ version: string }>('rc.rollback', { version: v });
      toast(`Rolled back to ${v} (now version ${r.version})`);
      await load();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function sync() {
    try {
      const r = await api<{ added: string[]; removed: string[]; reset: string[]; version: string | null }>('rc.sync');
      toast(r.version ? `Template follows the declarations (version ${r.version})` : 'Template already matches the declarations');
      await load();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
</script>

<div class="page">
  <PageHead title="Remote Config" sub="Parameters as icebase.config declares them, and the values clients fetch. Values are checked against their declared type when published.">
    {#snippet actions()}
      <button class="btn" onclick={sync}><Icon name="refresh" size={13} />Match declarations</button>
      <button class="btn primary" disabled={!dirty || busy} onclick={publish}>{busy ? 'Publishing…' : dirty ? `Publish ${Object.keys(edits).length} change${Object.keys(edits).length > 1 ? 's' : ''}` : 'Publish'}</button>
    {/snippet}
  </PageHead>
  {#if err}<p class="err">{err}</p>
  {:else if !st}<p class="muted">Loading…</p>
  {:else if !st.parameters.length}<Empty icon="config" title="No parameters declared" />
  {:else}
    <section class="surface">
      <table class="grid">
        <thead><tr><th>Parameter</th><th>Type</th><th>In-app default</th><th>Value</th><th></th></tr></thead>
        <tbody>
          {#each st.parameters as p}
            <tr class:changed={p.name in edits}>
              <td><div class="mono name">{p.name}</div>{#if p.description}<div class="muted small">{p.description}</div>{/if}{#if !p.declared}<span class="pill warn">not declared</span>{/if}{#if p.conditional.length}<span class="pill">conditions: {p.conditional.join(', ')}</span>{/if}</td>
              <td><span class="pill">{p.valueType.toLowerCase()}</span></td>
              <td class="mono muted">{p.defaultValue ?? '—'}</td>
              <td class="val">
                {#if shown(p) === null}
                  <span class="muted">in-app default</span> <button class="btn sm" onclick={() => (edits[p.name] = p.value ?? p.defaultValue ?? '')}>Set</button>
                {:else if p.valueType === 'BOOLEAN'}
                  <select class="select" value={shown(p)} onchange={(e) => (edits[p.name] = (e.target as HTMLSelectElement).value)}><option>true</option><option>false</option></select>
                {:else}
                  <input class="input mono" value={shown(p)} oninput={(e) => (edits[p.name] = (e.target as HTMLInputElement).value)} />
                {/if}
              </td>
              <td class="acts">
                {#if shown(p) !== null}<button class="btn sm ghost" title="Use the in-app default" onclick={() => (edits[p.name] = null)}>Default</button>{/if}
                {#if p.name in edits}<button class="btn sm ghost" title="Undo" onclick={() => { const { [p.name]: _, ...rest } = edits; edits = rest; }}><Icon name="close" size={12} /></button>{/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
    <section class="surface versions">
      <h2>Versions <span>current {st.version}</span></h2>
      {#if !st.versions.length}<p class="muted pad">Nothing published yet: clients get the declared defaults.</p>
      {:else}
        <table class="grid"><thead><tr><th>Version</th><th>Published</th><th>Kind</th><th></th></tr></thead>
          <tbody>{#each st.versions as v}<tr><td class="mono">{v.versionNumber}</td><td class="muted">{v.updateTime ? new Date(v.updateTime).toLocaleString() : ''}</td><td class="muted">{v.updateType ?? ''}</td><td class="acts">{#if v.versionNumber !== st.version}<button class="btn sm" onclick={() => rollback(v.versionNumber!)}>Roll back</button>{/if}</td></tr>{/each}</tbody>
        </table>
      {/if}
    </section>
  {/if}
</div>

<style>
  .page { padding: 24px 28px 40px; max-width: 1200px; }
  section { overflow: hidden; }
  .name { font-weight: 500; }
  .small { font-size: 12px; }
  .val { min-width: 240px; }
  .val .input, .val .select { width: 100%; }
  .acts { text-align: right; white-space: nowrap; }
  tr.changed td { background: var(--hover); }
  .versions { margin-top: 16px; }
  h2 { margin: 0; padding: 11px 16px; font-size: 13.5px; border-bottom: 1px solid var(--line); }
  h2 span { color: var(--ink-3); font-weight: 400; margin-left: 4px; }
  .pad { padding: 12px 16px; margin: 0; }
  .sm { height: 28px; font-size: 12.5px; }
  .warn { color: var(--warn); }
</style>
