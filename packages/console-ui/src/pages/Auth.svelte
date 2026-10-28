<script lang="ts">
  // Users: search, open one in a side panel (claims, sessions, password, disable, delete);
  // sign-in methods; custom auth's attempts and blocks.
  import { api } from '../lib/api';
  import { app } from '../lib/state.svelte';
  import Icon from '../components/Icon.svelte';
  import PageHead from '../components/PageHead.svelte';
  import Empty from '../components/Empty.svelte';
  import Code from '../components/Code.svelte';
  import Dialog from '../components/Dialog.svelte';
  import { toast } from '../components/Toasts.svelte';
  import { fmtWhen } from '../lib/values';

  type User = { uid: string; email: string | null; phone: string | null; name: string | null; disabled: boolean; verified: boolean; claims: Record<string, unknown>; providers: string[]; created: string | null; lastSignIn: string | null };
  let tab = $state<'users' | 'methods' | 'security'>('users');
  let users = $state<User[] | null>(null);
  let next = $state<string | null>(null);
  let err = $state('');
  let q = $state('');
  let sel = $state<User | null>(null);
  let claims = $state('');
  let pw = $state('');
  let adding = $state(false);
  let nu = $state({ email: '', password: '', displayName: '' });
  let config = $state<unknown>(null);
  let ident = $state('');
  let attempts = $state<any>(null);

  async function load(more = false) {
    err = '';
    try {
      const r = await api<{ users: User[]; next: string | null }>('auth.list', { q, limit: 100, ...(more && next ? { next } : {}) });
      users = more ? [...(users ?? []), ...r.users] : r.users;
      next = r.next;
    } catch (e) {
      err = (e as Error).message;
    }
  }
  load();
  $effect(() => {
    if (tab === 'methods' && !config) api('auth.config').then((c) => (config = c)).catch((e) => (config = { error: e.message }));
  });
  function open(u: User) {
    sel = u;
    claims = JSON.stringify(u.claims, null, 2);
    pw = '';
  }
  async function update(body: Record<string, unknown>, what: string) {
    if (!sel) return;
    try {
      const u = await api<User>('auth.update', { uid: sel.uid, ...body });
      sel = u;
      users = (users ?? []).map((x) => (x.uid === u.uid ? u : x));
      toast(what);
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function del() {
    if (!sel || !confirm(`Delete ${sel.email ?? sel.uid}? Their data stays; they can no longer sign in.`)) return;
    try {
      await api('auth.delete', { uid: sel.uid });
      users = (users ?? []).filter((x) => x.uid !== sel!.uid);
      sel = null;
      toast('User deleted');
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function create() {
    try {
      const u = await api<User>('auth.create', nu);
      users = [u, ...(users ?? [])];
      adding = false;
      nu = { email: '', password: '', displayName: '' };
      toast('User created');
      open(u);
    } catch (e) {
      toast((e as Error).message, true);
    }
  }
  async function look() {
    attempts = null;
    try {
      attempts = await api('auth.attempts', { identifier: ident });
    } catch (e) {
      attempts = { error: (e as Error).message };
    }
  }
  const initials = (u: User) => (u.name ?? u.email ?? u.phone ?? u.uid).replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase();
  const who = (u: User) => u.email ?? u.phone ?? u.name ?? u.uid;
</script>

<div class="page">
  <PageHead title="Authentication" sub="Who can sign in, and how.">
    {#snippet actions()}
      <div class="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'users'} class:on={tab === 'users'} onclick={() => (tab = 'users')}>Users</button>
        <button role="tab" aria-selected={tab === 'methods'} class:on={tab === 'methods'} onclick={() => (tab = 'methods')}>Sign-in methods</button>
        {#if app.overview?.customAuth}<button role="tab" aria-selected={tab === 'security'} class:on={tab === 'security'} onclick={() => (tab = 'security')}>Attempts and blocks</button>{/if}
      </div>
    {/snippet}
  </PageHead>

  {#if tab === 'users'}
    <div class="layout" class:withside={!!sel}>
      <div class="surface listbox">
        <div class="bar">
          <form class="search" onsubmit={(e) => { e.preventDefault(); load(); }}><Icon name="search" size={14} /><input placeholder="Email, +phone or uid — Enter" bind:value={q} /></form>
          <button class="btn primary sm" onclick={() => (adding = true)}><Icon name="plus" size={13} />Add user</button>
        </div>
        {#if err}<p class="err pad">{err}</p>
        {:else if !users}<p class="muted pad">Loading…</p>
        {:else if !users.length}<Empty icon="users" title={q ? 'No user matches' : 'No users yet'} />
        {:else}
          <table class="grid">
            <thead><tr><th>User</th><th>Providers</th><th>Created</th><th>Last sign-in</th><th></th></tr></thead>
            <tbody>
              {#each users as u (u.uid)}
                <tr class="click" class:sel={sel?.uid === u.uid} onclick={() => open(u)}>
                  <td><div class="who"><span class="av" class:agent={u.uid.startsWith('ag_')}>{initials(u)}</span><div><div class="em">{who(u)}</div><div class="uid mono">{u.uid}</div></div></div></td>
                  <td>{#each u.providers as p}<span class="pill">{p.replace('.com', '')}</span> {/each}{#if !u.providers.length}<span class="muted">token</span>{/if}</td>
                  <td class="muted">{fmtWhen(u.created)}</td>
                  <td class="muted">{fmtWhen(u.lastSignIn)}</td>
                  <td>{#if u.disabled}<span class="pill danger">disabled</span>{/if}{#if Object.keys(u.claims).length}<span class="pill accent">claims</span>{/if}</td>
                </tr>
              {/each}
            </tbody>
          </table>
          {#if next}<div class="pad"><button class="btn sm" onclick={() => load(true)}>Load more</button></div>{/if}
        {/if}
      </div>

      {#if sel}
        <aside class="surface side">
          <div class="sh">
            <span class="av big" class:agent={sel.uid.startsWith('ag_')}>{initials(sel)}</span>
            <div class="sid"><div class="em">{who(sel)}</div><div class="uid mono">{sel.uid}</div></div>
            <button class="btn ghost icon" aria-label="Close" onclick={() => (sel = null)}><Icon name="close" /></button>
          </div>
          <dl>
            <dt>Email</dt><dd>{sel.email ?? '—'} {#if sel.email}<span class="pill" class:ok={sel.verified}>{sel.verified ? 'verified' : 'not verified'}</span>{/if}</dd>
            <dt>Phone</dt><dd>{sel.phone ?? '—'}</dd>
            <dt>Created</dt><dd>{sel.created ? new Date(sel.created).toLocaleString() : '—'}</dd>
            <dt>Last sign-in</dt><dd>{sel.lastSignIn ? new Date(sel.lastSignIn).toLocaleString() : '—'}</dd>
          </dl>
          <h3>Custom claims</h3>
          <textarea class="code" rows="5" spellcheck="false" bind:value={claims}></textarea>
          <div class="row"><button class="btn sm" onclick={() => { let c; try { c = JSON.parse(claims || '{}'); } catch { toast('Claims must be JSON', true); return; } update({ claims: c }, 'Claims saved'); }}>Save claims</button></div>
          <h3>Password</h3>
          <div class="row"><input class="input sm" type="password" placeholder="New password" bind:value={pw} /><button class="btn sm" disabled={pw.length < 6} onclick={() => update({ password: pw }, 'Password changed').then(() => (pw = ''))}>Set</button></div>
          <h3>Access</h3>
          <div class="row wrap">
            <button class="btn sm" onclick={() => update({ disabled: !sel!.disabled }, sel!.disabled ? 'User enabled' : 'User disabled')}>{sel.disabled ? 'Enable' : 'Disable'}</button>
            <button class="btn sm" onclick={() => update({ revoke: true }, 'Signed out everywhere')}><Icon name="signout" size={13} />Sign out everywhere</button>
            <button class="btn danger sm" onclick={del}><Icon name="trash" size={13} />Delete</button>
          </div>
        </aside>
      {/if}
    </div>
  {:else if tab === 'methods'}
    <div class="surface box">{#if !config}<p class="muted">Loading…</p>{:else}<Code code={JSON.stringify(config, null, 2)} lang="json" />{/if}</div>
  {:else}
    <div class="surface box">
      <form class="row" onsubmit={(e) => { e.preventDefault(); look(); }}><input class="input" style="flex:1" placeholder="Email or +phone" bind:value={ident} /><button class="btn primary sm">Look up</button></form>
      {#if attempts?.error}<p class="err">{attempts.error}</p>
      {:else if attempts}
        <div class="row wrap" style="margin:12px 0">
          <button class="btn sm" onclick={async () => { await api('auth.unblock', { identifier: ident }); toast('Unblocked'); look(); }}>Unblock</button>
          <button class="btn sm" onclick={async () => { await api('auth.resetLimits', { identifier: ident }); toast('Limits reset'); look(); }}>Reset limits</button>
        </div>
        <table class="grid"><thead><tr><th>When</th><th>Event</th><th>Channel</th><th>Device</th></tr></thead>
          <tbody>{#each attempts.attempts as a}<tr><td class="muted">{new Date(a.at).toLocaleString()}</td><td><span class="pill" class:danger={/limited|blocked|burned|wrong/.test(a.event)} class:ok={a.event === 'signed-in'}>{a.event}</span></td><td>{a.channel ?? ''}</td><td class="muted">{a.device ?? ''}</td></tr>{/each}</tbody>
        </table>
      {/if}
    </div>
  {/if}
</div>

{#if adding}
  <Dialog title="Add a user" onclose={() => (adding = false)}>
    <div class="form"><label>Email<input class="input" bind:value={nu.email} /></label><label>Password<input class="input" type="password" bind:value={nu.password} /></label><label>Display name<input class="input" bind:value={nu.displayName} /></label></div>
    {#snippet footer()}<button class="btn" onclick={() => (adding = false)}>Cancel</button><button class="btn primary" disabled={!nu.email} onclick={create}>Add user</button>{/snippet}
  </Dialog>
{/if}

<style>
  .page { padding: 24px 28px 40px; }
  .tabs { display: inline-flex; gap: 2px; padding: 3px; border-radius: 8px; background: var(--line-2); }
  .tabs button { border: 0; background: none; height: 28px; padding: 0 12px; border-radius: 6px; cursor: pointer; color: var(--ink-2); }
  .tabs button.on { background: var(--paper); color: var(--ink); box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08); font-weight: 500; }
  .layout { display: grid; grid-template-columns: 1fr; gap: 16px; align-items: start; }
  .layout.withside { grid-template-columns: minmax(0, 1fr) 360px; }
  .listbox { overflow: hidden; }
  .bar { display: flex; gap: 10px; padding: 10px; border-bottom: 1px solid var(--line); }
  .search { display: flex; align-items: center; gap: 6px; flex: 1; height: 30px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--mist); color: var(--ink-3); }
  .search input { border: 0; outline: none; background: none; flex: 1; }
  .who { display: flex; gap: 10px; align-items: center; }
  .av { width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-size: 11.5px; font-weight: 600; background: var(--accent-wash); color: var(--accent-ink); flex: none; }
  .av.agent { background: color-mix(in srgb, var(--t-boolean) 18%, transparent); color: var(--t-boolean); }
  .av.big { width: 40px; height: 40px; font-size: 14px; }
  .em { font-weight: 500; }
  .uid { font-size: 11.5px; color: var(--ink-3); }
  .side { position: sticky; top: 16px; padding: 16px; }
  .sh { display: flex; gap: 10px; align-items: center; }
  .sid { flex: 1; min-width: 0; overflow: hidden; }
  dl { display: grid; grid-template-columns: 96px 1fr; gap: 6px 10px; margin: 16px 0; font-size: 13px; }
  dt { color: var(--ink-3); }
  dd { margin: 0; }
  h3 { margin: 18px 0 8px; font-size: 12.5px; color: var(--ink-2); }
  .row { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 8px; }
  .row.wrap { flex-wrap: wrap; justify-content: flex-start; }
  .row .input { flex: 1; }
  .box { padding: 16px 20px; }
  .pad { padding: 12px 16px; margin: 0; }
  .form { display: grid; gap: 12px; }
  .form label { display: grid; gap: 4px; font-size: 12.5px; color: var(--ink-2); }
  .sm { height: 28px; font-size: 12.5px; }
</style>
