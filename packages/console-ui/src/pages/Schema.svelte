<script lang="ts">
  // Every declaration as TypeScript, one folded section each: open the ones you need.
  import { api } from '../lib/api';
  import Icon from '../components/Icon.svelte';
  import Code from '../components/Code.svelte';
  import PageHead from '../components/PageHead.svelte';
  import { toast } from '../components/Toasts.svelte';

  type Block = { kind: 'collection' | 'path' | 'file'; path: string; name: string; code: string };
  let blocks = $state<Block[] | null>(null);
  let err = $state('');
  let q = $state('');
  let open = $state<Record<string, boolean>>({});
  let tab = $state<'collection' | 'path' | 'file'>('collection');
  api<{ blocks: Block[] }>('schema.ts').then((r) => (blocks = r.blocks)).catch((e) => (err = e.message));

  const count = (k: Block['kind']) => (blocks ?? []).filter((b) => b.kind === k).length;
  const shown = $derived((blocks ?? []).filter((b) => b.kind === tab && (!q || b.code.toLowerCase().includes(q.toLowerCase()) || b.path.toLowerCase().includes(q.toLowerCase()))));
  const fieldCount = (code: string) => (code.match(/^ {2}[\w"$?-]+\??:/gm) ?? []).length;
  const tsHead = (code: string) => code.split('\n').filter((l) => /^ \* (indexes|collection)/.test(l)).map((l) => l.replace(/^ \* /, ''));
  async function copy(text: string, what: string) {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what}`);
  }
  const all = $derived((blocks ?? []).map((b) => b.code).join('\n\n'));
  const expandAll = (v: boolean) => (open = Object.fromEntries(shown.map((b) => [b.path, v])));
</script>

<div class="page">
  <PageHead title="Schema" sub="What the database holds, as TypeScript: every write is checked against it.">
    {#snippet actions()}
      <button class="btn" onclick={() => copy(`import type { Timestamp, GeoPoint, DocumentReference } from '@panth977/icebase/firestore';\n\n${all}\n`, 'the schema as .ts')}><Icon name="copy" size={14} />Copy as .ts</button>
    {/snippet}
  </PageHead>

  {#if err}<p class="err">{err}</p>
  {:else if !blocks}<p class="muted">Loading…</p>
  {:else}
    <div class="bar">
      <div class="tabs" role="tablist">
        {#each [['collection', 'Firestore'], ['path', 'Realtime Database'], ['file', 'Storage']] as [k, l]}
          {#if count(k as Block['kind'])}<button role="tab" aria-selected={tab === k} class:on={tab === k} onclick={() => (tab = k as Block['kind'])}>{l}<span>{count(k as Block['kind'])}</span></button>{/if}
        {/each}
      </div>
      <div class="search"><Icon name="search" size={14} /><input placeholder="Find a collection, field or type" bind:value={q} /></div>
      <button class="btn ghost sm" onclick={() => expandAll(true)}>Expand all</button>
      <button class="btn ghost sm" onclick={() => expandAll(false)}>Collapse all</button>
    </div>

    <div class="acc surface">
      {#each shown as b (b.path)}
        <section class:open={open[b.path]}>
          <button class="sum" aria-expanded={!!open[b.path]} onclick={() => (open[b.path] = !open[b.path])}>
            <span class="chev"><Icon name="chevron" size={13} /></span>
            <span class="path mono">{b.path}</span>
            <span class="tname mono">{b.name}</span>
            <span class="meta">
              {#if b.kind === 'collection'}<span>{fieldCount(b.code)} fields</span>{/if}
              {#each tsHead(b.code).filter((l) => l.startsWith('indexes')) as l}<span class="ix" title={l}>{(l.match(/·/g)?.length ?? 0) + 1} {(l.match(/·/g)?.length ?? 0) ? 'indexes' : 'index'}</span>{/each}
              {#if b.code.includes('collection group')}<span class="pill">group</span>{/if}
            </span>
          </button>
          {#if open[b.path]}
            <div class="code">
              <button class="btn ghost icon sm copy" aria-label="Copy {b.name}" onclick={() => copy(b.code, b.name)}><Icon name="copy" size={14} /></button>
              <Code code={b.code} />
            </div>
          {/if}
        </section>
      {:else}
        <p class="muted pad">Nothing matches "{q}".</p>
      {/each}
    </div>
  {/if}
</div>

<style>
  .page { padding: 24px 28px 40px; max-width: 1180px; }
  .bar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; flex-wrap: wrap; }
  .tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: 8px; background: var(--line-2); }
  .tabs button { border: 0; background: none; height: 28px; padding: 0 12px; border-radius: 6px; cursor: pointer; color: var(--ink-2); display: inline-flex; align-items: center; gap: 6px; }
  .tabs button.on { background: var(--paper); color: var(--ink); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); font-weight: 500; }
  .tabs span { font-size: 11.5px; color: var(--ink-3); }
  .search { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 220px; height: 32px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--paper); color: var(--ink-3); }
  .search input { border: 0; outline: none; background: none; flex: 1; }
  .acc { overflow: hidden; }
  section + section { border-top: 1px solid var(--line-2); }
  .sum { display: grid; grid-template-columns: 18px minmax(0, 1.2fr) minmax(0, 0.8fr) 200px; align-items: center; gap: 12px; width: 100%; padding: 11px 16px; border: 0; background: none; text-align: left; cursor: pointer; color: var(--ink); }
  .sum:hover { background: var(--hover); }
  .chev { display: grid; color: var(--ink-3); transition: transform 0.12s; }
  .open .chev { transform: rotate(90deg); }
  .path { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tname { color: var(--t-timestamp); overflow: hidden; text-overflow: ellipsis; }
  .meta { display: flex; justify-content: flex-end; gap: 10px; align-items: center; font-size: 12px; color: var(--ink-3); }
  .code { position: relative; padding: 4px 16px 16px 46px; background: var(--mist); border-top: 1px solid var(--line-2); }
  .copy { position: absolute; top: 8px; right: 12px; }
  .pad { padding: 16px; margin: 0; }
  .sm { height: 28px; font-size: 12.5px; }
  .btn.icon.sm { width: 28px; }
</style>
