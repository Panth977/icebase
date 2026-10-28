<script lang="ts">
  // The Realtime Database as a tree: open nodes as you go; the selected node's value is edited
  // on the right as JSON (with its children), or a child added under it.
  import { api } from '../lib/api';
  import { route, go } from '../lib/router.svelte';
  import Icon from '../components/Icon.svelte';
  import DbNode from '../components/DbNode.svelte';
  import Code from '../components/Code.svelte';
  import { toast } from '../components/Toasts.svelte';

  const selected = $derived(route.rest);
  let reloadKey = $state(0);
  let value = $state<unknown>(undefined);
  let text = $state('');
  let err = $state('');
  let editing = $state(false);
  let newKey = $state('');
  let newVal = $state('');
  let busy = $state(false);

  $effect(() => {
    const p = selected;
    value = undefined;
    err = '';
    editing = false;
    api<{ value: unknown }>('db.get', { path: p })
      .then((r) => {
        value = r.value;
        text = JSON.stringify(r.value, null, 2);
      })
      .catch((e) => (err = e.message));
  });
  const big = $derived(text.length > 200_000);

  function parse(s: string): unknown {
    const t = s.trim();
    try {
      return JSON.parse(t);
    } catch {
      return s;
    }
  }
  async function write(path: string, v: unknown, what: string) {
    busy = true;
    try {
      await api('db.set', { path, value: v });
      toast(what);
      reloadKey++;
      const r = await api<{ value: unknown }>('db.get', { path: selected });
      value = r.value;
      text = JSON.stringify(r.value, null, 2);
      editing = false;
    } catch (e) {
      toast((e as Error).message, true);
    }
    busy = false;
  }
</script>

<div class="db">
  <section class="tree surface">
    <div class="ph">
      <h3>Data</h3>
      <button class="btn ghost icon sm" aria-label="Refresh" onclick={() => reloadKey++}><Icon name="refresh" size={14} /></button>
    </div>
    <div class="scroll">
      <DbNode path="" name="/" depth={0} {selected} onselect={(p) => go('database', p)} {reloadKey} />
    </div>
  </section>

  <section class="side">
    <div class="surface card">
      <div class="ph">
        <h3 class="mono">/{selected}</h3>
        <div class="tools">
          {#if !editing}<button class="btn sm" disabled={value === undefined || big} onclick={() => (editing = true)}><Icon name="edit" size={13} />Edit</button>{/if}
          {#if selected}<button class="btn danger sm" disabled={busy} onclick={() => confirm(`Remove /${selected} and everything under it?`) && write(selected, null, 'Removed').then(() => go('database', selected.split('/').slice(0, -1).join('/')))}><Icon name="trash" size={13} />Remove</button>{/if}
        </div>
      </div>
      <div class="body">
        {#if err}<p class="err">{err}</p>
        {:else if value === undefined}<p class="muted">Loading…</p>
        {:else if editing}
          <textarea class="code" spellcheck="false" rows="16" bind:value={text}></textarea>
          <div class="row"><button class="btn sm" onclick={() => { editing = false; text = JSON.stringify(value, null, 2); }}>Cancel</button><button class="btn primary sm" disabled={busy} onclick={() => { let v; try { v = JSON.parse(text); } catch { toast('That is not valid JSON', true); return; } write(selected, v, 'Saved'); }}>Set value</button></div>
        {:else if value === null}<p class="muted">No value here.</p>
        {:else if big}<p class="muted">{(text.length / 1024).toFixed(0)} KB under this node: open a deeper node to see it.</p>
        {:else}<div class="view"><Code code={text} lang="json" /></div>
        {/if}
      </div>
    </div>

    <form class="surface card add" onsubmit={(e) => { e.preventDefault(); if (newKey.trim()) write(selected ? `${selected}/${newKey.trim()}` : newKey.trim(), parse(newVal), `Added ${newKey.trim()}`).then(() => { newKey = ''; newVal = ''; }); }}>
      <h3>Add a child under /{selected}</h3>
      <div class="row">
        <input class="input mono key" placeholder="key" bind:value={newKey} />
        <input class="input mono" placeholder={'value: text, 42, true, {"a":1}'} bind:value={newVal} />
        <button class="btn primary sm" disabled={!newKey.trim() || busy}><Icon name="plus" size={13} />Add</button>
      </div>
    </form>
  </section>
</div>

<style>
  .db { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, 42%); gap: 16px; padding: 16px 20px; height: 100%; min-height: 0; }
  .tree { display: flex; flex-direction: column; min-height: 0; }
  .scroll { overflow: auto; padding: 6px; flex: 1; }
  .side { display: flex; flex-direction: column; gap: 16px; min-height: 0; overflow: auto; }
  .ph { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 46px; padding: 6px 12px 6px 16px; border-bottom: 1px solid var(--line); }
  h3 { margin: 0; font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tools { display: flex; gap: 6px; }
  .body { padding: 14px 16px; }
  .view { max-height: 60vh; overflow: auto; }
  .row { display: flex; gap: 8px; margin-top: 10px; justify-content: flex-end; }
  .add { padding: 14px 16px; }
  .add .row { margin-top: 10px; }
  .add .input { flex: 1; min-width: 0; }
  .add .key { max-width: 160px; }
  .sm { height: 26px; font-size: 12.5px; }
  .btn.sm { padding: 0 9px; }
  .btn.icon.sm { width: 26px; padding: 0; }
  @media (max-width: 1000px) { .db { grid-template-columns: 1fr; } }
</style>
