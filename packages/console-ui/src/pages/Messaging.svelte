<script lang="ts">
  import { api } from '../lib/api';
  import Icon from '../components/Icon.svelte';
  import PageHead from '../components/PageHead.svelte';
  import Code from '../components/Code.svelte';
  import { toast } from '../components/Toasts.svelte';
  type Kind = { kind: string; fields: { name: string; type: string; optional: boolean }[] };
  type Out = { name: string; at: number; message: Record<string, any>; targets: number; delivered: number };
  type State = { server: boolean; kinds: Kind[]; messages: Out[]; topics: { topic: string; subscribers: number }[]; tokens: { token: string; uid: string | null; at: number; topics: string[]; listening: boolean }[] };
  let st = $state<State | null>(null);
  let err = $state('');
  let to = $state('');
  let title = $state('');
  let body = $state('');
  let kind = $state('');
  let data = $state('{}');
  let open = $state<string | null>(null);
  const load = () => api<State>('fcm.state').then((r) => (st = r)).catch((e) => (err = e.message));
  load();
  const target = (m: Record<string, any>) => (m.token ? `token ${String(m.token).slice(0, 18)}…` : m.topic ? `topic ${m.topic}` : `condition ${m.condition}`);
  async function send(e: Event) {
    e.preventDefault();
    try {
      const t = to.trim();
      const r = await api<{ name: string }>('fcm.send', { ...(t.startsWith('ib-fcm:') || t.length > 60 ? { token: t } : { topic: t }), title, body, ...(kind ? { kind, data: JSON.parse(data || '{}') } : {}) });
      toast(`Sent ${r.name.split('/').pop()}`);
      await load();
    } catch (x) {
      toast((x as Error).message, true);
    }
  }
</script>

<div class="page">
  <PageHead title="Cloud Messaging" sub="Message kinds as declared, what was sent and to whom. On the IceBase server, messages go to apps listening with onMessage.">
    {#snippet actions()}<button class="btn" onclick={load}><Icon name="refresh" size={13} />Refresh</button>{/snippet}
  </PageHead>
  {#if err}<p class="err">{err}</p>
  {:else if !st}<p class="muted">Loading…</p>
  {:else}
    <div class="cols">
      <form class="surface box" onsubmit={send}>
        <h2>Send a message</h2>
        <label>To <input class="input mono" placeholder="a token (ib-fcm:…) or a topic" bind:value={to} /></label>
        <div class="two"><label>Title <input class="input" bind:value={title} /></label><label>Body <input class="input" bind:value={body} /></label></div>
        {#if st.kinds.length}
          <label>Kind <select class="select" bind:value={kind}><option value="">(notification only)</option>{#each st.kinds as k}<option>{k.kind}</option>{/each}</select></label>
          {#if kind}<label>Data <textarea class="input mono" rows="3" bind:value={data}></textarea></label>
            <p class="muted small">{st.kinds.find((k) => k.kind === kind)?.fields.map((f) => `${f.name}${f.optional ? '?' : ''}: ${f.type}`).join(' · ')}</p>{/if}
        {/if}
        <button class="btn primary sm" disabled={!to.trim()}>Send</button>
      </form>
      <section class="surface">
        <h2>Message kinds <span>{st.kinds.length}</span></h2>
        {#if !st.kinds.length}<p class="muted pad">None declared (config.messaging.messages): data is untyped.</p>
        {:else}{#each st.kinds as k}<div class="row"><span class="mono name">{k.kind}</span><span class="muted mono small">{k.fields.map((f) => `${f.name}${f.optional ? '?' : ''}: ${f.type}`).join(', ')}</span></div>{/each}{/if}
      </section>
    </div>
    {#if !st.server}
      <p class="muted">The outbox, topics and tokens are the IceBase server's; on Firebase, see the Firebase console.</p>
    {:else}
      <section class="surface gap">
        <h2>Outbox <span>{st.messages.length}</span></h2>
        {#if !st.messages.length}<p class="muted pad">Nothing sent yet.</p>
        {:else}
          <table class="grid"><thead><tr><th>Sent</th><th>To</th><th>Kind / title</th><th>Delivered</th></tr></thead>
            <tbody>{#each [...st.messages].reverse() as m}
              <tr class="click" onclick={() => (open = open === m.name ? null : m.name)}><td class="muted">{new Date(m.at).toLocaleString()}</td><td class="mono small">{target(m.message)}</td><td>{m.message.data?.icebaseKind ?? m.message.notification?.title ?? ''}</td><td>{m.delivered} / {m.targets}</td></tr>
              {#if open === m.name}<tr><td colspan="4"><Code code={JSON.stringify(m.message, null, 2)} lang="json" /></td></tr>{/if}
            {/each}</tbody>
          </table>
        {/if}
      </section>
      <div class="cols gap">
        <section class="surface"><h2>Topics <span>{st.topics.length}</span></h2>
          {#if !st.topics.length}<p class="muted pad">No subscriptions.</p>{:else}{#each st.topics as t}<div class="row"><span class="mono name">{t.topic}</span><span class="muted">{t.subscribers} subscriber{t.subscribers === 1 ? '' : 's'}</span></div>{/each}{/if}
        </section>
        <section class="surface"><h2>Registration tokens <span>{st.tokens.length}</span></h2>
          {#if !st.tokens.length}<p class="muted pad">No app has asked for a token.</p>{:else}{#each st.tokens as t}<div class="row"><span class="mono small tok" title={t.token}>{t.token}</span><span class="muted small">{t.uid ?? 'signed out'}{t.topics.length ? ` · ${t.topics.join(', ')}` : ''}</span>{#if t.listening}<span class="pill accent">listening</span>{/if}</div>{/each}{/if}
        </section>
      </div>
    {/if}
  {/if}
</div>

<style>
  .page { padding: 24px 28px 40px; max-width: 1200px; }
  section { overflow: hidden; }
  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
  .gap { margin-top: 16px; }
  .box { padding: 14px 16px; display: grid; gap: 10px; }
  .box h2 { padding: 0; border: 0; }
  label { display: grid; gap: 4px; font-size: 12.5px; color: var(--ink-2); }
  .two { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
  h2 { margin: 0; padding: 11px 16px; font-size: 13.5px; border-bottom: 1px solid var(--line); }
  h2 span { color: var(--ink-3); font-weight: 400; margin-left: 4px; }
  .row { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-bottom: 1px solid var(--line-2); min-height: 38px; }
  .row:last-child { border-bottom: 0; }
  .name { font-weight: 500; }
  .small { font-size: 12px; }
  .tok { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pad { padding: 12px 16px; margin: 0; }
  .click { cursor: pointer; }
  .sm { height: 30px; font-size: 12.5px; justify-self: start; }
  @media (max-width: 900px) { .cols, .two { grid-template-columns: 1fr; } }
</style>
