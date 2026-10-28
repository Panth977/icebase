<script lang="ts">
  // One node of the Realtime Database: children load when it opens; a leaf shows its value.
  import { api } from '../lib/api';
  import Icon from './Icon.svelte';
  import DbNode from './DbNode.svelte';
  import { looksLikeMillis } from '../lib/values';

  type Child = { key: string; size?: number; value?: unknown };
  let { path, name, size, value, depth = 0, selected, onselect, reloadKey = 0 }: { path: string; name: string; size?: number; value?: unknown; depth?: number; selected: string; onselect: (p: string) => void; reloadKey?: number } = $props();
  const leaf = $derived(size === undefined && depth > 0);
  let open = $state(false);
  let kids = $state<Child[] | null>(null);
  let err = $state('');
  let limit = $state(200);

  async function load() {
    err = '';
    try {
      const r = await api<{ children?: Child[]; value?: unknown }>('db.get', { path, shallow: true });
      kids = (r.children ?? []).sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true }));
    } catch (e) {
      err = (e as Error).message;
    }
  }
  $effect(() => {
    reloadKey;
    if (open || depth === 0) load();
  });
  $effect(() => {
    if (depth === 0) open = true;
  });
  const kind = (v: unknown) => (v === null ? 'null' : typeof v === 'string' ? 'string' : typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'map');
</script>

<div class="node">
  <div class="row" class:sel={selected === path} style="padding-left:{depth * 16 + 6}px">
    {#if !leaf}
      <button class="tw" aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open} onclick={() => { open = !open; if (open && !kids) load(); }}><span class:rot={open}><Icon name="chevron" size={12} /></span></button>
    {:else}<span class="tw"></span>{/if}
    <button class="key mono" onclick={() => onselect(path)}>{name}</button>
    {#if leaf}
      <span class="eq">:</span>
      <span class="val mono v-{kind(value)}" title={looksLikeMillis(value) ? new Date(value as number).toLocaleString() : undefined}>{typeof value === 'string' ? JSON.stringify(value) : String(value)}</span>
      {#if looksLikeMillis(value)}<span class="date">{new Date(value as number).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</span>{/if}
    {:else if size !== undefined}
      <span class="count">{size}</span>
    {/if}
  </div>
  {#if open && !leaf}
    {#if err}<p class="err" style="padding-left:{depth * 16 + 30}px">{err}</p>{/if}
    {#if kids}
      {#each kids.slice(0, limit) as c (c.key)}
        <DbNode path={path ? `${path}/${c.key}` : c.key} name={c.key} size={c.size} value={c.value} depth={depth + 1} {selected} {onselect} {reloadKey} />
      {/each}
      {#if kids.length > limit}<button class="btn ghost sm" style="margin-left:{depth * 16 + 30}px" onclick={() => (limit += 200)}>Show {Math.min(200, kids.length - limit)} more of {kids.length - limit}</button>{/if}
      {#if !kids.length && depth === 0}<p class="muted" style="padding:16px">The database is empty.</p>{/if}
    {:else if !err}<p class="muted" style="padding-left:{depth * 16 + 30}px">Loading…</p>{/if}
  {/if}
</div>

<style>
  .row { display: flex; align-items: center; gap: 6px; min-height: 28px; padding-right: 10px; border-radius: 5px; }
  .row:hover { background: var(--hover); }
  .row.sel { background: var(--accent-wash); }
  .tw { width: 18px; height: 18px; flex: none; border: 0; background: none; padding: 0; display: grid; place-items: center; color: var(--ink-3); cursor: pointer; }
  .tw span { display: grid; transition: transform 0.12s; }
  .tw span.rot { transform: rotate(90deg); }
  .key { border: 0; background: none; padding: 0 2px; cursor: pointer; color: var(--ink); font-weight: 500; }
  .eq { color: var(--ink-3); }
  .val { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
  .date { font-size: 11.5px; color: var(--t-timestamp); white-space: nowrap; }
  .count { font-size: 11.5px; color: var(--ink-3); background: var(--line-2); border-radius: 8px; padding: 0 6px; }
  .err, .muted { margin: 2px 0; font-size: 12.5px; }
  .sm { height: 24px; font-size: 12px; padding: 0 8px; }
</style>
