// `icebase docs` — the database and the API as a browsable reference: one self-contained HTML page
// (no build, no network) generated from the config's declarations, plus project.json and openapi.json.

import type { ProjectDoc } from '@panth977/icebase/describe';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function renderDocs(doc: ProjectDoc): string {
  const data = JSON.stringify(doc).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.name)} — schema &amp; API reference</title>
<style>
:root{--bg:#fbfbfd;--panel:#fff;--line:#e4e7ee;--text:#1b2030;--muted:#667085;--accent:#2563eb;--code:#f4f6fa;--good:#067647;--warn:#b54708;--bad:#b42318}
*{box-sizing:border-box}body{margin:0;font:14px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--text);background:var(--bg);display:grid;grid-template-columns:280px 1fr;height:100vh}
nav{border-right:1px solid var(--line);background:var(--panel);overflow:auto;padding:16px 12px}
nav h1{font-size:16px;margin:0 0 2px}nav .sub{color:var(--muted);font-size:12px;margin-bottom:12px}
nav input{width:100%;padding:7px 9px;border:1px solid var(--line);border-radius:7px;font:inherit;margin-bottom:10px}
nav h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:14px 6px 4px}
nav a{display:block;padding:4px 8px;border-radius:6px;color:var(--text);text-decoration:none;font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
nav a:hover,nav a.on{background:#eef2ff;color:var(--accent)}
main{overflow:auto;padding:28px 40px 80px}
section{max-width:1000px;margin:0 0 40px;scroll-margin-top:20px}
h2.title{font-size:22px;margin:0 0 4px}h3{font-size:15px;margin:22px 0 8px}
.meta{color:var(--muted);margin-bottom:12px}.pill{display:inline-block;font-size:11px;padding:1px 8px;border-radius:999px;background:var(--code);border:1px solid var(--line);margin-right:6px;color:var(--muted)}
.pill.get{background:#ecfdf3;color:var(--good);border-color:#abefc6}.pill.post,.pill.callable{background:#eff8ff;color:#175cd3;border-color:#b2ddff}.pill.put,.pill.patch{background:#fffaeb;color:var(--warn);border-color:#fedf89}.pill.delete{background:#fef3f2;color:var(--bad);border-color:#fecdca}
code,pre{font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}code{background:var(--code);padding:1px 5px;border-radius:4px}
pre{background:#0f172a;color:#e2e8f0;padding:12px 14px;border-radius:8px;overflow:auto;margin:6px 0}
table{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{text-align:left;padding:6px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{background:#f8fafc;font-weight:600;font-size:12px;color:var(--muted)}
tr:last-child td{border-bottom:0}.f{white-space:nowrap}.f span.ind{display:inline-block}.t{color:#7a2e0e}.opt{color:var(--muted);font-size:12px}
.tabs{display:flex;gap:4px;margin-top:8px}.tabs button{font:inherit;font-size:12px;border:1px solid var(--line);background:var(--panel);border-radius:6px;padding:3px 10px;cursor:pointer}.tabs button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}.problem{background:#fef3f2;border:1px solid #fecdca;color:var(--bad);padding:8px 12px;border-radius:8px;margin:6px 0}
.ok{background:#ecfdf3;border:1px solid #abefc6;color:var(--good);padding:8px 12px;border-radius:8px}
a.ref{color:var(--accent);text-decoration:none}
@media (max-width:800px){body{grid-template-columns:1fr}nav{display:none}main{padding:16px}.grid{grid-template-columns:1fr}}
</style></head>
<body><nav id="nav"></nav><main id="main"></main>
<script>
const D=${data};
const h=(t,a={},...c)=>{const e=document.createElement(t);for(const[k,v]of Object.entries(a))k==='class'?e.className=v:k.startsWith('on')?e.addEventListener(k.slice(2),v):e.setAttribute(k,v);for(const x of c.flat())if(x!=null&&x!==false)e.append(x.nodeType?x:document.createTextNode(String(x)));return e};
const id=(k,n)=>k+'-'+n.replace(/[^A-Za-z0-9]+/g,'-');
const json=v=>h('pre',{},JSON.stringify(v,null,2));
const typeCell=f=>{const parts=[h('span',{class:'t'},f.type)];if(f.values)parts.push(' ',h('span',{class:'opt'},f.values.map(v=>JSON.stringify(v)).join(' | ')));if(f.ref){const c=D.collections.find(c=>c.path===f.ref);parts.push(' ',c?h('a',{class:'ref',href:'#'+id('c',f.ref)},'→ '+f.ref):h('span',{class:'opt'},'→ '+f.ref))}return parts};
const rows=(fs,depth=0)=>fs.flatMap(f=>[h('tr',{},h('td',{class:'f'},h('span',{class:'ind',style:'width:'+depth*16+'px'}),h('code',{},f.name)),h('td',{},...typeCell(f)),h('td',{class:'opt'},[f.optional?'optional':'required',f.nullable?' · nullable':''].join(''))),...rows(f.children||[],depth+1)]);
const fieldTable=fs=>fs.length?h('table',{},h('tr',{},h('th',{},'Field'),h('th',{},'Type'),h('th',{},'')),...rows(fs)):h('div',{class:'opt'},'(no fields)');
function snippets(e){
  const ts=e.kind==='http'?\`import { getFunctions, request } from '@panth977/icebase/functions';
import { api } from './icebase.config';

const out = await request(getFunctions(app), api.\${e.name}, \${JSON.stringify(e.example.input)});\`:\`import { getFunctions, callable } from '@panth977/icebase/functions';
import { api } from './icebase.config';

const \${e.name} = callable(getFunctions(app), api.\${e.name});
const out = await \${e.name}(\${JSON.stringify(e.example.input)});\`;
  const dart=e.kind==='http'?\`final out = await IceBaseFunctions.instance.request(Api.\${e.name}, \${JSON.stringify(e.example.input)});\`:\`final out = await Api.\${e.name}.call(\${JSON.stringify(e.example.input)});\`;
  const base=D.projectId?\`https://us-central1-\${D.projectId}.cloudfunctions.net/\${e.name}\`:\`https://REGION-PROJECT.cloudfunctions.net/\${e.name}\`;
  let curl;if(e.kind==='http'){const q={...e.example.input};const p=e.path.replace(/\\{([^}]+)\\}/g,(_,k)=>{const v=q[k];delete q[k];return encodeURIComponent(String(v))});const bodyless=e.method==='GET'||e.method==='DELETE';const qs=bodyless&&Object.keys(q).length?'?'+new URLSearchParams(Object.entries(q).map(([k,v])=>[k,typeof v==='object'?JSON.stringify(v):String(v)])).toString():'';curl=\`curl -X \${e.method} '\${base}\${p}\${qs}'\${e.auth!=='none'?" \\\\\\n  -H 'Authorization: Bearer ID_TOKEN'":''}\${bodyless?'':" \\\\\\n  -H 'Content-Type: application/json' -d '"+JSON.stringify(q)+"'"}\`}else curl=\`curl -X POST '\${base}'\${e.auth!=='none'?" \\\\\\n  -H 'Authorization: Bearer ID_TOKEN'":''} \\\\\\n  -H 'Content-Type: application/json' -d '\${JSON.stringify({data:e.example.input})}'\`;
  const all={TypeScript:ts,Dart:dart,curl};const pre=h('pre',{},ts);const bar=h('div',{class:'tabs'});
  for(const k of Object.keys(all)){const b=h('button',{class:k==='TypeScript'?'on':'',onclick:()=>{pre.textContent=all[k];bar.querySelectorAll('button').forEach(x=>x.classList.toggle('on',x===b))}},k);bar.append(b)}
  return [bar,pre];
}
function render(){
  const nav=document.getElementById('nav'),main=document.getElementById('main');
  const q=h('input',{placeholder:'Search collections, fields, endpoints…',oninput:()=>filter(q.value)});
  nav.append(h('h1',{},D.name),h('div',{class:'sub'},'Schema & API reference'+(D.projectId?' · '+D.projectId:'')),q,h('a',{href:'#overview'},'Overview'));
  const sec=(title,items)=>{if(!items.length)return;nav.append(h('h2',{},title));for(const[i,label]of items)nav.append(h('a',{href:'#'+i,'data-k':label.toLowerCase()},label))};
  const tags=[...new Set(D.endpoints.map(e=>e.tag||'Endpoints'))];
  for(const t of tags)sec('API · '+t,D.endpoints.filter(e=>(e.tag||'Endpoints')===t).map(e=>[id('e',e.name),e.name]));
  sec('Firestore',D.collections.map(c=>[id('c',c.path),c.path]));
  sec('Realtime Database',D.paths.map(p=>[id('p',p.path),p.path]));
  sec('Storage',D.files.map(f=>[id('s',f.path),f.path]));
  // overview
  main.append(h('section',{id:'overview'},h('h2',{class:'title'},D.name),h('div',{class:'meta'},\`\${D.collections.length} collections · \${D.paths.length} Realtime Database paths · \${D.files.length} storage paths · \${D.endpoints.length} endpoints\`),
    D.problems.length?D.problems.map(p=>h('div',{class:'problem'},p)):h('div',{class:'ok'},'Dry run: every declaration is consistent.'),
    h('h3',{},'Environments'),h('table',{},h('tr',{},h('th',{},'Environment'),...Object.keys(D.environments[0]?.modes||{}).map(s=>h('th',{},s))),...D.environments.map(e=>h('tr',{},h('td',{},h('code',{},e.name)),...Object.values(e.modes).map(m=>h('td',{},m)))))));
  for(const e of D.endpoints)main.append(h('section',{id:id('e',e.name),'data-k':(e.name+' '+(e.summary||'')+' '+(e.path||'')).toLowerCase()},
    h('h2',{class:'title'},e.name),h('div',{class:'meta'},h('span',{class:'pill '+(e.kind==='http'?e.method.toLowerCase():'callable')},e.kind==='http'?e.method:'callable'),e.kind==='http'?h('code',{},e.path):'',' ',h('span',{class:'pill'},'auth: '+e.auth),e.deprecated?h('span',{class:'pill'},'deprecated'):''),
    e.summary?h('p',{},e.summary):'',e.description?h('p',{class:'opt'},e.description):'',
    h('div',{class:'grid'},h('div',{},h('h3',{},'Input'),fieldTable(e.input.children||[e.input])),h('div',{},h('h3',{},'Output'),fieldTable(e.output.children||[e.output]))),
    e.errors.length?[h('h3',{},'Errors'),h('table',{},h('tr',{},h('th',{},'Code'),h('th',{},'When')),...e.errors.map(x=>h('tr',{},h('td',{},h('code',{},x.code)),h('td',{},x.when))))]:'',
    h('h3',{},'Example'),h('div',{class:'grid'},h('div',{},h('div',{class:'opt'},'input'),json(e.example.input)),h('div',{},h('div',{class:'opt'},'output'),json(e.example.output))),
    h('h3',{},'Call it'),...snippets(e)));
  for(const c of D.collections)main.append(h('section',{id:id('c',c.path),'data-k':(c.path+' '+c.fields.map(f=>f.name).join(' ')).toLowerCase()},
    h('h2',{class:'title'},c.path),h('div',{class:'meta'},h('span',{class:'pill'},'Firestore'),c.group?h('span',{class:'pill'},'collection group'):'',c.glob?h('span',{class:'pill'},'any depth'):'',c.autoIndex?h('span',{class:'pill'},'automatic single-field indexes'):'',c.open?h('span',{class:'pill'},'open document'):'',c.ttl?h('span',{class:'pill'},'TTL: '+c.ttl):''),
    h('h3',{},'Fields'),fieldTable(c.fields),
    h('h3',{},'Indexes'),c.indexes.length?h('table',{},h('tr',{},h('th',{},'Declared as'),h('th',{},'Fields')),...c.indexes.map(ix=>h('tr',{},h('td',{},h('code',{},ix.code)),h('td',{},ix.fields.map(f=>f.path.join('.')+(f.mode==='asc'?'':' ('+f.mode+')')).join(', '))))):h('div',{class:'opt'},c.autoIndex?'Single-field queries need no declaration here.':'None: only lookups by id.'),
    h('h3',{},'Sample document'),json(c.sample)));
  for(const p of D.paths)main.append(h('section',{id:id('p',p.path),'data-k':p.path.toLowerCase()},h('h2',{class:'title'},p.path),h('div',{class:'meta'},h('span',{class:'pill'},'Realtime Database'),p.indexOn.length?h('span',{class:'pill'},'indexOn: '+p.indexOn.join(', ')):''),h('h3',{},'Value'),fieldTable(p.value.children||[p.value]),h('h3',{},'Sample'),json(p.sample)));
  for(const f of D.files)main.append(h('section',{id:id('s',f.path),'data-k':f.path.toLowerCase()},h('h2',{class:'title'},f.path),h('div',{class:'meta'},h('span',{class:'pill'},'Storage'),f.contentTypes.length?h('span',{class:'pill'},f.contentTypes.join(', ')):h('span',{class:'pill'},'any type'),f.maxBytes!==undefined?h('span',{class:'pill'},'max '+(f.maxBytes>=1048576?(f.maxBytes/1048576).toFixed(1)+' MB':f.maxBytes+' bytes')):'')));
  const links=[...nav.querySelectorAll('a')];const on=()=>{const y=main.scrollTop;let cur=null;for(const s of main.querySelectorAll('section'))if(s.offsetTop-40<=y)cur=s.id;links.forEach(a=>a.classList.toggle('on',a.getAttribute('href')==='#'+cur))};main.addEventListener('scroll',on);on();
}
function filter(t){t=t.toLowerCase();for(const el of document.querySelectorAll('[data-k]'))el.style.display=!t||el.dataset.k.includes(t)?'':'none'}
render();
</script></body></html>`;
}
