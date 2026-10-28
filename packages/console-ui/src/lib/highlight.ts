// Syntax colouring for TypeScript, JSON and rules files: tokens out, never HTML in.

export interface Token {
  text: string;
  cls: string;
}

const RULES = {
  ts: /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(export|interface|type|readonly|extends|import|from|const|let|function|return|if|else|true|false|null|undefined|allow|match|service|rules_version|read|write|get|list|create|update|delete|in|is)\b|\b(string|number|boolean|unknown|Record|Timestamp|GeoPoint|DocumentReference|DocumentData|request|resource|[A-Z][A-Za-z0-9_]*)\b|(-?\b\d+(?:\.\d+)?\b)/g,
  json: /("(?:[^"\\]|\\.)*")(\s*:)?|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b)/g,
};

export function tokenize(code: string, lang: 'ts' | 'json' | 'rules' = 'ts'): Token[] {
  const out: Token[] = [];
  let at = 0;
  const push = (text: string, cls: string) => text && out.push({ text, cls });
  if (lang === 'json') {
    for (const m of code.matchAll(RULES.json)) {
      push(code.slice(at, m.index), '');
      if (m[1]) {
        push(m[1], m[2] ? 'key' : 'str');
        if (m[2]) push(m[2], '');
      } else push(m[0], m[3] ? 'kw' : 'num');
      at = m.index! + m[0].length;
    }
  } else {
    for (const m of code.matchAll(RULES.ts)) {
      push(code.slice(at, m.index), '');
      push(m[0], m[1] ? 'com' : m[2] ? 'str' : m[3] ? 'kw' : m[4] ? 'type' : 'num');
      at = m.index! + m[0].length;
    }
  }
  push(code.slice(at), '');
  return out;
}
