<script lang="ts">
  import type { Snippet } from 'svelte';
  import Icon from './Icon.svelte';
  let { title, onclose, children, footer, wide = false }: { title: string; onclose: () => void; children: Snippet; footer?: Snippet; wide?: boolean } = $props();
  let el: HTMLDialogElement;
  $effect(() => {
    el.showModal();
  });
</script>

<dialog bind:this={el} class:wide onclose={onclose} onclick={(e) => e.target === el && el.close()}>
  <header><h2>{title}</h2><button class="btn ghost icon" aria-label="Close" onclick={() => el.close()}><Icon name="close" /></button></header>
  <div class="body">{@render children()}</div>
  {#if footer}<footer>{@render footer()}</footer>{/if}
</dialog>

<style>
  dialog { width: min(520px, calc(100vw - 32px)); padding: 0; border: 1px solid var(--line); border-radius: var(--radius-lg); background: var(--paper); color: var(--ink); box-shadow: var(--shadow-pop); }
  dialog.wide { width: min(860px, calc(100vw - 32px)); }
  dialog::backdrop { background: rgba(10, 16, 24, 0.45); }
  header { display: flex; align-items: center; justify-content: space-between; padding: 12px 12px 0 18px; }
  h2 { margin: 0; font-size: 15px; font-weight: 600; }
  .body { padding: 14px 18px; }
  footer { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 18px 16px; }
</style>
