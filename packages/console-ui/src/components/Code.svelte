<script lang="ts">
  import { tokenize } from '../lib/highlight';
  let { code, lang = 'ts' }: { code: string; lang?: 'ts' | 'json' | 'rules' } = $props();
  const tokens = $derived(tokenize(code, lang));
</script>

<pre class="code-view">{#each tokens as t}{#if t.cls}<span class="tk-{t.cls}">{t.text}</span>{:else}{t.text}{/if}{/each}</pre>
