<script lang="ts">
  import type { Snippet } from 'svelte';
  let { title, sub, actions }: { title: string; sub?: string; actions?: Snippet } = $props();
</script>

<div class="head">
  <div><h1>{title}</h1>{#if sub}<p>{sub}</p>{/if}</div>
  {#if actions}<div class="acts">{@render actions()}</div>{/if}
</div>

<style>
  .head { display: flex; align-items: flex-end; justify-content: space-between; gap: 16px; margin: 0 0 18px; }
  h1 { margin: 0; font-size: 22px; font-weight: 650; letter-spacing: -0.01em; }
  p { margin: 4px 0 0; color: var(--ink-3); max-width: 70ch; }
  .acts { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
</style>
