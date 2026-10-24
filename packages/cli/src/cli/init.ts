// `icebase init` (CLI-1): create the project structure, optionally importing an existing
// Firebase project (its rules, its composite indexes, and a schema draft from sampled documents).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

type Log = (line: string) => void;

/** Firestore's field-path syntax ('a.b', '`a.b`.c') as key arrays. */
export function parseFieldPath(s: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '`') {
      let k = '';
      i++;
      while (i < s.length && s[i] !== '`') {
        if (s[i] === '\\') i++;
        k += s[i++];
      }
      i++;
      out.push(k);
    } else {
      const j = s.indexOf('.', i);
      out.push(s.slice(i, j < 0 ? s.length : j));
      i = j < 0 ? s.length : j;
    }
    if (s[i] === '.') i++;
  }
  return out;
}

export interface InitOptions {
  name: string;
  projectId?: string;
  /** Read firebase.json / firestore.indexes.json / rules from this directory (an existing Firebase project). */
  importDir?: string;
  /** Sample this many documents per top-level collection (admin credentials needed) to draft field types. */
  sample?: number;
}

/** What was seen of one field: its kinds, how often, and (maps) its own fields. */
interface FieldStat {
  kinds: Set<string>;
  count: number;
  sub?: Map<string, FieldStat>;
}

interface Draft {
  path: string;
  /** Field → the kinds seen, and in how many sampled documents. */
  fields: Map<string, FieldStat>;
  seen: number;
  /** Index declarations, as code: index('a', desc('b')). */
  indexes: string[];
}

const ident = (s: string) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? s : JSON.stringify(s));
const varName = (path: string) => {
  const id = path.split('/').pop()!.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(id) ? `c_${id}` : id;
};

/** A field type for one sampled value. */
function kindOf(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return `array:${v.length ? kindOf(v[0]) : 'string'}`;
  const ctor = (v as { constructor?: { name?: string } }).constructor?.name;
  if (ctor === 'Timestamp') return 'timestamp';
  if (ctor === 'GeoPoint') return 'geopoint';
  if (ctor === 'DocumentReference') return 'ref';
  return 'map';
}

function dsl(kinds: Set<string>, optional: boolean): string {
  const ks = [...kinds].filter((k) => k !== 'null');
  let t: string;
  if (ks.length === 0) t = 'f.string() /* TODO: only nulls seen */';
  else if (ks.every((k) => k === 'int')) t = 'f.number({ int: true })';
  else if (ks.every((k) => k === 'int' || k === 'number')) t = 'f.number()';
  else if (ks.length > 1) t = `f.string() /* TODO: mixed types seen: ${ks.join(', ')} */`;
  else {
    const k = ks[0]!;
    t = k === 'string' ? 'f.string()' : k === 'boolean' ? 'f.boolean()' : k === 'timestamp' ? 'f.timestamp()' : k === 'geopoint' ? 'f.geopoint()' : k === 'map' ? 'f.map({}) /* TODO: declare its fields */' : k === 'ref' ? 'f.string() /* TODO: f.ref(theCollection) */' : k.startsWith('array:') ? `f.array(${dsl(new Set([k.slice(6)]), false)})` : 'f.string()';
  }
  return optional || kinds.has('null') ? `f.optional(${t})` : t;
}

function collectionFile(d: Draft): string {
  const render = (s: FieldStat, optional: boolean, indent: string): string =>
    s.sub ? `${optional ? 'f.optional(' : ''}f.map({\n${[...s.sub].map(([k, x]) => `${indent}  ${ident(k)}: ${render(x, false, `${indent}  `)},`).join('\n')}\n${indent}})${optional ? ')' : ''}` : dsl(s.kinds, optional);
  const lines = [...d.fields.entries()].map(([name, s]) => `    ${ident(name)}: ${render(s, d.seen > 0 && s.count < d.seen, '    ')},`);
  // Firebase indexed every field by itself; IceBase indexes only what is declared. Draft a
  // single-field index per scalar field — keep the ones queries use (`icebase indexes check`).
  const singles = [...d.fields.entries()].filter(([, s]) => [...s.kinds].some((k) => ['string', 'int', 'number', 'boolean', 'timestamp', 'ref'].includes(k) || k.startsWith('array:'))).map(([name]) => `index(${JSON.stringify(name).replace(/^"|"$/g, "'")})`);
  const idx = [...new Set([...singles, ...d.indexes])].map((ix) => `    ${ix},`);
  return `import { collection, contains, desc, f, index } from '@panth977/icebase/schema';

export const ${varName(d.path)} = collection('${d.path}', {
  fields: {
${lines.join('\n') || "    // TODO: declare this collection's fields"}
  },
  // Every index a query uses, single-field ones too; nothing else is indexed.
  indexes: [${idx.length ? `\n${idx.join('\n')}\n  ` : ''}],
});
`;
}

function write(root: string, rel: string, content: string, log: Log): void {
  const p = resolve(root, rel);
  if (existsSync(p)) {
    log(`skip   ${rel} (exists)`);
    return;
  }
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  log(`create ${rel}`);
}

export async function init(root: string, opts: InitOptions, log: Log): Promise<void> {
  const drafts = new Map<string, Draft>();
  const draft = (path: string) => {
    let d = drafts.get(path);
    if (!d) drafts.set(path, (d = { path, fields: new Map(), seen: 0, indexes: [] }));
    return d;
  };
  let rules: { firestore?: string; storage?: string; database?: string } = {};
  const imp = opts.importDir ? resolve(opts.importDir) : null;
  if (imp) {
    const fbPath = join(imp, 'firebase.json');
    const fb = existsSync(fbPath) ? (JSON.parse(readFileSync(fbPath, 'utf8')) as { firestore?: { rules?: string; indexes?: string }; storage?: { rules?: string }; database?: { rules?: string } }) : {};
    const copy = (from: string | undefined, to: string) => {
      if (!from || !existsSync(join(imp, from))) return undefined;
      write(root, to, readFileSync(join(imp, from), 'utf8'), log);
      return to;
    };
    rules = {
      ...(copy(fb.firestore?.rules, 'icebase/rules/firestore.rules') ? { firestore: 'icebase/rules/firestore.rules' } : {}),
      ...(copy(fb.storage?.rules, 'icebase/rules/storage.rules') ? { storage: 'icebase/rules/storage.rules' } : {}),
      ...(copy(fb.database?.rules, 'icebase/rules/database.rules.json') ? { database: 'icebase/rules/database.rules.json' } : {}),
    };
    const ixPath = fb.firestore?.indexes && join(imp, fb.firestore.indexes);
    if (ixPath && existsSync(ixPath)) {
      const file = JSON.parse(readFileSync(ixPath, 'utf8')) as { indexes?: { collectionGroup: string; fields: { fieldPath: string; order?: string; arrayConfig?: string }[] }[] };
      for (const ix of file.indexes ?? []) {
        const d = draft(ix.collectionGroup);
        const fields = ix.fields.filter((x) => x.fieldPath !== '__name__');
        const code = (p: string[]) => (p.length === 1 ? `'${p[0]}'` : `[${p.map((s) => `'${s}'`).join(', ')}]`);
        const entries = fields.map((x) => {
          const p = parseFieldPath(x.fieldPath);
          return x.arrayConfig ? `contains(${code(p)})` : x.order === 'DESCENDING' ? `desc(${code(p)})` : code(p);
        });
        if (entries.length > 1) d.indexes.push(`index(${entries.join(', ')})`);
        for (const x of fields) {
          // Declare the field (and, for a key path, the maps on the way to it).
          let level = d.fields;
          const p = parseFieldPath(x.fieldPath);
          p.forEach((k, i) => {
            let s = level.get(k);
            if (!s) level.set(k, (s = { kinds: new Set(x.arrayConfig && i === p.length - 1 ? ['array:string'] : []), count: 0 }));
            if (i < p.length - 1) level = s.sub ??= new Map();
          });
        }
      }
      log(`import ${file.indexes?.length ?? 0} composite index(es) from ${fb.firestore!.indexes}`);
    }
  }
  if (opts.sample && opts.projectId) {
    const [{ initializeApp: adminInit, applicationDefault }, { getFirestore }] = await Promise.all([import('firebase-admin/app'), import('firebase-admin/firestore')]);
    const db = getFirestore(adminInit({ projectId: opts.projectId, credential: applicationDefault() }, `icebase-init-${Date.now()}`));
    for (const c of await db.listCollections()) {
      const snap = await c.limit(opts.sample).get();
      const d = draft(c.id);
      for (const doc of snap.docs) {
        d.seen++;
        for (const [k, v] of Object.entries(doc.data())) {
          const s = d.fields.get(k) ?? { kinds: new Set<string>(), count: 0 };
          s.kinds.add(kindOf(v));
          s.count++;
          d.fields.set(k, s);
        }
      }
      log(`sample ${c.id}: ${snap.size} document(s), ${d.fields.size} field(s)`);
    }
  }
  if (drafts.size === 0) {
    const d = draft('items');
    d.fields.set('name', { kinds: new Set(['string']), count: 0 });
    d.fields.set('createdAt', { kinds: new Set(['timestamp']), count: 0 });
    d.seen = 0;
  }
  for (const d of drafts.values()) write(root, `icebase/schema/${varName(d.path)}.ts`, collectionFile(d), log);
  const names = [...drafts.values()].map((d) => varName(d.path));
  write(root, 'icebase/schema/index.ts', `import { defineSchema } from '@panth977/icebase/schema';\n${names.map((n) => `import { ${n} } from './${n}';`).join('\n')}\n\nexport { ${names.join(', ')} };\nexport const schema = defineSchema({ ${names.join(', ')} });\n`, log);
  if (!rules.firestore) {
    write(root, 'icebase/rules/firestore.rules', `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n    match /{document=**} {\n      allow read, write: if false;\n    }\n  }\n}\n`, log);
    rules.firestore = 'icebase/rules/firestore.rules';
  }
  if (!rules.storage) {
    write(root, 'icebase/rules/storage.rules', `rules_version = '2';\nservice firebase.storage {\n  match /b/{bucket}/o {\n    match /{all=**} {\n      allow read, write: if false;\n    }\n  }\n}\n`, log);
    rules.storage = 'icebase/rules/storage.rules';
  }
  const pid = opts.projectId ?? `${opts.name}`;
  write(
    root,
    'icebase.config.ts',
    `import { defineConfig } from '@panth977/icebase/config';
import { schema } from './icebase/schema';

export default defineConfig({
  name: ${JSON.stringify(opts.name)},
  schema,
  rules: ${JSON.stringify(rules, null, 2).replace(/\n/g, '\n  ')},
  functions: { source: '@panth977/icebase/functions', runtime: 'nodejs22', region: 'us-central1' },
  hosting: { public: 'dist', spa: true },
  auth: { providers: ['password'] },

  // Secrets are env-var NAMES, never values (see .env.example).
  firebase: { projectId: ${JSON.stringify(pid)}, webConfigEnv: 'FIREBASE_WEB_CONFIG', serviceAccountEnv: 'FIREBASE_SERVICE_ACCOUNT' },
  emulator: { dataDir: '.icebase', port: 4400 },

  environments: {
    local: { mode: 'emulator' },
    prod: { mode: 'firebase' },
  },
});
`,
    log,
  );
  write(root, 'icebase/functions/package.json', JSON.stringify({ name: `${opts.name}-functions`, private: true, type: 'module', main: 'src/index.ts', dependencies: {} }, null, 2) + '\n', log);
  write(root, 'icebase/functions/src/index.ts', `// Every export is a deployed function — the same file runs on Cloud Functions (firebase mode) and the IceBase server (emulator).\nimport { onRequest } from '@panth977/icebase-server/functions';\n\nexport const health = onRequest(() => new Response('ok'));\n`, log);
  write(root, 'src/lib/icebase.ts', `// The only setup file in the frontend. Switch environments with one string; app code never changes.\nimport { initializeApp } from '@panth977/icebase/app';\nimport { getFirestore } from '@panth977/icebase/firestore';\nimport { getAuth } from '@panth977/icebase/auth';\nimport config from '../../icebase.config';\n\nexport const app = initializeApp(config, import.meta.env?.PROD ? 'prod' : 'local');\nexport const db = getFirestore(app);\nexport const auth = getAuth(app);\n`, log);
  write(root, '.env.example', `# mode: firebase\nFIREBASE_WEB_CONFIG={"apiKey":"…","authDomain":"${pid}.firebaseapp.com","projectId":"${pid}","appId":"…"}\nFIREBASE_SERVICE_ACCOUNT=./secrets/firebase-admin.json\n`, log);
  const gi = resolve(root, '.gitignore');
  const want = ['.icebase/', 'icebase/.generated/', '.env', '.env.*', '!.env.example'];
  const have = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  const add = want.filter((w) => !have.split('\n').includes(w));
  if (add.length) {
    writeFileSync(gi, `${have}${have && !have.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
    log(`update .gitignore (+${add.join(' ')})`);
  }
}
