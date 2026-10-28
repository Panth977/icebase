<script lang="ts">
  import { kindOf, type Kind } from '../lib/values';
  let { value, kind }: { value?: unknown; kind?: Kind } = $props();
  const k = $derived(kind ?? kindOf(value));
</script>

<span class="tmark k-{k}">{k}</span>
