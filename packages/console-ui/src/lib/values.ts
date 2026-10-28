// Firestore values as the console's API carries them (JSON with { __ts }, { __ref }, { __geo },
// { __bytes }), and their types — the type marks every data view shares.

export type Kind = 'string' | 'number' | 'boolean' | 'null' | 'timestamp' | 'reference' | 'geopoint' | 'bytes' | 'map' | 'array';

export function kindOf(v: unknown): Kind {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'string') return 'string';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'boolean';
  if (Array.isArray(v)) return 'array';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    if (typeof o.__ts === 'string') return 'timestamp';
    if (typeof o.__ref === 'string') return 'reference';
    if (Array.isArray(o.__geo)) return 'geopoint';
    if (typeof o.__bytes === 'string') return 'bytes';
  }
  return 'map';
}

export const KIND_LABEL: Record<Kind, string> = { string: 'string', number: 'number', boolean: 'boolean', null: 'null', timestamp: 'timestamp', reference: 'reference', geopoint: 'geopoint', bytes: 'bytes', map: 'map', array: 'array' };

/** One line for a value: what the trees and tables show. */
export function preview(v: unknown, max = 80): string {
  const k = kindOf(v);
  let s: string;
  switch (k) {
    case 'string':
      s = JSON.stringify(v);
      break;
    case 'timestamp': {
      const d = new Date((v as { __ts: string }).__ts);
      s = isNaN(+d) ? (v as { __ts: string }).__ts : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
      break;
    }
    case 'reference':
      s = (v as { __ref: string }).__ref;
      break;
    case 'geopoint':
      s = (v as { __geo: number[] }).__geo.map((n) => n.toFixed(5)).join(', ');
      break;
    case 'bytes':
      s = `${Math.round(((v as { __bytes: string }).__bytes.length * 3) / 4)} bytes`;
      break;
    case 'map':
      s = `{${Object.keys(v as object).length} fields}`;
      break;
    case 'array':
      s = `[${(v as unknown[]).length} items]`;
      break;
    default:
      s = String(v);
  }
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Milliseconds that look like a date (the Realtime Database and many apps store time that way). */
export const looksLikeMillis = (n: unknown) => typeof n === 'number' && n > 946684800000 && n < 4102444800000;

export const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function fmtWhen(s: string | null | undefined): string {
  if (!s) return '—';
  const d = new Date(s);
  if (isNaN(+d)) return s;
  const diff = Date.now() - +d;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return d.toLocaleDateString(undefined, { dateStyle: 'medium' });
}
