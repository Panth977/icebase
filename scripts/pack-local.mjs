// Pack the built packages as plain npm packages (types from dist/*.d.ts, the IceBase packages
// depending on each other by file:) for trying a local IceBase in another project:
//   npm run build && node scripts/pack-local.mjs /tmp/icebase-npm
//   then in the project: "@panth977/icebase": "file:/tmp/icebase-npm/icebase" (and -server, -cli)
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const out = resolve(process.argv[2] ?? '/tmp/icebase-npm');
const pkgs = { client: 'icebase', server: 'icebase-server', cli: 'icebase-cli' };
rmSync(out, { recursive: true, force: true });
for (const [dir, short] of Object.entries(pkgs)) {
  const src = resolve('packages', dir);
  const pj = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  const dst = join(out, short);
  mkdirSync(dst, { recursive: true });
  cpSync(join(src, 'dist'), join(dst, 'dist'), { recursive: true });
  for (const [sub, e] of Object.entries(pj.exports)) {
    const js = typeof e === 'string' ? e : e.default;
    pj.exports[sub] = { types: js.replace(/\.js$/, '.d.ts'), default: js };
  }
  for (const [name, v] of Object.entries(pj.dependencies ?? {})) {
    const hit = Object.values(pkgs).find((p) => name === `@panth977/${p}`);
    if (hit) pj.dependencies[name] = `file:${join(out, hit)}`;
    else pj.dependencies[name] = v;
  }
  if (pj.bin) for (const k of Object.keys(pj.bin)) pj.bin[k] = pj.bin[k];
  pj.files = ['dist'];
  delete pj.scripts;
  delete pj.devDependencies;
  writeFileSync(join(dst, 'package.json'), JSON.stringify(pj, null, 2));
}
console.log(out);
