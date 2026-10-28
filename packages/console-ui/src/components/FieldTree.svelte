<script lang="ts">
  // A document's fields as a tree: name, type mark, value; maps and arrays fold. With `edit`,
  // a value is changed in place (its type kept or chosen), a field added or removed.
  import Icon from './Icon.svelte';
  import TypeMark from './TypeMark.svelte';
  import FieldTree from './FieldTree.svelte';
  import { kindOf, preview, type Kind } from '../lib/values';

  let { value, edit = false, depth = 0, onchange, onref }: { value: Record<string, unknown> | unknown[]; edit?: boolean; depth?: number; onchange?: (v: Record<string, unknown> | unknown[]) => void; onref?: (path: string) => void } = $props();

  const isArr = $derived(Array.isArray(value));
  const entries = $derived(isArr ? (value as unknown[]).map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
  let open = $state<Record<string, boolean>>({});
  let editing = $state<string | null>(null);
  let draft = $state({ kind: 'string' as Kind, text: '' });
  let adding = $state(false);
  let addKey = $state('');

  const EDITABLE: Kind[] = ['string', 'number', 'boolean', 'null', 'timestamp', 'reference', 'map', 'array'];

  function set(k: string, v: unknown) {
    if (isArr) {
      const next = [...(value as unknown[])];
      next[Number(k)] = v;
      onchange?.(next);
    } else onchange?.({ ...(value as Record<string, unknown>), [k]: v });
  }
  function remove(k: string) {
    if (isArr) onchange?.((value as unknown[]).filter((_, i) => String(i) !== k));
    else {
      const { [k]: _, ...rest } = value as Record<string, unknown>;
      onchange?.(rest);
    }
  }
  function begin(k: string, v: unknown) {
    const kind = kindOf(v);
    editing = k;
    draft = { kind, text: kind === 'string' ? (v as string) : kind === 'timestamp' ? (v as { __ts: string }).__ts : kind === 'reference' ? (v as { __ref: string }).__ref : kind === 'map' || kind === 'array' ? JSON.stringify(v, null, 2) : String(v) };
  }
  function commit(k: string) {
    const t = draft.text;
    let v: unknown;
    try {
      switch (draft.kind) {
        case 'string': v = t; break;
        case 'number': if (t.trim() === '' || isNaN(Number(t))) throw new Error('not a number'); v = Number(t); break;
        case 'boolean': v = t === 'true'; break;
        case 'null': v = null; break;
        case 'timestamp': if (isNaN(+new Date(t))) throw new Error('not a date'); v = { __ts: new Date(t).toISOString() }; break;
        case 'reference': v = { __ref: t.replace(/^\/+/, '') }; break;
        case 'map': case 'array': v = JSON.parse(t); break;
        default: v = t;
      }
    } catch (e) {
      draft.text = t;
      alertBad = (e as Error).message;
      return;
    }
    alertBad = '';
    editing = null;
    set(k, v);
  }
  let alertBad = $state('');
  function addField() {
    const k = isArr ? String((value as unknown[]).length) : addKey.trim();
    if (!k || (!isArr && k in (value as object))) return;
    adding = false;
    addKey = '';
    set(k, '');
    queueMicrotask(() => begin(k, ''));
  }
</script>

<ul class="tree" class:root={depth === 0}>
  {#each entries as [k, v] (k)}
    {@const kind = kindOf(v)}
    {@const nested = kind === 'map' || kind === 'array'}
    <li>
      <div class="row" class:editing={editing === k}>
        <span class="twisty">
          {#if nested && editing !== k}<button class="tw" aria-label={open[k] ? 'Collapse' : 'Expand'} aria-expanded={!!open[k]} onclick={() => (open[k] = !open[k])}><span class:rot={open[k]}><Icon name="chevron" size={12} /></span></button>{/if}
        </span>
        <span class="key mono">{isArr ? `[${k}]` : k}</span>
        <TypeMark {kind} />
        {#if editing === k}
          <span class="editor">
            <select class="select sm" bind:value={draft.kind}>{#each EDITABLE as e}<option value={e}>{e}</option>{/each}</select>
            {#if draft.kind === 'boolean'}
              <select class="select sm" bind:value={draft.text}><option value="true">true</option><option value="false">false</option></select>
            {:else if draft.kind === 'map' || draft.kind === 'array'}
              <textarea class="code" rows="4" bind:value={draft.text}></textarea>
            {:else if draft.kind !== 'null'}
              <!-- svelte-ignore a11y_autofocus -->
              <input class="input sm mono" autofocus bind:value={draft.text} placeholder={draft.kind === 'timestamp' ? '2026-10-28T10:00:00Z' : draft.kind === 'reference' ? 'collection/doc' : ''} onkeydown={(e) => { if (e.key === 'Enter') commit(k); if (e.key === 'Escape') editing = null; }} />
            {/if}
            <button class="btn sm primary" onclick={() => commit(k)}>Set</button>
            <button class="btn sm ghost" onclick={() => { editing = null; alertBad = ''; }}>Cancel</button>
            {#if alertBad}<span class="err sm-t">{alertBad}</span>{/if}
          </span>
        {:else}
          <span class="val v-{kind} mono" title={kind === 'string' ? (v as string) : undefined}>
            {#if kind === 'reference' && onref}<button class="ref" onclick={() => onref?.((v as { __ref: string }).__ref)}>{preview(v, 120)}</button>{:else}{nested && open[k] ? '' : preview(v, 120)}{/if}
          </span>
          {#if edit}
            <span class="acts">
              {#if !nested}<button class="btn ghost icon sm" aria-label="Edit {k}" onclick={() => begin(k, v)}><Icon name="edit" size={14} /></button>{/if}
              <button class="btn ghost icon sm" aria-label="Remove {k}" onclick={() => remove(k)}><Icon name="trash" size={14} /></button>
            </span>
          {/if}
        {/if}
      </div>
      {#if nested && open[k] && editing !== k}
        <div class="kids"><FieldTree value={v as Record<string, unknown>} {edit} depth={depth + 1} onchange={(nv) => set(k, nv)} {onref} /></div>
      {/if}
    </li>
  {/each}
  {#if edit}
    <li class="add">
      {#if adding && !isArr}
        <span class="twisty"></span>
        <!-- svelte-ignore a11y_autofocus -->
        <input class="input sm mono" autofocus placeholder="field name" bind:value={addKey} onkeydown={(e) => { if (e.key === 'Enter') addField(); if (e.key === 'Escape') adding = false; }} />
        <button class="btn sm" onclick={addField}>Add</button>
      {:else}
        <button class="btn ghost sm addbtn" onclick={() => (isArr ? addField() : (adding = true))}><Icon name="plus" size={13} />{isArr ? 'Add item' : 'Add field'}</button>
      {/if}
    </li>
  {/if}
</ul>

<style>
  .tree { list-style: none; margin: 0; padding: 0; }
  .row { display: flex; align-items: center; gap: 10px; min-height: 32px; padding: 2px 8px 2px 0; border-radius: 5px; }
  .row:hover { background: var(--hover); }
  .row.editing { background: var(--accent-wash); align-items: flex-start; padding: 6px 8px 6px 0; }
  .twisty { width: 18px; flex: none; display: grid; place-items: center; }
  .tw { border: 0; background: none; padding: 2px; cursor: pointer; color: var(--ink-3); display: grid; }
  .tw span { display: grid; transition: transform 0.12s; }
  .tw span.rot { transform: rotate(90deg); }
  .key { min-width: 120px; color: var(--ink); font-weight: 500; }
  .val { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ref { border: 0; background: none; padding: 0; font: inherit; color: var(--t-reference); text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .acts { display: flex; gap: 2px; opacity: 0; }
  .row:hover .acts, .row:focus-within .acts { opacity: 1; }
  .kids { margin-left: 18px; padding-left: 8px; border-left: 1px solid var(--line); }
  .editor { flex: 1; display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; }
  .editor textarea { flex: 1 1 100%; }
  .editor .input { flex: 1; min-width: 160px; }
  .sm { height: 26px; font-size: 12.5px; }
  .btn.sm { padding: 0 9px; }
  .btn.icon.sm { width: 26px; padding: 0; }
  .sm-t { font-size: 12px; align-self: center; }
  .add { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
  .addbtn { color: var(--accent-ink); }
</style>
