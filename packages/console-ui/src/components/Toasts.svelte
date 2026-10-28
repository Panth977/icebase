<script lang="ts" module>
  // Short confirmations and failures, bottom right.
  type T = { id: number; text: string; bad: boolean };
  let list = $state<T[]>([]);
  let n = 0;
  export function toast(text: string, bad = false) {
    const id = ++n;
    list.push({ id, text, bad });
    setTimeout(() => (list = list.filter((t) => t.id !== id)), bad ? 7000 : 3000);
  }
</script>

<div class="toasts" role="status" aria-live="polite">
  {#each list as t (t.id)}
    <div class="toast" class:bad={t.bad}>{t.text}</div>
  {/each}
</div>

<style>
  .toasts { position: fixed; right: 18px; bottom: 18px; display: grid; gap: 8px; z-index: 50; }
  .toast { max-width: 420px; padding: 10px 14px; border-radius: var(--radius); background: var(--ink); color: var(--paper); box-shadow: var(--shadow-pop); font-size: 13px; }
  .toast.bad { background: var(--danger); color: #fff; }
</style>
