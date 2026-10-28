<script lang="ts">
  // Firestore as three panes: the collections at this level, the documents of one, the fields of
  // one document. The address holds the path, so any document is a link.
  import { api } from '../lib/api';
  import { route, go } from '../lib/router.svelte';
  import Icon from '../components/Icon.svelte';
  import Empty from '../components/Empty.svelte';
  import FieldTree from '../components/FieldTree.svelte';
  import { toast } from '../components/Toasts.svelte';

  type Doc = { id: string; path: string; data: Record<string, unknown> };
  type Col = { path: string; id: params; fields: { name: string; type: string }[]; indexes: { code: string }[] };
  type params = string;

  const segs = $derived(route.rest ? route.rest.split('/') : []);
  /** The collection on screen: the path itself, or the parent of a document path. */
  const colPath = $derived(segs.length === 0 ? '' : segs.length % 2 === 1 ? segs.join('/') : segs.slice(0, -1).join('/'));
  const docPath = $derived(segs.length && segs.length % 2 === 0 ? segs.join('/') : '');
  /** The document the collections pane lists under ('' = the root). */
  const parentDoc = $derived(colPath.split('/').slice(0, -1).join('/'));

  let schema = $state<{ collections: { path: string; id: string; params: string[]; group: boolean; fields: { name: string; type: string; optional?: boolean }[]; indexes: { code: string }[] }[] } | null>(null);
  let cols = $state<string[] | null>(null);
  let colsErr = $state('');
  let colFilter = $state('');
  let docs = $state<Doc[]>([]);
  let docsErr = $state('');
  let docsBusy = $state(false);
  let more = $state(false);
  let docFilter = $state('');
  let doc = $state<{ exists: boolean; data: Record<string, unknown> | null } | null>(null);
  let docErr = $state('');
  let draft = $state<Record<string, unknown> | null>(null);
  let mode = $state<'fields' | 'json'>('fields');
  let json = $state('');
  let subs = $state<string[]>([]);
  let saving = $state(false);
  let newId = $state('');
  let querying = $state(false);
  let filters = $state<{ field: string; op: string; value: string }[]>([]);
  let order = $state<{ field: string; dir: 'asc' | 'desc' }>({ field: '', dir: 'asc' });
  let queryNote = $state('');

  const declared = $derived(schema?.collections.find((c) => matches(c.path, colPath)) ?? null);
  function matches(tpl: string, path: string) {
    const a = tpl.split('/');
    const b = path.split('/');
    return a.length === b.length && a.every((s, i) => /^\{.+\}$/.test(s) || s === b[i]);
  }
  const dirty = $derived(!!draft && !!doc && JSON.stringify(draft) !== JSON.stringify(doc.data));

  api('schema').then((s) => (schema = s)).catch(() => {});

  $effect(() => {
    const p = parentDoc;
    cols = null;
    colsErr = '';
    api<{ ids: string[] }>('fs.collections', p ? { path: p } : {})
      .then((r) => {
        // Declared root collections that are still empty are shown too.
        const known = p ? [] : (schema?.collections ?? []).filter((c) => !c.params.length).map((c) => c.id);
        cols = [...new Set([...r.ids, ...known])].sort();
      })
      .catch((e) => (colsErr = e.message));
  });

  async function loadDocs(after?: string) {
    if (!colPath) return;
    docsBusy = true;
    docsErr = '';
    try {
      const r = await api<{ docs: Doc[] }>('fs.list', { path: colPath, limit: 50, ...(after ? { after } : {}) });
      docs = after ? [...docs, ...r.docs] : r.docs;
      more = r.docs.length === 50;
    } catch (e) {
      docsErr = (e as Error).message;
    }
    docsBusy = false;
  }
  $effect(() => {
    colPath;
    querying = false;
    filters = [];
    docs = [];
    loadDocs();
  });

  $effect(() => {
    const p = docPath;
    doc = null;
    draft = null;
    docErr = '';
    subs = [];
    if (!p) return;
    api<{ exists: boolean; data: Record<string, unknown> | null }>('fs.get', { path: p })
      .then((r) => {
        doc = r;
        draft = r.data ? structuredClone($state.snapshot(r.data) as Record<string, unknown>) : {};
        json = JSON.stringify(r.data ?? {}, null, 2);
      })
      .catch((e) => (docErr = e.message));
    api<{ ids: string[] }>('fs.collections', { path: p }).then((r) => (subs = r.ids)).catch(() => {});
  });

  async function save() {
    if (!docPath || !draft) return;
    saving = true;
    try {
      const data = mode === 'json' ? JSON.parse(json) : $state.snapshot(draft);
      await api('fs.set', { path: docPath, data });
      doc = { exists: true, data: structuredClone(data) };
      draft = structuredClone(data);
      json = JSON.stringify(data, null, 2);
      toast('Document saved');
      if (!docs.some((d) => d.path === docPath)) loadDocs();
    } catch (e) {
      toast((e as Error).message, true);
    }
    saving = false;
  }
  async function remove() {
    if (!docPath || !confirm(`Delete ${docPath}? Its subcollections stay.`)) return;
    try {
      await api('fs.delete', { path: docPath });
      toast('Document deleted');
      docs = docs.filter((d) => d.path !== docPath);
      go('firestore', colPath);
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  function create() {
    const id = newId.trim() || crypto.randomUUID().replace(/-/g, '').slice(0, 20);
    newId = '';
    go('firestore', `${colPath}/${id}`);
  }
  function parseValue(s: string): unknown {
    const t = s.trim();
    if (t === 'true' || t === 'false') return t === 'true';
    if (t === 'null') return null;
    if (t !== '' && !isNaN(Number(t))) return Number(t);
    try {
      if (/^[[{"]/.test(t)) return JSON.parse(t);
    } catch {}
    return s;
  }
  async function runQuery() {
    docsBusy = true;
    docsErr = '';
    queryNote = '';
    try {
      const r = await api<{ docs: Doc[] }>('fs.query', {
        path: colPath,
        filters: filters.filter((f) => f.field).map((f) => ({ field: f.field, op: f.op, value: f.op === 'in' || f.op === 'not-in' || f.op === 'array-contains-any' ? f.value.split(',').map((x) => parseValue(x)) : parseValue(f.value) })),
        orders: order.field ? [{ field: order.field, dir: order.dir }] : [],
        limit: 100,
      });
      docs = r.docs;
      more = false;
      queryNote = `${r.docs.length} matching`;
    } catch (e) {
      docsErr = (e as Error).message;
      docs = [];
    }
    docsBusy = false;
  }
  const shownCols = $derived((cols ?? []).filter((c) => !colFilter || c.toLowerCase().includes(colFilter.toLowerCase())));
  const shownDocs = $derived(docs.filter((d) => !docFilter || d.id.toLowerCase().includes(docFilter.toLowerCase())));
  /** A field to show beside each id: a name, title or email if the documents have one. */
  const labelField = $derived(['name', 'title', 'email', 'key', 'displayName'].find((f) => docs.some((d) => typeof d.data?.[f] === 'string')) ?? null);
</script>

<div class="fs">
  <section class="pane cols">
    <div class="ph">
      {#if parentDoc}
        <button class="btn ghost sm up" onclick={() => go('firestore', parentDoc)} title="Back to {parentDoc}"><span class="flip"><Icon name="chevron" size={12} /></span><span class="mono">{parentDoc.split('/').pop()}</span></button>
      {:else}<h3>Collections</h3>{/if}
    </div>
    <div class="search"><Icon name="search" size={14} /><input placeholder="Filter" bind:value={colFilter} /></div>
    <div class="list">
      {#if colsErr}<p class="err pad">{colsErr}</p>
      {:else if !cols}<p class="muted pad">Loading…</p>
      {:else if !shownCols.length}<Empty icon="firestore" title={parentDoc ? 'No subcollections' : 'No collections yet'} />
      {:else}
        {#each shownCols as c}
          {@const p = parentDoc ? `${parentDoc}/${c}` : c}
          <a class="item" class:on={colPath === p} href="#/firestore/{p}"><Icon name="folder" size={14} /><span class="mono">{c}</span></a>
        {/each}
      {/if}
    </div>
  </section>

  <section class="pane docs">
    {#if !colPath}
      <Empty icon="firestore" title="Choose a collection">Its documents open here; pick one to see and edit its fields.</Empty>
    {:else}
      <div class="ph">
        <h3 class="mono">{colPath.split('/').pop()}</h3>
        <div class="tools">
          <button class="btn ghost icon sm" class:on={querying} aria-label="Query" title="Query this collection" onclick={() => { querying = !querying; if (!querying) loadDocs(); }}><Icon name="filter" size={14} /></button>
          <button class="btn ghost icon sm" aria-label="Refresh" onclick={() => (querying ? runQuery() : loadDocs())}><Icon name="refresh" size={14} /></button>
        </div>
      </div>
      {#if querying}
        <div class="query">
          {#each filters as f, i}
            <div class="qrow">
              <select class="select sm" bind:value={f.field}><option value="">field</option>{#each declared?.fields ?? [] as fd}<option value={fd.name}>{fd.name}</option>{/each}</select>
              <select class="select sm op" bind:value={f.op}>{#each ['==', '!=', '<', '<=', '>', '>=', 'in', 'not-in', 'array-contains', 'array-contains-any'] as o}<option>{o}</option>{/each}</select>
              <input class="input sm mono" bind:value={f.value} placeholder="value" />
              <button class="btn ghost icon sm" aria-label="Remove filter" onclick={() => filters.splice(i, 1)}><Icon name="close" size={13} /></button>
            </div>
          {/each}
          <div class="qrow">
            <button class="btn ghost sm" onclick={() => filters.push({ field: declared?.fields[0]?.name ?? '', op: '==', value: '' })}><Icon name="plus" size={13} />Where</button>
            <select class="select sm" bind:value={order.field}><option value="">order by id</option>{#each declared?.fields ?? [] as fd}<option value={fd.name}>{fd.name}</option>{/each}</select>
            {#if order.field}<select class="select sm op" bind:value={order.dir}><option value="asc">asc</option><option value="desc">desc</option></select>{/if}
            <button class="btn primary sm" onclick={runQuery}>Run</button>
          </div>
          {#if declared?.indexes.length}<p class="hint">Indexes: {#each declared.indexes as ix}<code>{ix.code}</code> {/each}</p>{/if}
        </div>
      {:else}
        <div class="search"><Icon name="search" size={14} /><input placeholder="Filter loaded ids" bind:value={docFilter} /></div>
      {/if}
      <div class="list">
        {#if docsErr}<div class="pad"><p class="err">{docsErr}</p>{#if /index/i.test(docsErr)}<p class="hint">Declare that index in the schema, then deploy it (setSchema).</p>{/if}</div>{/if}
        {#if queryNote}<p class="muted pad sm-t">{queryNote}</p>{/if}
        {#each shownDocs as d (d.path)}
          <a class="item doc" class:on={docPath === d.path} href="#/firestore/{d.path}">
            <span class="mono id">{d.id}</span>
            {#if labelField && typeof d.data?.[labelField] === 'string'}<span class="lbl">{d.data[labelField]}</span>{/if}
          </a>
        {/each}
        {#if !docsBusy && !docs.length && !docsErr}<Empty icon="file" title={querying ? 'Nothing matches' : 'No documents'} />{/if}
        {#if docsBusy}<p class="muted pad">Loading…</p>{/if}
        {#if more && !querying}<button class="btn ghost sm more" onclick={() => loadDocs(docs.at(-1)?.id)}>Load more</button>{/if}
      </div>
      {#if !querying}
        <form class="new" onsubmit={(e) => { e.preventDefault(); create(); }}>
          <input class="input sm mono" placeholder="New document id (blank = auto)" bind:value={newId} />
          <button class="btn sm"><Icon name="plus" size={13} />Add</button>
        </form>
      {/if}
    {/if}
  </section>

  <section class="pane detail">
    {#if !docPath}
      <Empty icon="file" title={colPath ? 'Choose a document' : 'Nothing selected'}>
        {#if declared}<span>{declared.fields.length} fields declared for <code>{declared.path}</code>.</span>{/if}
      </Empty>
    {:else if docErr}
      <p class="err pad">{docErr}</p>
    {:else if !doc || !draft}
      <p class="muted pad">Loading…</p>
    {:else}
      <div class="ph">
        <div class="title">
          <h3 class="mono">{docPath.split('/').pop()}</h3>
          {#if !doc.exists}<span class="pill accent">new</span>{/if}
          {#if declared}<span class="pill" title="Writes are checked against this declaration">{declared.path}</span>{/if}
        </div>
        <div class="tools">
          <div class="seg" role="tablist">
            <button role="tab" aria-selected={mode === 'fields'} class:on={mode === 'fields'} onclick={() => { if (mode === 'json') { try { draft = JSON.parse(json); } catch { toast('Fix the JSON first', true); return; } } mode = 'fields'; }}>Fields</button>
            <button role="tab" aria-selected={mode === 'json'} class:on={mode === 'json'} onclick={() => { json = JSON.stringify(draft, null, 2); mode = 'json'; }}>JSON</button>
          </div>
          {#if doc.exists}<button class="btn danger sm" onclick={remove}><Icon name="trash" size={13} />Delete</button>{/if}
          <button class="btn primary sm" disabled={saving || (mode === 'fields' && !dirty && doc.exists)} onclick={save}>{saving ? 'Saving…' : doc.exists ? 'Save' : 'Create'}</button>
        </div>
      </div>
      <div class="body">
        {#if mode === 'fields'}
          <FieldTree value={draft} edit onchange={(v) => (draft = v as Record<string, unknown>)} onref={(p) => go('firestore', p)} />
          {#if dirty}<p class="hint">Unsaved changes.</p>{/if}
        {:else}
          <textarea class="code json" spellcheck="false" bind:value={json}></textarea>
          <p class="hint">Timestamps are <code>{'{"__ts": "…ISO…"}'}</code>, references <code>{'{"__ref": "col/doc"}'}</code>.</p>
        {/if}
        {#if subs.length}
          <h4>Subcollections</h4>
          <div class="subs">{#each subs as s}<a class="pill" href="#/firestore/{docPath}/{s}"><Icon name="folder" size={12} />{s}</a>{/each}</div>
        {/if}
        {#if declared && mode === 'fields'}
          <h4>Declared fields</h4>
          <div class="decl">
            {#each declared.fields as f}
              <span class="mono" class:missing={!f.optional && !(f.name in (draft ?? {}))}>{f.name}{f.optional ? '?' : ''}</span><span class="muted mono">{f.type}</span>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </section>
</div>

<style>
  .fs { display: grid; grid-template-columns: 220px 300px minmax(0, 1fr); height: 100%; min-height: 0; }
  .pane { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--line); background: var(--paper); }
  .pane.detail { background: var(--mist); border-right: 0; }
  .ph { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 48px; padding: 8px 12px 8px 16px; border-bottom: 1px solid var(--line); }
  .detail .ph { background: var(--paper); }
  h3 { margin: 0; font-size: 13.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  h4 { margin: 22px 0 8px; font-size: 12.5px; font-weight: 600; color: var(--ink-2); }
  .title { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .tools { display: flex; align-items: center; gap: 6px; flex: none; }
  .search { display: flex; align-items: center; gap: 6px; margin: 8px 10px 4px; padding: 0 8px; height: 30px; border: 1px solid var(--line); border-radius: var(--radius); color: var(--ink-3); background: var(--mist); }
  .search input { border: 0; background: none; outline: none; flex: 1; min-width: 0; font-size: 13px; }
  .list { flex: 1; overflow: auto; padding: 4px 6px 10px; }
  .item { display: flex; align-items: center; gap: 8px; min-height: 30px; padding: 4px 10px; border-radius: 5px; color: var(--ink); text-decoration: none; }
  .item:hover { background: var(--hover); }
  .item.on { background: var(--accent-wash); color: var(--accent-ink); }
  .item.doc { justify-content: space-between; }
  .id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .lbl { color: var(--ink-3); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 50%; }
  .pad { padding: 12px; margin: 0; }
  .sm-t { font-size: 12px; }
  .more { width: 100%; margin-top: 4px; }
  .new { display: flex; gap: 6px; padding: 10px; border-top: 1px solid var(--line); }
  .new .input { flex: 1; }
  .up { gap: 4px; }
  .flip { display: grid; transform: rotate(180deg); }
  .btn.on { background: var(--accent-wash); color: var(--accent-ink); }
  .query { display: grid; gap: 6px; padding: 10px; border-bottom: 1px solid var(--line); background: var(--mist); }
  .qrow { display: flex; gap: 6px; align-items: center; }
  .qrow .input { flex: 1; min-width: 0; }
  .qrow .select { max-width: 120px; }
  .op { width: 70px; }
  .hint { margin: 8px 0 0; font-size: 12px; color: var(--ink-3); }
  .hint code, p code { font: 11.5px var(--mono); }
  .body { padding: 14px 20px 30px; overflow: auto; flex: 1; }
  .json { min-height: 420px; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
  .seg button { border: 0; background: var(--paper); padding: 0 10px; height: 26px; cursor: pointer; font-size: 12.5px; color: var(--ink-2); }
  .seg button.on { background: var(--accent-wash); color: var(--accent-ink); font-weight: 500; }
  .subs { display: flex; flex-wrap: wrap; gap: 6px; }
  .subs a { text-decoration: none; }
  .decl { display: grid; grid-template-columns: max-content 1fr; gap: 3px 16px; font-size: 12.5px; }
  .missing { color: var(--danger); }
  .sm { height: 26px; font-size: 12.5px; }
  .btn.sm { padding: 0 9px; }
  .btn.icon.sm { width: 26px; padding: 0; }
  @media (max-width: 1100px) { .fs { grid-template-columns: 180px 240px minmax(0, 1fr); } }
</style>
