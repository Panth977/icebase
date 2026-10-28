<script lang="ts">
  // Asked for when a deployment refuses the token: one field, kept for this tab only.
  import { auth, session } from '../lib/api';
  import { app } from '../lib/state.svelte';
  let open = $state(false);
  let base = $state('');
  let note = $state('');
  let token = $state('');
  let resolve: ((ok: boolean) => void) | null = null;
  let el: HTMLDialogElement;
  auth.ask = (b, reason) =>
    new Promise<boolean>((r) => {
      if (resolve) return r(false);
      base = b;
      note = reason;
      token = '';
      resolve = r;
      open = true;
      queueMicrotask(() => el?.showModal());
    });
  const name = $derived(base ? (app.targets.find((t) => t.url === base)?.name ?? base) : location.host);
  function done(ok: boolean) {
    if (ok) session.setToken(token.trim(), base);
    open = false;
    el?.close();
    const r = resolve;
    resolve = null;
    r?.(ok);
  }
</script>

<dialog bind:this={el} onclose={() => resolve && done(false)}>
  {#if open}
    <form onsubmit={(e) => { e.preventDefault(); if (token.trim()) done(true); }}>
      <h2>Sign in to {name}</h2>
      <p class="muted">Paste the console token: <code>ICEBASE_CONSOLE_TOKEN</code> from the deployment's environment, or its admin token. It stays in this tab only.</p>
      {#if note}<p class="err">{note}</p>{/if}
      <input class="input" type="password" autocomplete="off" bind:value={token} placeholder="Token" />
      <div class="row"><button type="button" class="btn" onclick={() => done(false)}>Cancel</button><button class="btn primary" disabled={!token.trim()}>Sign in</button></div>
    </form>
  {/if}
</dialog>

<style>
  dialog { width: min(440px, calc(100vw - 32px)); border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--paper); color: var(--ink); padding: 20px; box-shadow: var(--shadow-pop); }
  dialog::backdrop { background: rgba(10, 16, 24, 0.5); }
  h2 { margin: 0 0 6px; font-size: 16px; }
  p { margin: 0 0 12px; font-size: 13px; }
  code { font: 12px var(--mono); }
  .input { width: 100%; height: 36px; }
  .row { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }
</style>
