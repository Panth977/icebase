// The IceBase console's page and script: plain DOM, no framework, no build step. Data from the
// project is only ever put into the page as text (never as HTML).

export const CONSOLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IceBase console</title>
<style>
:root{--bg:#f7f7f5;--panel:#fff;--line:#e4e4e0;--ink:#1c1c1a;--mute:#6b6b66;--acc:#2563eb;--bad:#b91c1c;--ok:#15803d;font:14px/1.45 system-ui,-apple-system,sans-serif;color:var(--ink);background:var(--bg)}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--panel:#1f1f1d;--line:#33332f;--ink:#ecece8;--mute:#9a9a94;--acc:#60a5fa;--bad:#f87171;--ok:#4ade80}}
*{box-sizing:border-box}body{margin:0;display:grid;grid-template-columns:210px 1fr;min-height:100vh}
nav{border-right:1px solid var(--line);padding:14px 10px;background:var(--panel)}nav h1{font-size:15px;margin:2px 8px 14px}nav h1 small{display:block;color:var(--mute);font-weight:400;font-size:12px}
nav a{display:block;padding:6px 10px;border-radius:6px;color:var(--ink);text-decoration:none}nav a.on{background:var(--bg);font-weight:600}
main{padding:20px 24px;min-width:0}h2{font-size:18px;margin:0 0 14px}h3{font-size:14px;margin:18px 0 8px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:12px}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}th{color:var(--mute);font-weight:500;font-size:12px}
.cols{display:grid;grid-template-columns:220px 260px 1fr;gap:12px}.list{max-height:70vh;overflow:auto}.list div{padding:5px 8px;border-radius:5px;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.list div:hover,.list div.on{background:var(--bg)}
textarea,input,select{font:12.5px ui-monospace,Menlo,monospace;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px 8px}textarea{width:100%;min-height:320px}
button{font:inherit;border:1px solid var(--line);background:var(--panel);color:var(--ink);border-radius:6px;padding:5px 10px;cursor:pointer;margin:2px 4px 2px 0}button.p{background:var(--acc);border-color:var(--acc);color:#fff}button.d{color:var(--bad)}
.badge{display:inline-block;font-size:11.5px;border:1px solid var(--line);border-radius:10px;padding:1px 8px;margin:0 4px 4px 0}.firebase{color:#c2410c}.emulator{color:var(--acc)}
.err{color:var(--bad);white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace;font-size:12.5px}.ok{color:var(--ok)}.mute{color:var(--mute)}pre{white-space:pre-wrap;font-size:12.5px;margin:0}
.row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 0}
</style></head><body>
<nav><h1>IceBase<small id="proj">…</small></h1><div id="nav"></div></nav>
<main id="main"></main>
<script type="module" data-cfasync="false" src="app.js"></script>
</body></html>`;

export const CONSOLE_JS = `'use strict';
const $ = (t, a = {}, ...kids) => { const e = document.createElement(t); for (const [k, v] of Object.entries(a)) { if (k === 'on') for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn); else if (k === 'class') e.className = v; else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? '' : v); } for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k instanceof Node ? k : String(k)); return e; };
const main = document.getElementById('main');
// The deployment this page acts on: '' is the one serving it; others come from config.console.targets.
let base = sessionStorage.getItem('icebase-console-base') || '';
const tokenKey = () => 'icebase-console-token:' + base;
const fromHash = new URLSearchParams(location.hash.slice(1)).get('token');
if (fromHash) { sessionStorage.setItem(tokenKey(), fromHash); history.replaceState(null, '', location.pathname); }
async function api(op, body = {}) {
  const r = await fetch((base ? base.replace(/\\/?$/, '/') : '') + 'api/' + op, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (sessionStorage.getItem(tokenKey()) || 'owner') }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 || r.status === 403) { const t = prompt('Admin token for ' + (base || location.host) + ' (ICEBASE_ADMIN_TOKEN, or the admin-token file in the data directory):'); if (t) { sessionStorage.setItem(tokenKey(), t); return api(op, body); } }
  if (!r.ok || j.error) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return j;
}
const err = (e) => $('div', { class: 'err' }, e.message || String(e));
const json = (v) => JSON.stringify(v, null, 2);
const set = (el, ...kids) => { el.replaceChildren(...kids.flat(Infinity).filter((k) => k !== null && k !== undefined && k !== false)); return el; };
async function guard(el, fn) { try { await fn(); } catch (e) { el.append(err(e)); } }

const pages = {
  async overview() {
    const o = await api('overview');
    document.getElementById('proj').textContent = o.name + ' · ' + o.env;
    return [$('h2', {}, 'Project'),
      $('div', { class: 'card' }, $('table', {}, $('tr', {}, $('th', {}, 'Project'), $('td', {}, o.projectId || '—')), $('tr', {}, $('th', {}, 'Environment'), $('td', {}, o.env, ' ', $('span', { class: 'mute' }, '(' + o.environments.join(', ') + ')'))), $('tr', {}, $('th', {}, 'Declared'), $('td', {}, o.counts.collections + ' collections · ' + o.counts.paths + ' database paths · ' + o.counts.files + ' file paths · ' + o.counts.endpoints + ' endpoints')))),
      $('h3', {}, 'Mode per service'), $('div', { class: 'card' }, Object.entries(o.modes).map(([s, m]) => $('span', { class: 'badge ' + m }, s + ': ' + m))),
      o.health ? [$('h3', {}, 'Health'), $('div', { class: 'card' }, $('pre', {}, json(o.health)))] : null,
      o.customAuth ? [$('h3', {}, 'Custom auth'), $('div', { class: 'card' }, 'email: ' + (o.customAuth.email || '—') + ' · phone: ' + (o.customAuth.phone || '—') + ' · Google: ' + (o.customAuth.google ? 'your OAuth client' : '—'))] : null,
      o.secrets.length ? [$('h3', {}, 'Secrets (env-var names)'), $('div', { class: 'card' }, o.secrets.map((s) => $('div', {}, s.name, ' ', $('span', { class: s.set ? 'ok' : 'err' }, s.set ? 'set' : 'not set'))))] : null,
      o.problems.length ? [$('h3', {}, 'Problems'), $('div', { class: 'card err' }, o.problems.join('\\n'))] : null];
  },

  async firestore() {
    const cols = $('div', { class: 'list' }), docs = $('div', { class: 'list' }), doc = $('div'), crumbs = $('div', { class: 'mute' });
    let colPath = '', last = null;
    const openDoc = async (path) => {
      set(doc, $('div', { class: 'mute' }, 'loading…'));
      const d = await api('fs.get', { path });
      const ta = $('textarea', {}, json(d.data || {}));
      const sub = await api('fs.collections', { path }).catch(() => ({ ids: [] }));
      const status = $('div');
      set(doc, $('div', { class: 'row' }, $('b', {}, path)), ta,
        $('div', { class: 'row' }, $('button', { class: 'p', on: { click: () => guard(status, async () => { await api('fs.set', { path, data: JSON.parse(ta.value) }); set(status, $('span', { class: 'ok' }, 'saved')); }) } }, 'Save'),
          $('button', { class: 'd', on: { click: () => confirm('Delete ' + path + '?') && guard(status, async () => { await api('fs.delete', { path }); loadDocs(colPath); set(doc); }) } }, 'Delete')),
        status, sub.ids.length ? [$('h3', {}, 'Subcollections'), sub.ids.map((id) => $('div', {}, $('a', { href: '#', on: { click: (e) => { e.preventDefault(); loadDocs(path + '/' + id); } } }, id)))] : null,
        $('p', { class: 'mute' }, 'Timestamps are {"__ts": ISO}, references {"__ref": path}. Writes go through the schema.'));
    };
    const loadDocs = async (path, after) => {
      colPath = path; crumbs.textContent = path;
      if (!after) set(docs);
      const r = await api('fs.list', { path, after, limit: 50 });
      for (const d of r.docs) docs.append($('div', { on: { click: () => openDoc(d.path) } }, d.id));
      docs.querySelector('.more')?.remove();
      if (r.docs.length === 50) docs.append($('div', { class: 'more mute', on: { click: () => loadDocs(path, r.docs[49].id) } }, 'more…'));
      const id = $('input', { placeholder: 'new document id' });
      docs.append($('div', { class: 'row' }, id, $('button', { on: { click: () => id.value && openDoc(path + '/' + id.value) } }, 'Add')));
    };
    const r = await api('fs.collections', {});
    const schema = await api('schema');
    const ids = new Set([...r.ids, ...schema.collections.filter((c) => !c.params.length).map((c) => c.id)]);
    for (const id of [...ids].sort()) cols.append($('div', { on: { click: () => loadDocs(id) } }, id));
    return [$('h2', {}, 'Firestore'), crumbs, $('div', { class: 'cols' }, $('div', { class: 'card' }, $('b', {}, 'Collections'), cols), $('div', { class: 'card' }, $('b', {}, 'Documents'), docs), $('div', { class: 'card' }, doc))];
  },

  async query() {
    const schema = await api('schema');
    const coll = $('select', {}, schema.collections.map((c) => $('option', { value: c.path }, c.path)));
    const path = $('input', { placeholder: 'collection path, e.g. users/u1/orders', size: 34 });
    const group = $('input', { type: 'checkbox' });
    const filters = $('textarea', { style: 'min-height:90px' }, '[\\n  { "field": "category", "op": "==", "value": "shoes" }\\n]');
    const orders = $('textarea', { style: 'min-height:60px' }, '[]');
    const out = $('div');
    const run = () => guard(out, async () => {
      set(out, $('div', { class: 'mute' }, 'running…'));
      const c = schema.collections.find((x) => x.path === coll.value);
      const p = group.checked ? c.id : (path.value || c.path);
      const r = await api('fs.query', { path: p, group: group.checked, filters: JSON.parse(filters.value), orders: JSON.parse(orders.value), limit: 50 });
      set(out, $('div', { class: 'mute' }, r.docs.length + ' documents'), $('table', {}, r.docs.map((d) => $('tr', {}, $('td', {}, d.path), $('td', {}, $('pre', {}, json(d.data)))))));
    });
    coll.addEventListener('change', () => { const c = schema.collections.find((x) => x.path === coll.value); path.value = c.params.length ? '' : c.path; hint(); });
    const idx = $('div', { class: 'mute' });
    const hint = () => { const c = schema.collections.find((x) => x.path === coll.value); set(idx, 'Declared indexes: ', c.indexes.map((i) => $('span', { class: 'badge' }, i.code)), c.indexes.length ? '' : 'none'); };
    hint();
    return [$('h2', {}, 'Query runner'), $('p', { class: 'mute' }, 'Only what the declared indexes allow: a query IceBase would refuse in the app is refused here, with the index to add.'),
      $('div', { class: 'card' }, $('div', { class: 'row' }, coll, path, $('label', {}, group, ' collection group')), idx, $('h3', {}, 'where (JSON)'), filters, $('h3', {}, 'orderBy (JSON: [{"field":"x","dir":"desc"}])'), orders, $('div', { class: 'row' }, $('button', { class: 'p', on: { click: run } }, 'Run'))), out];
  },

  async schema() {
    const s = await api('schema');
    return [$('h2', {}, 'Schema'), s.collections.map((c) => $('div', { class: 'card' }, $('b', {}, c.path), c.group ? $('span', { class: 'badge' }, 'group') : null, c.ttl ? $('span', { class: 'badge' }, 'ttl ' + c.ttl) : null,
      $('table', {}, $('tr', {}, $('th', {}, 'Field'), $('th', {}, 'Type'), $('th', {}, '')), c.fields.map((f) => $('tr', {}, $('td', {}, f.name), $('td', {}, f.type), $('td', { class: 'mute' }, f.optional ? 'optional' : '')))),
      $('div', { class: 'row' }, c.indexes.map((i) => $('span', { class: 'badge' }, i.code))))),
      s.paths.length ? [$('h3', {}, 'Realtime Database paths'), s.paths.map((p) => $('div', { class: 'card' }, $('b', {}, p.path), ' ', $('span', { class: 'mute' }, p.value.type), p.indexOn.length ? $('span', { class: 'badge' }, '.indexOn ' + p.indexOn.join(', ')) : null))] : null,
      s.files.length ? [$('h3', {}, 'Storage paths'), s.files.map((f) => $('div', { class: 'card' }, $('b', {}, f.path), ' ', $('span', { class: 'mute' }, (f.contentTypes.join(', ') || 'any type') + (f.maxBytes ? ' · max ' + f.maxBytes + ' bytes' : ''))))] : null];
  },

  async indexes() {
    const r = await api('fs.indexes');
    const built = Array.isArray(r.built) ? r.built : r.built && r.built.databases ? r.built.databases.flatMap((d) => d.sqlIndexes.map((x) => ({ database: d.id, index: x }))) : r.built;
    return [$('h2', {}, 'Indexes'), $('h3', {}, 'Declared composites (firestore.indexes.json)'),
      $('div', { class: 'card' }, $('table', {}, r.declared.indexes.map((i) => $('tr', {}, $('td', {}, i.collectionGroup), $('td', { class: 'mute' }, i.queryScope), $('td', {}, i.fields.map((f) => f.fieldPath + ' ' + (f.order || f.arrayConfig).toLowerCase()).join(', ')))))),
      $('h3', {}, 'As built'), $('div', { class: 'card' }, Array.isArray(built) ? $('table', {}, built.map((b) => $('tr', {}, Object.values(b).map((v) => $('td', {}, String(v)))))) : $('pre', {}, json(built)))];
  },

  async database() {
    const tree = $('div'), edit = $('div');
    const node = (path, label, depth) => {
      const kids = $('div', { style: 'margin-left:14px' });
      let open = false;
      const head = $('div', { class: 'row', style: 'margin:0' }, $('a', { href: '#', on: { click: async (e) => { e.preventDefault(); open = !open; if (!open) return set(kids); const r = await api('db.get', { path, shallow: true }); set(kids, (r.children || []).map((c) => c.size !== undefined ? node(path ? path + '/' + c.key : c.key, c.key + ' (' + c.size + ')', depth + 1) : $('div', {}, $('a', { href: '#', on: { click: (ev) => { ev.preventDefault(); select(path ? path + '/' + c.key : c.key); } } }, c.key), ': ', $('span', { class: 'mute' }, JSON.stringify(c.value))))); } } }, label), ' ', $('a', { href: '#', class: 'mute', on: { click: (e) => { e.preventDefault(); select(path); } } }, 'edit'));
      return $('div', {}, head, kids);
    };
    const select = async (path) => {
      const r = await api('db.get', { path });
      const ta = $('textarea', {}, json(r.value));
      const st = $('div');
      set(edit, $('b', {}, '/' + path), ta, $('div', { class: 'row' }, $('button', { class: 'p', on: { click: () => guard(st, async () => { await api('db.set', { path, value: JSON.parse(ta.value) }); set(st, $('span', { class: 'ok' }, 'saved')); }) } }, 'Set'), $('button', { class: 'd', on: { click: () => confirm('Remove /' + path + '?') && guard(st, async () => { await api('db.set', { path, value: null }); set(st, $('span', { class: 'ok' }, 'removed')); }) } }, 'Remove')), st);
    };
    tree.append(node('', '/ (root)', 0));
    return [$('h2', {}, 'Realtime Database'), $('div', { class: 'cols', style: 'grid-template-columns:1fr 1fr' }, $('div', { class: 'card list' }, tree), $('div', { class: 'card' }, edit))];
  },

  async auth() {
    const q = $('input', { placeholder: 'email, +phone or uid' });
    const rows = $('tbody'), more = $('div'), st = $('div');
    let next = null;
    const row = (u) => $('tr', {}, $('td', {}, u.email || u.phone || '—', $('div', { class: 'mute' }, u.uid)), $('td', {}, u.providers.join(', ')), $('td', {}, $('pre', {}, Object.keys(u.claims).length ? json(u.claims) : '')), $('td', {}, u.disabled ? $('span', { class: 'err' }, 'disabled') : 'active'),
      $('td', {}, $('button', { on: { click: () => guard(st, async () => { await api('auth.update', { uid: u.uid, disabled: !u.disabled }); load(); }) } }, u.disabled ? 'Enable' : 'Disable'),
        $('button', { on: { click: () => { const c = prompt('Custom claims (JSON)', json(u.claims)); if (c !== null) guard(st, async () => { await api('auth.update', { uid: u.uid, claims: JSON.parse(c || '{}') }); load(); }); } } }, 'Claims'),
        $('button', { on: { click: () => guard(st, async () => { await api('auth.update', { uid: u.uid, revoke: true }); set(st, $('span', { class: 'ok' }, 'sessions revoked')); }) } }, 'Revoke'),
        $('button', { class: 'd', on: { click: () => confirm('Delete ' + (u.email || u.uid) + '?') && guard(st, async () => { await api('auth.delete', { uid: u.uid }); load(); }) } }, 'Delete')));
    const load = async (append) => { const r = await api('auth.list', { q: q.value, next: append ? next : undefined }); if (!append) set(rows); r.users.forEach((u) => rows.append(row(u))); next = r.next; set(more, next ? $('button', { on: { click: () => load(true) } }, 'More') : ''); };
    await load();
    const email = $('input', { placeholder: 'email' }), pw = $('input', { placeholder: 'password', type: 'password' });
    const cfg = $('pre', {}, json(await api('auth.config').catch((e) => ({ error: e.message }))));
    const ident = $('input', { placeholder: 'email or phone (custom auth)' }), sec = $('div');
    const secLoad = () => guard(sec, async () => { const a = await api('auth.attempts', { identifier: ident.value }); set(sec, $('pre', {}, json(a)), $('button', { on: { click: () => guard(sec, async () => { await api('auth.unblock', { identifier: ident.value }); secLoad(); }) } }, 'Unblock'), $('button', { on: { click: () => guard(sec, async () => { await api('auth.resetLimits', { identifier: ident.value }); secLoad(); }) } }, 'Reset limits')); });
    return [$('h2', {}, 'Authentication'), $('div', { class: 'row' }, q, $('button', { on: { click: () => load() } }, 'Search')), st,
      $('div', { class: 'card' }, $('table', {}, $('thead', {}, $('tr', {}, ['User', 'Providers', 'Claims', 'State', ''].map((h) => $('th', {}, h)))), rows), more),
      $('h3', {}, 'Add a user'), $('div', { class: 'row' }, email, pw, $('button', { on: { click: () => guard(st, async () => { await api('auth.create', { email: email.value, password: pw.value }); load(); }) } }, 'Create')),
      $('h3', {}, 'Sign-in methods'), $('div', { class: 'card' }, cfg),
      $('h3', {}, 'Security (custom auth)'), $('div', { class: 'card' }, $('div', { class: 'row' }, ident, $('button', { on: { click: secLoad } }, 'Look up')), sec)];
  },

  async storage() {
    const b = await api('st.buckets');
    const bucket = $('select', {}, b.buckets.map((x) => $('option', { value: x }, x)));
    const list = $('div'), view = $('div'), crumbs = $('div', { class: 'row' });
    let prefix = '';
    const load = async (p) => {
      prefix = p;
      set(crumbs, $('a', { href: '#', on: { click: (e) => { e.preventDefault(); load(''); } } }, bucket.value), p.split('/').filter(Boolean).map((s, i, a) => ['/', $('a', { href: '#', on: { click: (e) => { e.preventDefault(); load(a.slice(0, i + 1).join('/') + '/'); } } }, s)]));
      const r = await api('st.list', { bucket: bucket.value, prefix: p });
      set(list, $('table', {}, r.folders.map((f) => $('tr', {}, $('td', {}, $('a', { href: '#', on: { click: (e) => { e.preventDefault(); load(f); } } }, f.slice(p.length))), $('td', { class: 'mute' }, 'folder'), $('td'))),
        r.files.map((f) => $('tr', {}, $('td', {}, $('a', { href: '#', on: { click: (e) => { e.preventDefault(); open(f.name); } } }, f.name.slice(p.length))), $('td', { class: 'mute' }, f.contentType || ''), $('td', { class: 'mute' }, f.size + ' B')))));
    };
    const open = (name) => guard(view, async () => {
      const f = await api('st.read', { bucket: bucket.value, name });
      const url = 'data:' + f.contentType + ';base64,' + f.base64;
      const preview = f.contentType.startsWith('image/') ? $('img', { src: url, style: 'max-width:100%;max-height:360px' }) : f.contentType.startsWith('text/') || f.contentType.includes('json') ? $('pre', {}, atob(f.base64).slice(0, 20000)) : null;
      set(view, $('b', {}, name), $('div', { class: 'mute' }, f.contentType + ' · ' + f.size + ' bytes'), preview, $('div', { class: 'row' }, $('a', { href: url, download: name.split('/').pop() }, 'Download'), $('button', { class: 'd', on: { click: () => confirm('Delete ' + name + '?') && guard(view, async () => { await api('st.delete', { bucket: bucket.value, name }); set(view); load(prefix); }) } }, 'Delete')));
    });
    const file = $('input', { type: 'file' });
    file.addEventListener('change', () => guard(view, async () => { const f = file.files[0]; if (!f) return; const b64 = await new Promise((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.readAsDataURL(f); }); await api('st.upload', { bucket: bucket.value, name: prefix + f.name, contentType: f.type || 'application/octet-stream', base64: b64 }); load(prefix); }));
    bucket.addEventListener('change', () => load(''));
    await load('');
    return [$('h2', {}, 'Storage'), $('div', { class: 'row' }, bucket, $('label', {}, 'Upload here: ', file)), crumbs, $('div', { class: 'cols', style: 'grid-template-columns:1fr 1fr' }, $('div', { class: 'card' }, list), $('div', { class: 'card' }, view))];
  },

  async functions() {
    const r = await api('fn.list');
    const st = $('div');
    const t = await api('fn.tasks').catch(() => ({ tasks: [] }));
    return [$('h2', {}, 'Functions'), st, $('div', { class: 'card' }, $('table', {}, $('tr', {}, ['Name', 'Kind', 'Trigger', ''].map((h) => $('th', {}, h))), r.functions.map((f) => $('tr', {}, $('td', {}, f.name), $('td', {}, f.kind), $('td', { class: 'mute' }, f.trigger || ''), $('td', {}, f.kind === 'schedule' ? $('button', { on: { click: () => guard(st, async () => { const x = await api('fn.run', { name: f.name }); set(st, $('span', { class: 'ok' }, f.name + ' ran in ' + x.ms + ' ms')); }) } }, 'Run now') : ''))))),
      $('h3', {}, 'Task queue'), $('div', { class: 'card' }, t.tasks.length ? $('table', {}, t.tasks.map((x) => $('tr', {}, $('td', {}, x.fn), $('td', { class: 'mute' }, new Date(x.run_at).toISOString()), $('td', {}, 'attempts ' + x.attempts)))) : $('span', { class: 'mute' }, 'empty'))];
  },

  async hosting() {
    const r = await api('hosting.sites');
    const out = $('div'), site = $('input', { placeholder: 'new site id' }), domain = $('input', { placeholder: 'docs.example.com' }), forSite = $('select', {}, r.sites.map((s) => $('option', { value: s.name.split('/').pop() }, s.name.split('/').pop())));
    return [$('h2', {}, 'Hosting'), $('div', { class: 'card' }, $('table', {}, r.sites.map((s) => $('tr', {}, $('td', {}, s.name.split('/').pop()), $('td', { class: 'mute' }, s.defaultUrl))))),
      $('div', { class: 'row' }, site, $('button', { on: { click: () => guard(out, async () => { set(out, $('pre', {}, json(await api('hosting.createSite', { siteId: site.value })))); }) } }, 'Create site')),
      $('div', { class: 'row' }, domain, forSite, $('button', { on: { click: () => guard(out, async () => { set(out, $('pre', {}, json(await api('hosting.setDNS', { domain: domain.value, site: forSite.value })))); }) } }, 'Connect domain')), out,
      $('p', { class: 'mute' }, 'Deploy a release with icebase deploy, or manageHosting(app).deploy().')];
  },

  async apis() {
    const r = await api('apis');
    const method = (m) => $('span', { class: 'badge' }, m.toUpperCase());
    const docs = r.openapi.map((d) => {
      if (d.error) return $('div', { class: 'card' }, $('b', {}, d.title), ' ', $('span', { class: 'err' }, d.error));
      const rows = [];
      for (const [p, ops] of Object.entries(d.doc.paths || {})) for (const [m, op] of Object.entries(ops)) {
        if (!op || typeof op !== 'object' || !op.responses) continue;
        const detail = $('pre', { style: 'display:none' }, json({ parameters: op.parameters, requestBody: op.requestBody, responses: op.responses, security: op.security }));
        rows.push($('tr', {}, $('td', {}, method(m)), $('td', {}, $('a', { href: '#', on: { click: (e) => { e.preventDefault(); detail.style.display = detail.style.display ? '' : 'none'; } } }, p), detail), $('td', {}, op.summary || ''), $('td', { class: 'mute' }, (op['x-scopes'] || op.tags || []).join(', '))));
      }
      return $('div', { class: 'card' }, $('b', {}, d.title), ' ', $('span', { class: 'mute' }, (d.doc.info && d.doc.info.version ? 'v' + d.doc.info.version + ' · ' : '') + rows.length + ' operations · ' + d.url), $('table', {}, rows));
    });
    const fns = Array.isArray(r.functions) ? r.functions : [];
    return [$('h2', {}, 'APIs'),
      $('h3', {}, 'Hosted functions'), $('div', { class: 'card' }, r.functions.error ? $('span', { class: 'err' }, r.functions.error) : $('table', {}, fns.map((f) => $('tr', {}, $('td', {}, f.name), $('td', {}, f.kind), $('td', { class: 'mute' }, f.trigger || ''))))),
      r.endpoints.length ? [$('h3', {}, 'Declared endpoints (icebase/api)'), $('div', { class: 'card' }, $('table', {}, r.endpoints.map((e) => $('tr', {}, $('td', {}, e.name), $('td', {}, e.http ? method(e.http.method) : 'callable', ' ', e.http ? e.http.path : ''), $('td', {}, e.summary || ''), $('td', { class: 'mute' }, e.auth || '')))))] : null,
      r.openapi.length ? [$('h3', {}, 'OpenAPI documents'), docs] : null];
  },

  async rules() {
    const out = $('div');
    const show = (svc) => guard(out, async () => { const r = await api('rules', { service: svc }); set(out, $('div', { class: 'mute' }, r.file ? 'file: ' + r.file : 'no rules file in the config'), $('pre', { class: 'card' }, r.text ?? '(none)')); });
    show('firestore');
    return [$('h2', {}, 'Rules'), $('div', { class: 'row' }, ['firestore', 'storage', 'database'].map((s) => $('button', { on: { click: () => show(s) } }, s))), out];
  },
};

const names = { overview: 'Overview', apis: 'APIs', firestore: 'Firestore', query: 'Query runner', schema: 'Schema', indexes: 'Indexes', database: 'Realtime Database', auth: 'Authentication', storage: 'Storage', functions: 'Functions', hosting: 'Hosting', rules: 'Rules' };
async function go() {
  const page = (location.hash.slice(1) || 'overview').split('?')[0];
  set(document.getElementById('nav'), Object.entries(names).map(([k, v]) => $('a', { href: '#' + k, class: k === page ? 'on' : '' }, v)));
  set(main, $('div', { class: 'mute' }, 'loading…'));
  try { set(main, ...(await (pages[page] || pages.overview)()).flat()); } catch (e) { set(main, $('h2', {}, names[page] || ''), err(e)); }
}
window.addEventListener('hashchange', go);
// The deployment switcher (config.console.targets).
fetch('targets.json').then((r) => r.json()).then(({ targets }) => {
  if (!targets.length) return;
  const sel = $('select', { style: 'width:100%;margin:0 0 10px' }, $('option', { value: '' }, 'This server'), targets.map((t) => $('option', { value: t.url }, t.name)));
  sel.value = base;
  sel.addEventListener('change', () => { base = sel.value; sessionStorage.setItem('icebase-console-base', base); go(); api('overview').then((o) => { document.getElementById('proj').textContent = o.name + ' · ' + o.env; }).catch(() => {}); });
  document.getElementById('nav').before(sel);
}).catch(() => {});
go();
api('overview').then((o) => { document.getElementById('proj').textContent = o.name + ' · ' + o.env; }).catch(() => {});
`;
