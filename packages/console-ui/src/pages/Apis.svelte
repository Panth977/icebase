<script lang="ts">
  // Every API the deployment serves, in a full reference (Scalar): try-it, models, client code.
  import { session } from '../lib/api';
  import { app } from '../lib/state.svelte';
  import Icon from '../components/Icon.svelte';
  const src = $derived(`api-reference.html#d=${encodeURIComponent(app.base)}`);
</script>

<div class="wrap">
  <iframe title="API reference" {src}></iframe>
  <a class="btn tab" href={src} target="_blank" rel="noopener"><Icon name="external" size={14} />Open in a new tab</a>
</div>

<style>
  .wrap { position: relative; height: 100%; }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: var(--paper); }
  .tab { position: absolute; right: 18px; bottom: 18px; box-shadow: var(--shadow-pop); }
</style>
