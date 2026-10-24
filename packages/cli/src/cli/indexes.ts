// `icebase indexes check` (CLI-6, IDX-3): type-check the project and report every query whose
// index (single-field or composite) is not declared. Uses the same compile-time rule as icebase/firestore, so
// what it reports is exactly what `getDocs(query(…))` would refuse.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';

export interface MissingIndex {
  file: string;
  line: number;
  column: number;
  fields: string[];
}

export async function checkIndexes(root: string, tsconfig = 'tsconfig.json'): Promise<{ missing: MissingIndex[]; otherErrors: number }> {
  const req = createRequire(resolve(root, 'package.json'));
  let ts: typeof import('typescript');
  try {
    ts = req('typescript') as typeof import('typescript');
  } catch {
    throw new Error('`icebase indexes check` needs the `typescript` package in your project');
  }
  const cfgPath = resolve(root, tsconfig);
  if (!existsSync(cfgPath)) throw new Error(`No ${tsconfig} in ${root}`);
  const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
  if (read.error) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'));
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
  const missing: MissingIndex[] = [];
  let otherErrors = 0;
  for (const d of ts.getPreEmitDiagnostics(program)) {
    const text = ts.flattenDiagnosticMessageText(d.messageText, '\n');
    const m = /Missing(?:Composite)?Index<([^>]+)>/.exec(text);
    if (!m || !d.file || d.start === undefined) {
      if (d.category === ts.DiagnosticCategory.Error) otherErrors++;
      continue;
    }
    const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
    missing.push({ file: relative(root, d.file.fileName), line: line + 1, column: character + 1, fields: [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!) });
  }
  return { missing, otherErrors };
}
