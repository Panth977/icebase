<script lang="ts">
  // Line icons, 16px, drawn for this console (stroke = currentColor).
  let { name, size = 16 }: { name: string; size?: number } = $props();
  const P: Record<string, string> = {
    overview: 'M3 3h4v4H3zM9 3h4v4H9zM3 9h4v4H3zM9 9h4v4H9z',
    api: 'M5 4 2 8l3 4M11 4l3 4-3 4M9.5 2.5l-3 11',
    firestore: 'M8 2 3 4.5v7L8 14l5-2.5v-7zM3 4.5 8 7l5-2.5M8 7v7',
    database: 'M3 4c0-1.1 2.2-2 5-2s5 .9 5 2-2.2 2-5 2-5-.9-5-2zM3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4M3 8c0 1.1 2.2 2 5 2s5-.9 5-2',
    schema: 'M3 3h10v3H3zM3 8h4v5H3zM9 8h4v5H9z',
    index: 'M3 4h10M3 8h7M3 12h4M12 9v5M10 12l2 2 2-2',
    rules: 'M8 2 3 4v4c0 3 2.2 5.2 5 6 2.8-.8 5-3 5-6V4zM6 8l1.5 1.5L10.5 6.5',
    users: 'M6 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM1.5 14c.5-2.5 2.3-4 4.5-4s4 1.5 4.5 4M11 3a2.3 2.3 0 0 1 0 4.5M12 10c1.4.4 2.3 1.8 2.5 4',
    storage: 'M2 5h12v8H2zM2 5l1.5-2.5h9L14 5M6 8h4',
    functions: 'M6 2.5C4.5 2.5 4.5 4 4.5 5.5S4 8 3 8c1 0 1.5.9 1.5 2.5s0 3 1.5 3M10 2.5c1.5 0 1.5 1.5 1.5 3S12 8 13 8c-1 0-1.5.9-1.5 2.5s0 3-1.5 3',
    hosting: 'M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12zM2 8h12M8 2c1.6 1.7 2.4 3.7 2.4 6S9.6 12.3 8 14M8 2C6.4 3.7 5.6 5.7 5.6 8s.8 4.3 2.4 6',
    chevron: 'M6 4l4 4-4 4',
    down: 'M4 6l4 4 4-4',
    plus: 'M8 3v10M3 8h10',
    trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9',
    edit: 'M10.5 2.5l3 3L6 13H3v-3z',
    refresh: 'M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3',
    search: 'M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10zM10.5 10.5 14 14',
    close: 'M4 4l8 8M12 4l-8 8',
    copy: 'M5.5 5.5h7v8h-7zM3.5 10.5v-8h7',
    play: 'M5 3l8 5-8 5z',
    key: 'M10 2.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zM7.5 8.5 2.5 13.5M4.5 11.5l1.5 1.5',
    file: 'M4 2h5l3 3v9H4zM9 2v3h3',
    folder: 'M2 4h4.5L8 5.5h6V13H2z',
    upload: 'M8 11V3M5 6l3-3 3 3M3 13h10',
    download: 'M8 3v8M5 8l3 3 3-3M3 13h10',
    filter: 'M2.5 3.5h11L9.5 8.5v4l-3 1.5V8.5z',
    external: 'M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5',
    signout: 'M10 4V2.5H3v11h7V12M7 8h7M12 6l2 2-2 2',
    sun: 'M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1',
    dot: 'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  };
</script>

<svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={P[name] ?? P.dot} /></svg>
