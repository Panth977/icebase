<script lang="ts">
  import { api } from '../lib/api';
  import Icon from '../components/Icon.svelte';
  import PageHead from '../components/PageHead.svelte';
  import Code from '../components/Code.svelte';
  import { toast } from '../components/Toasts.svelte';
  let sites = $state<{ name: string; defaultUrl: string; type?: string }[] | null>(null);
  let err = $state('');
  let siteId = $state('');
  let domain = $state('');
  let forSite = $state('');
  let dns = $state<unknown>(null);
  const load = () => api<{ sites: NonNullable<typeof sites> }>('hosting.sites').then((r) => { sites = r.sites; forSite ||= r.sites[0]?.name.split('/').pop() ?? ''; }).catch((e) => (err = e.message));
  load();
</script>

<div class="page">
  <PageHead title="Hosting" sub="The sites this deployment serves, and their domains." />
  {#if err}<p class="err">{err}</p>{:else if !sites}<p class="muted">Loading…</p>{:else}
    <section class="surface">
      <table class="grid"><thead><tr><th>Site</th><th>Address</th><th></th></tr></thead>
        <tbody>{#each sites as s}<tr><td class="mono">{s.name.split('/').pop()}</td><td>{#if /^https?:\/\/[^ ]+$/.test(s.defaultUrl)}<a href={s.defaultUrl} target="_blank" rel="noopener">{s.defaultUrl}</a>{:else}<span class="muted">{s.defaultUrl}</span>{/if}</td><td>{#if s.type === 'DEFAULT_SITE'}<span class="pill">default</span>{/if}</td></tr>{/each}</tbody>
      </table>
    </section>
    <div class="forms">
      <form class="surface box" onsubmit={async (e) => { e.preventDefault(); try { await api('hosting.createSite', { siteId }); toast(`Site ${siteId} created`); siteId = ''; load(); } catch (x) { toast((x as Error).message, true); } }}>
        <h2>New site</h2><div class="row"><input class="input mono" placeholder="site-id" bind:value={siteId} /><button class="btn primary sm" disabled={!siteId}><Icon name="plus" size={13} />Create site</button></div>
      </form>
      <form class="surface box" onsubmit={async (e) => { e.preventDefault(); try { dns = await api('hosting.setDNS', { domain, site: forSite }); } catch (x) { toast((x as Error).message, true); } }}>
        <h2>Connect a domain</h2><div class="row"><input class="input mono" placeholder="docs.example.com" bind:value={domain} /><select class="select" bind:value={forSite}>{#each sites as s}<option>{s.name.split('/').pop()}</option>{/each}</select><button class="btn primary sm" disabled={!domain}>Connect</button></div>
        {#if dns}<p class="muted">Set these records at your registrar:</p><Code code={JSON.stringify(dns, null, 2)} lang="json" />{/if}
      </form>
    </div>
  {/if}
</div>

<style>
  .page { padding: 24px 28px 40px; max-width: 1100px; }
  section { overflow: hidden; }
  .forms { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-top: 16px; }
  .box { padding: 14px 16px; }
  h2 { margin: 0 0 10px; font-size: 13.5px; }
  .row { display: flex; gap: 8px; }
  .row .input { flex: 1; min-width: 0; }
  .sm { height: 30px; font-size: 12.5px; }
  @media (max-width: 900px) { .forms { grid-template-columns: 1fr; } }
</style>
