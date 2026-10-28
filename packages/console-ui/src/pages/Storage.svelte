<script lang="ts">
  // Files by folder: drop files to upload, open one to preview, download or delete it.
  import { api } from '../lib/api';
  import { route, go } from '../lib/router.svelte';
  import Icon from '../components/Icon.svelte';
  import PageHead from '../components/PageHead.svelte';
  import Empty from '../components/Empty.svelte';
  import { toast } from '../components/Toasts.svelte';
  import { fmtBytes, fmtWhen } from '../lib/values';

  type F = { name: string; size: number; contentType: string | null; updated: string | null };
  let buckets = $state<string[]>([]);
  let bucket = $state('');
  const prefix = $derived(route.rest ? `${route.rest.replace(/\/?$/, '/')}` : '');
  let folders = $state<string[]>([]);
  let files = $state<F[] | null>(null);
  let err = $state('');
  let sel = $state<{ name: string; contentType: string; size: number; url: string; text?: string } | null>(null);
  let drag = $state(false);
  let busy = $state(0);

  api<{ default: string; buckets: string[] }>('st.buckets').then((r) => { buckets = r.buckets; bucket = r.default; }).catch((e) => (err = e.message));
  async function load() {
    if (!bucket) return;
    files = null;
    err = '';
    try {
      const r = await api<{ folders: string[]; files: F[] }>('st.list', { bucket, prefix });
      folders = r.folders;
      files = r.files;
    } catch (e) {
      err = (e as Error).message;
    }
  }
  $effect(() => {
    bucket;
    prefix;
    sel = null;
    load();
  });
  async function open(f: F) {
    try {
      const r = await api<{ name: string; contentType: string; size: number; base64: string }>('st.read', { bucket, name: f.name });
      const bin = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bin], { type: r.contentType }));
      sel = { name: r.name, contentType: r.contentType, size: r.size, url, ...(/^text\/|json|xml|javascript/.test(r.contentType) ? { text: new TextDecoder().decode(bin).slice(0, 50_000) } : {}) };
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function upload(list: FileList | File[]) {
    for (const f of Array.from(list)) {
      busy++;
      try {
        const b64 = await new Promise<string>((ok, bad) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1] ?? ''); r.onerror = () => bad(r.error); r.readAsDataURL(f); });
        await api('st.upload', { bucket, name: prefix + f.name, contentType: f.type || 'application/octet-stream', base64: b64 });
        toast(`Uploaded ${f.name}`);
      } catch (e) {
        toast(`${f.name}: ${(e as Error).message}`, true);
      }
      busy--;
    }
    load();
  }
  async function del(name: string) {
    if (!confirm(`Delete ${name}?`)) return;
    try {
      await api('st.delete', { bucket, name });
      toast('File deleted');
      sel = null;
      load();
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
</script>

<div class="page">
  <PageHead title="Storage" sub="Files, by folder. Drop files anywhere on the list to upload them here.">
    {#snippet actions()}
      {#if buckets.length > 1}<select class="select" bind:value={bucket}>{#each buckets as b}<option>{b}</option>{/each}</select>{:else}<span class="pill mono">{bucket}</span>{/if}
      <label class="btn primary"><Icon name="upload" size={14} />Upload<input type="file" multiple hidden onchange={(e) => upload((e.target as HTMLInputElement).files!)} /></label>
    {/snippet}
  </PageHead>

  <div class="crumbs">
    <button onclick={() => go('storage')}>{bucket || 'bucket'}</button>
    {#each prefix.split('/').filter(Boolean) as s, i}<Icon name="chevron" size={12} /><button class="mono" onclick={() => go('storage', prefix.split('/').filter(Boolean).slice(0, i + 1).join('/'))}>{s}</button>{/each}
    {#if busy}<span class="muted">uploading {busy}…</span>{/if}
  </div>

  <div class="layout" class:withside={!!sel}>
    <div class="surface listbox" class:drag role="region" aria-label="Files" ondragover={(e) => { e.preventDefault(); drag = true; }} ondragleave={() => (drag = false)} ondrop={(e) => { e.preventDefault(); drag = false; if (e.dataTransfer?.files.length) upload(e.dataTransfer.files); }}>
      {#if err}<p class="err pad">{err}</p>
      {:else if !files}<p class="muted pad">Loading…</p>
      {:else if !folders.length && !files.length}<Empty icon="storage" title="This folder is empty">Drop files here or use Upload.</Empty>
      {:else}
        <table class="grid">
          <thead><tr><th>Name</th><th>Type</th><th>Size</th><th>Updated</th></tr></thead>
          <tbody>
            {#each folders as f}<tr class="click" onclick={() => go('storage', f.replace(/\/$/, ''))}><td><span class="nm"><Icon name="folder" size={15} /><span class="mono">{f.slice(prefix.length)}</span></span></td><td class="muted">folder</td><td></td><td></td></tr>{/each}
            {#each files as f (f.name)}<tr class="click" class:sel={sel?.name === f.name} onclick={() => open(f)}><td><span class="nm"><Icon name="file" size={15} /><span class="mono">{f.name.slice(prefix.length)}</span></span></td><td class="muted">{f.contentType ?? ''}</td><td class="muted">{fmtBytes(f.size)}</td><td class="muted">{fmtWhen(f.updated)}</td></tr>{/each}
          </tbody>
        </table>
      {/if}
    </div>
    {#if sel}
      <aside class="surface side">
        <div class="sh"><span class="mono name">{sel.name.split('/').pop()}</span><button class="btn ghost icon" aria-label="Close" onclick={() => (sel = null)}><Icon name="close" /></button></div>
        <div class="prev">
          {#if sel.contentType.startsWith('image/')}<img src={sel.url} alt={sel.name} />
          {:else if sel.contentType.startsWith('video/')}<!-- svelte-ignore a11y_media_has_caption --><video src={sel.url} controls></video>
          {:else if sel.text !== undefined}<pre class="mono">{sel.text}</pre>
          {:else}<Empty icon="file" title="No preview for this type" />{/if}
        </div>
        <dl><dt>Path</dt><dd class="mono">{sel.name}</dd><dt>Type</dt><dd>{sel.contentType}</dd><dt>Size</dt><dd>{fmtBytes(sel.size)}</dd></dl>
        <div class="row"><a class="btn sm" href={sel.url} download={sel.name.split('/').pop()}><Icon name="download" size={13} />Download</a><button class="btn danger sm" onclick={() => del(sel!.name)}><Icon name="trash" size={13} />Delete</button></div>
      </aside>
    {/if}
  </div>
</div>

<style>
  .page { padding: 24px 28px 40px; }
  .crumbs { display: flex; align-items: center; gap: 4px; margin: -6px 0 12px; color: var(--ink-3); }
  .crumbs button { border: 0; background: none; padding: 3px 6px; border-radius: 4px; cursor: pointer; color: var(--accent-ink); }
  .crumbs button:hover { background: var(--hover); }
  .layout { display: grid; grid-template-columns: 1fr; gap: 16px; align-items: start; }
  .layout.withside { grid-template-columns: minmax(0, 1fr) 380px; }
  .listbox { overflow: hidden; min-height: 200px; transition: box-shadow 0.12s; }
  .listbox.drag { box-shadow: 0 0 0 3px var(--accent); }
  .nm { display: inline-flex; align-items: center; gap: 8px; color: var(--ink-2); }
  .side { position: sticky; top: 16px; padding: 14px 16px; }
  .sh { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
  .prev { margin: 12px 0; border-radius: var(--radius); background: var(--mist); overflow: hidden; display: grid; place-items: center; min-height: 120px; }
  .prev img, .prev video { max-width: 100%; max-height: 320px; display: block; }
  .prev pre { margin: 0; padding: 10px; width: 100%; max-height: 320px; overflow: auto; font-size: 12px; white-space: pre-wrap; }
  dl { display: grid; grid-template-columns: 56px 1fr; gap: 6px 10px; font-size: 13px; margin: 0 0 12px; }
  dt { color: var(--ink-3); }
  dd { margin: 0; word-break: break-all; }
  .row { display: flex; gap: 8px; justify-content: flex-end; }
  .row a { text-decoration: none; color: inherit; }
  .pad { padding: 12px 16px; margin: 0; }
  .sm { height: 28px; font-size: 12.5px; }
</style>
