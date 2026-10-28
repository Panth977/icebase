<script lang="ts">
  import Icon from './Icon.svelte';
  import type { Snippet } from 'svelte';
  let { icon = 'dot', title, children }: { icon?: string; title: string; children?: Snippet } = $props();
</script>

<div class="empty">
  <span class="ico"><Icon name={icon} size={20} /></span>
  <p class="t">{title}</p>
  {#if children}<div class="b">{@render children()}</div>{/if}
</div>

<style>
  .empty { display: grid; justify-items: center; gap: 6px; padding: 40px 20px; text-align: center; color: var(--ink-3); }
  .ico { width: 40px; height: 40px; display: grid; place-items: center; border-radius: 50%; background: var(--line-2); color: var(--ink-2); }
  .t { margin: 6px 0 0; color: var(--ink-2); font-weight: 500; }
  .b { max-width: 46ch; font-size: 13px; }
</style>
