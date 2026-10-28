// The IceBase console's page. The app itself is the Svelte build of packages/console-ui, embedded
// as ui.gen.ts (`npm run build -w @icebase/console-ui` writes it). Project data is only ever put
// into the page as text.

export { UI_CSS as CONSOLE_CSS, UI_JS as CONSOLE_JS } from './ui.gen.ts';

export const CONSOLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IceBase console</title>
<link rel="stylesheet" href="app.css">
</head><body>
<div id="app"></div>
<script type="module" data-cfasync="false" src="app.js"></script>
</body></html>`;

/** Scalar's API reference, pinned (the console's CSP lets in this one file, checked by its hash). */
export const SCALAR = {
  src: 'https://cdn.jsdelivr.net/npm/@scalar/api-reference@1.76.0/dist/browser/standalone.js',
  integrity: 'sha384-oH1C0RwqcwbVXkC+r8A+4qRoyEUQdtxAzOwumkxZtQBBcsy61FOoPt7B50OVJYYQ',
};

export const REFERENCE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>API reference · IceBase console</title>
</head><body style="margin:0">
<div id="app"></div>
<script data-cfasync="false" src="${SCALAR.src}" integrity="${SCALAR.integrity}" crossorigin="anonymous"></script>
<script type="module" data-cfasync="false" src="api-reference.js"></script>
</body></html>`;

export const REFERENCE_JS = `'use strict';
// The API reference (Scalar): every OpenAPI document of the deployment the console is on.
const token = sessionStorage.getItem('icebase-console-token') || '';
const app = document.getElementById('app');
const say = (t) => { app.textContent = t; app.style.cssText = 'padding:24px;font:14px system-ui;color:#b91c1c'; };
try {
  const res = await fetch('api/apis', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: '{}' });
  const r = await res.json();
  if (!res.ok || r.error) throw new Error((r.error && r.error.message) || 'HTTP ' + res.status);
  const sources = r.openapi.filter((d) => d.doc && !d.error).map((d, i) => ({ title: d.title, slug: 'doc-' + i, content: d.doc, default: i === 0 }));
  const failed = r.openapi.filter((d) => d.error).map((d) => d.title + ': ' + d.error);
  if (!sources.length) say('No OpenAPI document could be read. ' + failed.join(' · '));
  else {
    if (failed.length) console.warn('API reference: ' + failed.join(' · '));
    window.Scalar.createApiReference('#app', { sources, withDefaultFonts: false, darkMode: matchMedia('(prefers-color-scheme: dark)').matches, hideDarkModeToggle: false, showSidebar: true, defaultOpenAllTags: false, persistAuth: false, telemetry: false, hideClientButton: false });
  }
} catch (e) {
  say('Could not load the API documents: ' + e.message + ' (open the console first: it holds the token).');
}
`;
