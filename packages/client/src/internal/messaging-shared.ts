// Cloud Messaging pieces shared by the client, the admin SDK and the IceBase server: typed data
// payloads (config.messaging.messages) to FCM's string map and back, topic names and conditions.
//
// A typed message carries its kind in data[MESSAGE_KIND_KEY]; each declared field is one data key:
// strings (and enums) as they are, everything else as JSON.

import { MESSAGE_KIND_KEY, type MessageKinds } from '../config.ts';
import { IceBaseError } from '../errors.ts';
import { f, validateValue, type Field, type FieldDef } from '../schema.ts';

const plainString = (fd: Field<unknown>) => !fd.nullable && (fd.def.kind === 'string' || fd.def.kind === 'enum' || (fd.def.kind === 'literal' && typeof (fd.def as Extract<FieldDef, { kind: 'literal' }>).value === 'string'));

const bad = (message: string) => new IceBaseError('invalid-argument', message, { reason: 'schema', service: 'messaging' });

/** A typed message's data as FCM's data map; checked against the kind's declaration. */
export function encodeMessageData(kinds: MessageKinds, kind: string, data: unknown): Record<string, string> {
  const fields = kinds[kind];
  if (!fields) throw bad(`message kind '${kind}' is not declared in config.messaging.messages (${Object.keys(kinds).join(', ') || 'none declared'})`);
  validateValue(f.map(fields), data ?? {}, `message '${kind}' data`);
  const out: Record<string, string> = { [MESSAGE_KIND_KEY]: kind };
  for (const [k, fd] of Object.entries(fields)) {
    const v = (data as Record<string, unknown> | undefined)?.[k];
    if (v === undefined) continue;
    out[k] = plainString(fd) ? (v as string) : JSON.stringify(v);
  }
  return out;
}

/** FCM's data map as a typed message: { kind, data }, or the raw map (kind undefined) when it names no declared kind. */
export function decodeMessageData(kinds: MessageKinds, raw: Record<string, string> | undefined): { kind: string | undefined; data: Record<string, unknown> | undefined; error?: string } {
  if (!raw) return { kind: undefined, data: undefined };
  const kind = raw[MESSAGE_KIND_KEY];
  const fields = kind !== undefined ? kinds[kind] : undefined;
  if (!kind || !fields) return { kind: undefined, data: raw };
  const out: Record<string, unknown> = {};
  try {
    for (const [k, fd] of Object.entries(fields)) {
      const s = raw[k];
      if (s === undefined) continue;
      out[k] = plainString(fd) ? s : JSON.parse(s);
    }
    validateValue(f.map(fields), out, `message '${kind}' data`);
  } catch (e) {
    return { kind: undefined, data: raw, error: (e as Error).message };
  }
  return { kind, data: out };
}

/** Check a message before it is sent: a target, string data values, and a typed kind's data. */
export function checkMessage(kinds: MessageKinds, m: Record<string, unknown>, opts: { multicast?: boolean } = {}): void {
  if (!m || typeof m !== 'object') throw bad('a message is an object');
  if (opts.multicast) {
    if (!Array.isArray(m.tokens) || m.tokens.length === 0) throw bad('a multicast message needs tokens');
    if (m.tokens.length > 500) throw bad('a multicast message has at most 500 tokens');
  } else {
    const n = ['token', 'topic', 'condition'].filter((k) => m[k] !== undefined).length;
    if (n !== 1) throw bad('a message needs exactly one of token, topic or condition');
    if (m.topic !== undefined) normalizeTopic(String(m.topic));
    if (m.condition !== undefined) parseCondition(String(m.condition));
  }
  const data = m.data as Record<string, unknown> | undefined;
  if (data !== undefined) {
    if (!data || typeof data !== 'object') throw bad('message data is a map of strings');
    for (const [k, v] of Object.entries(data)) if (typeof v !== 'string') throw bad(`message data.${k}: values are strings`);
    const kind = data[MESSAGE_KIND_KEY] as string | undefined;
    if (kind !== undefined) {
      const d = decodeMessageData(kinds, data as Record<string, string>);
      if (d.kind === undefined) throw bad(d.error ?? `message kind '${kind}' is not declared in config.messaging.messages`);
    } else if (Object.keys(kinds).length) throw bad(`this app declares its message kinds (config.messaging.messages): a message with data names one (${Object.keys(kinds).join(', ')})`);
  }
}

/** '/topics/news' or 'news' → 'news'; refuses what FCM refuses. */
export function normalizeTopic(topic: string): string {
  const t = topic.startsWith('/topics/') ? topic.slice(8) : topic;
  if (!/^[a-zA-Z0-9-_.~%]{1,900}$/.test(t)) throw bad(`'${topic}' is not a valid topic name ([a-zA-Z0-9-_.~%]+)`);
  return t;
}

export type TopicCondition = { t: 'topic'; name: string } | { t: 'not'; x: TopicCondition } | { t: 'and' | 'or'; a: TopicCondition; b: TopicCondition };

/** FCM's topic condition: "'a' in topics && ('b' in topics || !('c' in topics))" (at most five topics). */
export function parseCondition(src: string): TopicCondition {
  const toks = src.match(/'[^']*'|"[^"]*"|&&|\|\||!|\(|\)|in|topics|\S/g) ?? [];
  let i = 0;
  let topics = 0;
  const peek = () => toks[i];
  const fail = (): never => {
    throw bad(`'${src}' is not a topic condition (e.g. "'a' in topics && 'b' in topics")`);
  };
  const atom = (): TopicCondition => {
    const t = toks[i++];
    if (t === '!') return { t: 'not', x: atom() };
    if (t === '(') {
      const x = or();
      if (toks[i++] !== ')') fail();
      return x;
    }
    if (!t || !/^['"]/.test(t) || toks[i++] !== 'in' || toks[i++] !== 'topics') return fail();
    topics++;
    return { t: 'topic', name: normalizeTopic(t.slice(1, -1)) };
  };
  const and = (): TopicCondition => {
    let a = atom();
    while (peek() === '&&') {
      i++;
      a = { t: 'and', a, b: atom() };
    }
    return a;
  };
  const or = (): TopicCondition => {
    let a = and();
    while (peek() === '||') {
      i++;
      a = { t: 'or', a, b: and() };
    }
    return a;
  };
  const c = or();
  if (i !== toks.length) fail();
  if (topics > 5) throw bad(`'${src}': a condition names at most five topics`);
  return c;
}

export function matchCondition(c: TopicCondition, topics: ReadonlySet<string>): boolean {
  switch (c.t) {
    case 'topic':
      return topics.has(c.name);
    case 'not':
      return !matchCondition(c.x, topics);
    case 'and':
      return matchCondition(c.a, topics) && matchCondition(c.b, topics);
    case 'or':
      return matchCondition(c.a, topics) || matchCondition(c.b, topics);
  }
}

/** The topics a condition names. */
export function conditionTopics(c: TopicCondition): string[] {
  return c.t === 'topic' ? [c.name] : c.t === 'not' ? conditionTopics(c.x) : [...conditionTopics(c.a), ...conditionTopics(c.b)];
}
