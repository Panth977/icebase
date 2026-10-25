// Firebase Security Rules, evaluated by IceBase (RUL-2): the same firestore.rules and
// storage.rules files as Firebase, for the emulator (and later the VM). Rules version 2.
//
// Covered: match blocks with {wildcards} and {rest=**}, nested matches, allow with method
// lists (read = get + list, write = create + update + delete), functions with let, the
// expression language (literals, lists, maps, paths with $(…), . [] calls, ! - * / % + - < <=
// > >= == != in is && || ?:), request / resource, get() / exists() / getAfter() /
// existsAfter(), firestore.get() / firestore.exists() from storage rules, and the standard
// library methods apps use (string, list, map, set, MapDiff, timestamp, duration, math).
// An error while evaluating a condition denies that statement, as in Firebase.

import { IceBaseError } from '@panth977/icebase/errors';
import { tsKey } from '@panth977/icebase/internal';
import { Buffer } from 'node:buffer';

// ─── AST ───────────────────────────────────────────────────────────────────────

type Expr =
  | { k: 'lit'; v: unknown }
  | { k: 'id'; name: string }
  | { k: 'list'; items: Expr[] }
  | { k: 'map'; entries: [Expr, Expr][] }
  | { k: 'path'; parts: (string | Expr)[] }
  | { k: 'member'; obj: Expr; name: string }
  | { k: 'index'; obj: Expr; index: Expr }
  | { k: 'call'; fn: Expr; args: Expr[] }
  | { k: 'unary'; op: '!' | '-'; e: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'is'; e: Expr; type: string }
  | { k: 'cond'; c: Expr; a: Expr; b: Expr };

interface Fn {
  params: string[];
  lets: [string, Expr][];
  body: Expr;
}
interface Allow {
  methods: string[];
  cond: Expr | null;
}
interface Match {
  segs: { lit?: string; name?: string; rest?: boolean }[];
  allows: Allow[];
  fns: Map<string, Fn>;
  children: Match[];
}

// ─── parser ────────────────────────────────────────────────────────────────────

class Parser {
  i = 0;
  constructor(readonly src: string) {}
  fail(msg: string): never {
    const before = this.src.slice(0, this.i);
    const line = before.split('\n').length;
    const col = this.i - before.lastIndexOf('\n');
    throw new IceBaseError('invalid-argument', `rules ${line}:${col}: ${msg}`, { reason: 'config' });
  }
  ws(): void {
    for (;;) {
      const m = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)/.exec(this.src.slice(this.i));
      if (!m) return;
      this.i += m[0].length;
    }
  }
  peek(s: string): boolean {
    this.ws();
    return this.src.startsWith(s, this.i);
  }
  eat(s: string): boolean {
    if (!this.peek(s)) return false;
    // A keyword must not run into an identifier ("in" vs "index").
    if (/^[A-Za-z_]/.test(s) && /[A-Za-z0-9_]/.test(this.src[this.i + s.length] ?? '')) return false;
    this.i += s.length;
    return true;
  }
  need(s: string): void {
    if (!this.eat(s)) this.fail(`expected '${s}'`);
  }
  ident(): string {
    this.ws();
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(this.src.slice(this.i));
    if (!m) this.fail('expected a name');
    this.i += m[0].length;
    return m[0];
  }

  file(): { service: string; root: Match } {
    const root: Match = { segs: [], allows: [], fns: new Map(), children: [] };
    let service = '';
    while (this.peek('rules_version') || this.peek('service')) {
      if (this.eat('rules_version')) {
        this.need('=');
        this.primary();
        this.eat(';');
        continue;
      }
      this.need('service');
      this.ws();
      const m = /^[A-Za-z_.]+/.exec(this.src.slice(this.i));
      if (!m) this.fail('expected a service name');
      this.i += m[0].length;
      service = m[0];
      this.need('{');
      this.body(root);
      this.need('}');
    }
    this.ws();
    if (this.i < this.src.length) this.fail('unexpected text');
    return { service, root };
  }

  body(into: Match): void {
    while (!this.peek('}')) {
      if (this.eat('match')) into.children.push(this.match());
      else if (this.eat('allow')) into.allows.push(this.allow());
      else if (this.eat('function')) {
        const name = this.ident();
        into.fns.set(name, this.fn());
      } else this.fail('expected match, allow or function');
    }
  }

  match(): Match {
    this.ws();
    const segs: Match['segs'] = [];
    while (this.src[this.i] === '/') {
      this.i++;
      const m = /^(\{([A-Za-z_][A-Za-z0-9_]*)(=\*\*)?\}|[^/\s{]+)/.exec(this.src.slice(this.i));
      if (!m) this.fail('bad match path');
      this.i += m[0].length;
      segs.push(m[2] ? { name: m[2], rest: !!m[3] } : { lit: m[1]! });
    }
    const out: Match = { segs, allows: [], fns: new Map(), children: [] };
    this.need('{');
    this.body(out);
    this.need('}');
    return out;
  }

  allow(): Allow {
    const methods = [this.ident()];
    while (this.eat(',')) methods.push(this.ident());
    for (const m of methods) if (!['read', 'write', 'get', 'list', 'create', 'update', 'delete'].includes(m)) this.fail(`unknown method '${m}'`);
    let cond: Expr | null = null;
    if (this.eat(':')) {
      this.need('if');
      cond = this.expr();
    }
    this.eat(';');
    return { methods, cond };
  }

  fn(): Fn {
    this.need('(');
    const params: string[] = [];
    if (!this.peek(')')) {
      params.push(this.ident());
      while (this.eat(',')) params.push(this.ident());
    }
    this.need(')');
    this.need('{');
    const lets: [string, Expr][] = [];
    while (this.eat('let')) {
      const n = this.ident();
      this.need('=');
      lets.push([n, this.expr()]);
      this.eat(';');
    }
    this.need('return');
    const body = this.expr();
    this.eat(';');
    this.need('}');
    return { params, lets, body };
  }

  // Pratt-style precedence climbing.
  expr(): Expr {
    const c = this.or();
    if (this.eat('?')) {
      const a = this.expr();
      this.need(':');
      return { k: 'cond', c, a, b: this.expr() };
    }
    return c;
  }
  or(): Expr {
    let l = this.and();
    while (this.eat('||')) l = { k: 'bin', op: '||', l, r: this.and() };
    return l;
  }
  and(): Expr {
    let l = this.eq();
    while (this.eat('&&')) l = { k: 'bin', op: '&&', l, r: this.eq() };
    return l;
  }
  eq(): Expr {
    let l = this.rel();
    for (;;) {
      if (this.eat('==')) l = { k: 'bin', op: '==', l, r: this.rel() };
      else if (this.eat('!=')) l = { k: 'bin', op: '!=', l, r: this.rel() };
      else return l;
    }
  }
  rel(): Expr {
    let l = this.add();
    for (;;) {
      if (this.eat('<=')) l = { k: 'bin', op: '<=', l, r: this.add() };
      else if (this.eat('>=')) l = { k: 'bin', op: '>=', l, r: this.add() };
      else if (this.eat('<')) l = { k: 'bin', op: '<', l, r: this.add() };
      else if (this.eat('>')) l = { k: 'bin', op: '>', l, r: this.add() };
      else if (this.eat('in')) l = { k: 'bin', op: 'in', l, r: this.add() };
      else if (this.eat('is')) l = { k: 'is', e: l, type: this.ident() };
      else return l;
    }
  }
  add(): Expr {
    let l = this.mul();
    for (;;) {
      if (this.eat('+')) l = { k: 'bin', op: '+', l, r: this.mul() };
      else if (this.peek('-') && !this.peek('->')) {
        this.i++;
        l = { k: 'bin', op: '-', l, r: this.mul() };
      } else return l;
    }
  }
  mul(): Expr {
    let l = this.unary();
    for (;;) {
      if (this.eat('*')) l = { k: 'bin', op: '*', l, r: this.unary() };
      else if (this.peek('/') && !this.pathAhead()) {
        this.i++;
        l = { k: 'bin', op: '/', l, r: this.unary() };
      } else if (this.eat('%')) l = { k: 'bin', op: '%', l, r: this.unary() };
      else return l;
    }
  }
  /** After an operand, '/' is division; a path literal only starts an operand. */
  pathAhead(): boolean {
    return false;
  }
  unary(): Expr {
    if (this.peek('!') && !this.peek('!=')) {
      this.i++;
      return { k: 'unary', op: '!', e: this.unary() };
    }
    if (this.peek('-') && /[0-9]/.test(this.src[this.i + 1] ?? '') === false && !this.peek('->')) {
      this.i++;
      return { k: 'unary', op: '-', e: this.unary() };
    }
    return this.postfix(this.primary());
  }
  postfix(e: Expr): Expr {
    for (;;) {
      if (this.eat('.')) e = { k: 'member', obj: e, name: this.ident() };
      else if (this.eat('[')) {
        const index = this.expr();
        this.need(']');
        e = { k: 'index', obj: e, index };
      } else if (this.peek('(')) {
        this.i++;
        const args: Expr[] = [];
        if (!this.peek(')')) {
          args.push(this.expr());
          while (this.eat(',')) args.push(this.expr());
        }
        this.need(')');
        e = { k: 'call', fn: e, args };
      } else return e;
    }
  }
  primary(): Expr {
    this.ws();
    const s = this.src.slice(this.i);
    if (this.eat('(')) {
      const e = this.expr();
      this.need(')');
      return e;
    }
    if (this.eat('[')) {
      const items: Expr[] = [];
      if (!this.peek(']')) {
        items.push(this.expr());
        while (this.eat(',')) if (!this.peek(']')) items.push(this.expr());
      }
      this.need(']');
      return { k: 'list', items };
    }
    if (this.eat('{')) {
      const entries: [Expr, Expr][] = [];
      if (!this.peek('}')) {
        do {
          if (this.peek('}')) break;
          const key = this.primary();
          this.need(':');
          entries.push([key, this.expr()]);
        } while (this.eat(','));
      }
      this.need('}');
      return { k: 'map', entries };
    }
    if (s[0] === '/') return this.pathLit();
    let m = /^-?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/.exec(s);
    if (m) {
      this.i += m[0].length;
      return { k: 'lit', v: m[0].includes('.') || /e/i.test(m[0]) ? { __float: Number(m[0]) } : Number(m[0]) };
    }
    m = /^(?:'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)")/.exec(s);
    if (m) {
      this.i += m[0].length;
      const raw = m[1] ?? m[2] ?? '';
      return { k: 'lit', v: raw.replace(/\\(.)/g, (_x, c: string) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c) };
    }
    if (this.eat('true')) return { k: 'lit', v: true };
    if (this.eat('false')) return { k: 'lit', v: false };
    if (this.eat('null')) return { k: 'lit', v: null };
    return { k: 'id', name: this.ident() };
  }
  pathLit(): Expr {
    const parts: (string | Expr)[] = [];
    while (this.src[this.i] === '/') {
      this.i++;
      if (this.src.startsWith('$(', this.i)) {
        this.i += 2;
        parts.push(this.expr());
        this.need(')');
      } else {
        const m = /^[A-Za-z0-9_\-().%~@]+/.exec(this.src.slice(this.i));
        if (!m) this.fail('bad path segment');
        // "(default)" is a segment; a trailing ")" belongs to the enclosing call.
        let seg = m[0];
        while (seg.endsWith(')') && (seg.match(/\(/g)?.length ?? 0) < (seg.match(/\)/g)?.length ?? 0)) seg = seg.slice(0, -1);
        this.i += seg.length;
        parts.push(seg);
      }
    }
    return { k: 'path', parts };
  }
}

// ─── values ────────────────────────────────────────────────────────────────────

class RulesError extends Error {}
const err = (m: string): never => {
  throw new RulesError(m);
};
type Ts = { __ib: 'ts'; s: number; n: number; k: string };
type Dur = { __dur: number };
type PathV = { __path: string };
type Diff = { __diff: [Record<string, unknown>, Record<string, unknown>] };
const isTs = (v: unknown): v is Ts => !!v && typeof v === 'object' && (v as Ts).__ib === 'ts';
const isDur = (v: unknown): v is Dur => !!v && typeof v === 'object' && '__dur' in (v as object);
const isPath = (v: unknown): v is PathV => !!v && typeof v === 'object' && '__path' in (v as object);
const isFloat = (v: unknown): v is { __float: number } => !!v && typeof v === 'object' && '__float' in (v as object);
/**
 * Part of a list, known from a query's array-contains (list rules): `x in it`, hasAny and hasAll
 * hold for what it is known to contain; anything else about it is unknown, which denies.
 */
export type KnownElements = { __contains: unknown[] };
const isKnown = (v: unknown): v is KnownElements => !!v && typeof v === 'object' && Array.isArray((v as KnownElements).__contains);
const knownHas = (k: KnownElements, x: unknown): boolean => k.__contains.some((y) => eq(x, y)) || err('the query does not say what else the list holds');
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !(v as { __ib?: unknown }).__ib && !isDur(v) && !isPath(v) && !isFloat(v) && !('__diff' in (v as object)) && !isKnown(v);
const num = (v: unknown): number => (typeof v === 'number' ? v : isFloat(v) ? v.__float : err(`expected a number, got ${typeName(v)}`));
const tsMs = (t: Ts) => t.s * 1000 + Math.floor(t.n / 1e6);
const msTs = (ms: number): Ts => {
  const s = Math.floor(ms / 1000);
  const n = (ms - s * 1000) * 1e6;
  return { __ib: 'ts', s, n, k: tsKey(s, n) };
};

function typeName(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return 'bool';
  if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'float';
  if (isFloat(v)) return 'float';
  if (typeof v === 'string') return 'string';
  if (Array.isArray(v)) return 'list';
  if (isTs(v)) return 'timestamp';
  if (isDur(v)) return 'duration';
  if (isPath(v)) return 'path';
  const t = (v as { __ib?: string }).__ib;
  if (t === 'geo') return 'latlng';
  if (t === 'bytes') return 'bytes';
  if (t === 'ref') return 'path';
  return 'map';
}

function eq(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' || isFloat(a)) return (typeof b === 'number' || isFloat(b)) && num(a) === num(b);
  if (isTs(a) && isTs(b)) return a.k === b.k;
  if (isPath(a) || (a as { __ib?: string })?.__ib === 'ref') return pathStr(a) === pathStr(b);
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => eq(x, b[i]));
  if (isMap(a)) return isMap(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => k in b && eq(a[k], b[k]));
  if (isDur(a)) return isDur(b) && a.__dur === b.__dur;
  return a === b || (a === undefined && b === null) || (a === null && b === undefined);
}
const pathStr = (v: unknown): string | null => (isPath(v) ? v.__path : (v as { __ib?: string; p?: string })?.__ib === 'ref' ? `/databases/(default)/documents/${(v as { p: string }).p}` : null);
function cmp(a: unknown, b: unknown): number {
  if ((typeof a === 'number' || isFloat(a)) && (typeof b === 'number' || isFloat(b))) return num(a) - num(b);
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (isTs(a) && isTs(b)) return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
  if (isDur(a) && isDur(b)) return a.__dur - b.__dur;
  return err(`cannot compare ${typeName(a)} with ${typeName(b)}`);
}

// ─── evaluation ────────────────────────────────────────────────────────────────

export interface RulesDoc {
  data: Record<string, unknown>;
  id: string;
  path: string;
}

export interface RulesRequest {
  method: 'get' | 'list' | 'create' | 'update' | 'delete';
  /** Firestore: /databases/(default)/documents/…  Storage: /b/<bucket>/o/<object path> */
  path: string;
  auth: { uid: string; token: Record<string, unknown> } | null;
  resource: RulesDoc | Record<string, unknown> | null;
  /** request.resource: the document (or object metadata) after the write. */
  requestResource: RulesDoc | Record<string, unknown> | null;
  query?: { limit: number | null; orderBy: string | null } | null;
  /** Firestore get()/exists() for a path like /databases/(default)/documents/users/u1. */
  get?(path: string): RulesDoc | null;
  /** getAfter(): the state after this request's writes (defaults to get). */
  getAfter?(path: string): RulesDoc | null;
  time?: number;
}

type Scope = { vars: Map<string, unknown>; fns: Map<string, Fn>[] };

const docValue = (d: RulesDoc | null): unknown => (d ? { data: d.data, id: d.id, __name__: { __path: d.path } } : null);

function call(scope: Scope, req: RulesRequest, name: string, args: unknown[], depth: number): unknown {
  for (let i = scope.fns.length - 1; i >= 0; i--) {
    const f = scope.fns[i]!.get(name);
    if (!f) continue;
    if (depth > 20) err('function call depth over 20');
    const vars = new Map(scope.vars);
    f.params.forEach((p, j) => vars.set(p, args[j]));
    const inner: Scope = { vars, fns: scope.fns };
    for (const [n, e] of f.lets) vars.set(n, ev(e, inner, req, depth + 1));
    return ev(f.body, inner, req, depth + 1);
  }
  const p = () => pathStr(args[0]) ?? err(`${name}() takes a path`);
  switch (name) {
    case 'get':
      return docValue(req.get?.(p()) ?? null) ?? err(`get(${p()}): no such document`);
    case 'exists':
      return !!req.get?.(p());
    case 'getAfter':
      return docValue((req.getAfter ?? req.get)?.(p()) ?? null) ?? err(`getAfter(${p()}): no such document`);
    case 'existsAfter':
      return !!(req.getAfter ?? req.get)?.(p());
    case 'int':
      return Math.trunc(typeof args[0] === 'string' ? Number(args[0]) : num(args[0]));
    case 'float':
      return { __float: typeof args[0] === 'string' ? Number(args[0]) : num(args[0]) };
    case 'string':
      return typeName(args[0]) === 'string' ? args[0] : isFloat(args[0]) ? String(args[0].__float) : JSON.stringify(args[0]);
    case 'path':
      return { __path: String(args[0]) };
    case 'debug':
      console.log('[rules debug]', JSON.stringify(args[0]));
      return args[0];
  }
  return err(`unknown function ${name}()`);
}

function method(recv: unknown, name: string, args: unknown[]): unknown {
  // namespaces
  if (recv === NS_TIMESTAMP) {
    if (name === 'value') return msTs(num(args[0]));
    if (name === 'date') return msTs(Date.UTC(num(args[0]), num(args[1]) - 1, num(args[2])));
  }
  if (recv === NS_DURATION) {
    if (name === 'value') {
      const unit = String(args[1]);
      const mult = { w: 604800000, d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1, us: 0.001, ns: 1e-6 }[unit] ?? err(`duration unit '${unit}'`);
      return { __dur: num(args[0]) * mult };
    }
    if (name === 'time') return { __dur: ((num(args[0]) * 60 + num(args[1])) * 60 + num(args[2])) * 1000 + num(args[3] ?? 0) / 1e6 };
    if (name === 'abs') return { __dur: Math.abs((args[0] as Dur).__dur) };
  }
  if (recv === NS_MATH) {
    const x = num(args[0]);
    const f = { abs: Math.abs, ceil: Math.ceil, floor: Math.floor, round: Math.round, sqrt: Math.sqrt, isInfinite: (v: number) => !Number.isFinite(v) && !Number.isNaN(v), isNaN: Number.isNaN }[name];
    if (f) return (f as (v: number) => unknown)(x);
    if (name === 'pow') return x ** num(args[1]);
  }
  if (recv === NS_LATLNG && name === 'value') return { __ib: 'geo', lat: num(args[0]), lng: num(args[1]) };
  if (recv === NS_HASHING) err('hashing.* is not supported in the IceBase emulator yet');
  if (typeof recv === 'string') {
    switch (name) {
      case 'size':
        return [...recv].length;
      case 'matches':
        return new RegExp(`^(?:${String(args[0])})$`, 'u').test(recv);
      case 'lower':
        return recv.toLowerCase();
      case 'upper':
        return recv.toUpperCase();
      case 'trim':
        return recv.trim();
      case 'split':
        return recv.split(new RegExp(String(args[0]), 'u'));
      case 'replace':
        return recv.replace(new RegExp(String(args[0]), 'gu'), String(args[1]));
      case 'toUtf8':
        return { __ib: 'bytes', b: Buffer.from(recv).toString('base64') };
    }
  }
  if (isKnown(recv)) {
    const arg = (args[0] ?? []) as unknown[];
    if (name === 'hasAll') return arg.every((x) => knownHas(recv, x));
    if (name === 'hasAny') return arg.some((x) => recv.__contains.some((y) => eq(x, y))) || err('the query does not say what else the list holds');
    return err(`${name}() of a list the query knows only part of`);
  }
  if (Array.isArray(recv)) {
    const has = (x: unknown) => recv.some((y) => eq(x, y));
    const arg = (args[0] ?? []) as unknown[];
    switch (name) {
      case 'size':
        return recv.length;
      case 'hasAll':
        return arg.every(has);
      case 'hasAny':
        return arg.some(has);
      case 'hasOnly':
        return recv.every((x) => arg.some((y) => eq(x, y)));
      case 'join':
        return recv.map(String).join(String(args[0] ?? ''));
      case 'toSet':
        return recv.filter((x, i) => recv.findIndex((y) => eq(x, y)) === i);
      case 'concat':
        return [...recv, ...arg];
      case 'removeAll':
        return recv.filter((x) => !arg.some((y) => eq(x, y)));
      case 'difference':
        return recv.filter((x) => !arg.some((y) => eq(x, y)));
      case 'intersection':
        return recv.filter((x) => arg.some((y) => eq(x, y)));
      case 'union':
        return [...recv, ...arg.filter((y) => !has(y))];
    }
  }
  if (recv && typeof recv === 'object' && '__diff' in recv) {
    const [a, b] = (recv as Diff).__diff;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    const added = [...keys].filter((k) => !(k in b) && k in a);
    const removed = [...keys].filter((k) => k in b && !(k in a));
    const changed = [...keys].filter((k) => k in a && k in b && !eq(a[k], b[k]));
    const unchanged = [...keys].filter((k) => k in a && k in b && eq(a[k], b[k]));
    switch (name) {
      case 'addedKeys':
        return added;
      case 'removedKeys':
        return removed;
      case 'changedKeys':
        return changed;
      case 'unchangedKeys':
        return unchanged;
      case 'affectedKeys':
        return [...added, ...removed, ...changed];
    }
  }
  if (isMap(recv)) {
    switch (name) {
      case 'keys':
        return Object.keys(recv);
      case 'values':
        return Object.values(recv);
      case 'size':
        return Object.keys(recv).length;
      case 'get': {
        const keys = Array.isArray(args[0]) ? (args[0] as string[]) : [String(args[0])];
        let cur: unknown = recv;
        for (const k of keys) {
          if (!isMap(cur) || !(k in cur)) return args[1];
          cur = cur[k];
        }
        return cur;
      }
      case 'diff':
        return { __diff: [recv, (args[0] ?? {}) as Record<string, unknown>] };
    }
  }
  if (isTs(recv)) {
    const d = new Date(tsMs(recv));
    switch (name) {
      case 'toMillis':
        return tsMs(recv);
      case 'year':
        return d.getUTCFullYear();
      case 'month':
        return d.getUTCMonth() + 1;
      case 'day':
        return d.getUTCDate();
      case 'hours':
        return d.getUTCHours();
      case 'minutes':
        return d.getUTCMinutes();
      case 'seconds':
        return d.getUTCSeconds();
      case 'nanos':
        return recv.n;
      case 'dayOfWeek':
        return d.getUTCDay() || 7;
      case 'dayOfYear':
        return Math.floor((d.getTime() - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
      case 'date':
        return msTs(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
      case 'time':
        return { __dur: tsMs(recv) % 86400000 };
    }
  }
  if (isDur(recv)) {
    switch (name) {
      case 'seconds':
        return Math.trunc(recv.__dur / 1000);
      case 'nanos':
        return Math.round((recv.__dur % 1000) * 1e6);
    }
  }
  if (isPath(recv) && name === 'bind') return recv;
  return err(`${typeName(recv)}.${name}() is not available`);
}

const NS_TIMESTAMP = { __ns: 'timestamp' };
const NS_DURATION = { __ns: 'duration' };
const NS_MATH = { __ns: 'math' };
const NS_LATLNG = { __ns: 'latlng' };
const NS_HASHING = { __ns: 'hashing' };

function member(v: unknown, name: string): unknown {
  if (isMap(v) && !('__ns' in v)) {
    if (!(name in v)) err(`Property ${name} is undefined on object`);
    return v[name];
  }
  if (v === null || v === undefined) return err(`Null value error (reading .${name})`);
  return err(`${typeName(v)} has no field ${name}`);
}

const NS_FIRESTORE = { __ns: 'firestore' };

function ev(e: Expr, scope: Scope, req: RulesRequest, depth = 0): unknown {
  switch (e.k) {
    case 'lit':
      return e.v;
    case 'id': {
      if (scope.vars.has(e.name)) return scope.vars.get(e.name);
      switch (e.name) {
        case 'timestamp':
          return NS_TIMESTAMP;
        case 'duration':
          return NS_DURATION;
        case 'math':
          return NS_MATH;
        case 'latlng':
          return NS_LATLNG;
        case 'hashing':
          return NS_HASHING;
        case 'firestore':
          return NS_FIRESTORE;
      }
      return err(`Unknown variable ${e.name}`);
    }
    case 'list':
      return e.items.map((x) => ev(x, scope, req, depth));
    case 'map':
      return Object.fromEntries(e.entries.map(([k, v]) => [String(k.k === 'id' ? k.name : ev(k, scope, req, depth)), ev(v, scope, req, depth)]));
    case 'path':
      return { __path: '/' + e.parts.map((p) => (typeof p === 'string' ? p : String(ev(p, scope, req, depth)))).join('/') };
    case 'member':
      return member(ev(e.obj, scope, req, depth), e.name);
    case 'index': {
      const o = ev(e.obj, scope, req, depth);
      const i = ev(e.index, scope, req, depth);
      if (Array.isArray(o)) return o[num(i) < 0 ? o.length + num(i) : num(i)] ?? err('index out of range');
      if (isPath(o)) return o.__path.split('/').filter(Boolean)[num(i)] ?? err('path index out of range');
      if (isMap(o)) return String(i) in o ? o[String(i)] : err(`Property ${String(i)} is undefined on object`);
      return err(`cannot index ${typeName(o)}`);
    }
    case 'call': {
      const args = () => e.args.map((a) => ev(a, scope, req, depth));
      if (e.fn.k === 'id') return call(scope, req, e.fn.name, args(), depth);
      if (e.fn.k === 'member') {
        const recv = ev(e.fn.obj, scope, req, depth);
        // firestore.get(…) / firestore.exists(…) from storage rules
        if (recv === NS_FIRESTORE) return call({ vars: new Map(), fns: [] }, req, e.fn.name, args(), depth);
        return method(recv, e.fn.name, args());
      }
      return err('not a function');
    }
    case 'unary': {
      const v = ev(e.e, scope, req, depth);
      if (e.op === '!') return typeof v === 'boolean' ? !v : err(`! needs a bool, got ${typeName(v)}`);
      return isFloat(v) ? { __float: -v.__float } : -num(v);
    }
    case 'cond': {
      const c = ev(e.c, scope, req, depth);
      if (typeof c !== 'boolean') err('?: needs a bool');
      return c ? ev(e.a, scope, req, depth) : ev(e.b, scope, req, depth);
    }
    case 'is': {
      const t = typeName(ev(e.e, scope, req, depth));
      const want = e.type === 'number' ? ['int', 'float'] : e.type === 'boolean' ? ['bool'] : e.type === 'set' ? ['list'] : e.type === 'constraint' ? [] : [e.type];
      return want.includes(t);
    }
    case 'bin': {
      if (e.op === '&&') {
        const l = ev(e.l, scope, req, depth);
        if (l === false) return false;
        const r = ev(e.r, scope, req, depth);
        if (typeof l !== 'boolean' || typeof r !== 'boolean') err('&& needs bools');
        return r;
      }
      if (e.op === '||') {
        let l: unknown;
        try {
          l = ev(e.l, scope, req, depth);
        } catch (x) {
          // Firebase: an error on one side of || is ignored when the other side is true.
          if (!(x instanceof RulesError)) throw x;
          const r = ev(e.r, scope, req, depth);
          return r === true ? true : err((x as Error).message);
        }
        if (l === true) return true;
        const r = ev(e.r, scope, req, depth);
        if (typeof l !== 'boolean' || typeof r !== 'boolean') err('|| needs bools');
        return r;
      }
      const l = ev(e.l, scope, req, depth);
      const r = ev(e.r, scope, req, depth);
      switch (e.op) {
        case '==':
          return eq(l, r);
        case '!=':
          return !eq(l, r);
        case '<':
          return cmp(l, r) < 0;
        case '<=':
          return cmp(l, r) <= 0;
        case '>':
          return cmp(l, r) > 0;
        case '>=':
          return cmp(l, r) >= 0;
        case 'in':
          if (Array.isArray(r)) return r.some((x) => eq(l, x));
          if (isKnown(r)) return knownHas(r, l);
          if (isMap(r)) return String(l) in r;
          return err(`in needs a list or map, got ${typeName(r)}`);
        case '+':
          if (typeof l === 'string' && typeof r === 'string') return l + r;
          if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
          if (isTs(l) && isDur(r)) return msTs(tsMs(l) + r.__dur);
          if (isDur(l) && isDur(r)) return { __dur: l.__dur + r.__dur };
          return isFloat(l) || isFloat(r) ? { __float: num(l) + num(r) } : num(l) + num(r);
        case '-':
          if (isTs(l) && isDur(r)) return msTs(tsMs(l) - r.__dur);
          if (isTs(l) && isTs(r)) return { __dur: tsMs(l) - tsMs(r) };
          if (isDur(l) && isDur(r)) return { __dur: l.__dur - r.__dur };
          return isFloat(l) || isFloat(r) ? { __float: num(l) - num(r) } : num(l) - num(r);
        case '*':
          return isFloat(l) || isFloat(r) ? { __float: num(l) * num(r) } : num(l) * num(r);
        case '/': {
          if (num(r) === 0) err('division by zero');
          return isFloat(l) || isFloat(r) ? { __float: num(l) / num(r) } : Math.trunc(num(l) / num(r));
        }
        case '%':
          return num(l) % num(r);
      }
      return err(`unknown operator ${e.op}`);
    }
  }
}

// ─── matching requests to statements ───────────────────────────────────────────

const covers = (methods: string[], m: RulesRequest['method']) =>
  methods.some((x) => x === m || (x === 'read' && (m === 'get' || m === 'list')) || (x === 'write' && (m === 'create' || m === 'update' || m === 'delete')));

function walk(block: Match, segs: string[], vars: Map<string, unknown>, fns: Map<string, Fn>[], out: { allows: Allow[]; scope: Scope }[]): void {
  let i = 0;
  const v = new Map(vars);
  for (let j = 0; j < block.segs.length; j++) {
    const s = block.segs[j]!;
    if (s.rest) {
      v.set(s.name!, { __path: '/' + segs.slice(i).join('/') });
      i = segs.length;
      break;
    }
    if (i >= segs.length) return;
    if (s.lit !== undefined) {
      if (s.lit !== segs[i]) return;
    } else v.set(s.name!, segs[i]);
    i++;
  }
  const scopeFns = [...fns, block.fns];
  const rest = segs.slice(i);
  if (rest.length === 0) out.push({ allows: block.allows, scope: { vars: v, fns: scopeFns } });
  for (const c of block.children) walk(c, rest, v, scopeFns, out);
}

export interface RulesEngine {
  readonly service: string;
  allows(req: RulesRequest): Promise<boolean>;
  /** Why the decision went the way it did (console playground, RUL-5). */
  explain(req: RulesRequest): { allowed: boolean; matched: number; errors: string[] };
}

export function loadRules(source: string, expect: 'firestore' | 'storage'): RulesEngine {
  const { service, root } = new Parser(source).file();
  const want = expect === 'firestore' ? 'cloud.firestore' : 'firebase.storage';
  if (service !== want) throw new IceBaseError('invalid-argument', `rules: expected \`service ${want}\`, found \`service ${service}\``, { reason: 'config' });
  const explain = (req: RulesRequest) => {
    const segs = req.path.split('/').filter(Boolean);
    const hits: { allows: Allow[]; scope: Scope }[] = [];
    for (const c of root.children) walk(c, segs, new Map(), [root.fns], hits);
    const errors: string[] = [];
    let matched = 0;
    const now = msTs(req.time ?? Date.now());
    const reqResource = req.requestResource && 'data' in req.requestResource ? { ...req.requestResource, __name__: { __path: (req.requestResource as RulesDoc).path } } : req.requestResource;
    const resource = req.resource && 'data' in req.resource && 'path' in req.resource ? docValue(req.resource as RulesDoc) : req.resource;
    const request = {
      auth: req.auth ? { uid: req.auth.uid, token: req.auth.token } : null,
      method: req.method,
      path: { __path: req.path },
      time: now,
      resource: reqResource,
      query: req.query ?? null,
    };
    for (const h of hits) {
      for (const a of h.allows) {
        if (!covers(a.methods, req.method)) continue;
        matched++;
        if (!a.cond) return { allowed: true, matched, errors };
        const vars = new Map(h.scope.vars);
        vars.set('request', request);
        vars.set('resource', resource);
        try {
          if (ev(a.cond, { vars, fns: h.scope.fns }, req) === true) return { allowed: true, matched, errors };
        } catch (e) {
          if (!(e instanceof RulesError)) throw e;
          errors.push(e.message);
        }
      }
    }
    return { allowed: false, matched, errors };
  };
  return { service, allows: async (req) => explain(req).allowed, explain };
}
