// icebase/auth/server — the server half of custom auth: one fetch-style handler
// (Request → Response) that IceBase deploys as the `icebaseAuth` function in firebase mode
// and mounts on the IceBase server in emulator mode. Everything a developer would otherwise
// build by hand: challenges, rate limits, blocks, the approval page, the reset / verify pages,
// the Google and Apple OAuth dances, hosted sign-in for many apps (SSO with PKCE), and minting
// the Firebase custom token at the end.
//
// The design follows VardayiniDairy's sign-in (challenge.ts, limits.ts): secrets stored only
// as SHA-256, compared in constant time, single use, short-lived, attempt-capped; approve and
// collect are different secrets so somebody reading the mailbox can approve but not sign in.

import { createHash, createPrivateKey, createPublicKey, randomBytes, randomInt, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify, type JsonWebKey } from 'node:crypto';
import type { Auth as AdminAuthNative, CreateRequest, UpdateRequest, UserRecord } from 'firebase-admin/auth';
import type { IceBaseApp } from '@panth977/icebase/app';
import { readEnv, type AnyConfig, type CustomAuthConfig } from '@panth977/icebase/config';
import { emailSender, phoneSender, type EmailMessage, type EmailSendFn, type PhoneSendFn } from './internal/custom-auth/senders.ts';
import { authEndpoint, STORE_DEFAULT_PATH, type AuthErrorCode } from '@panth977/icebase/internal';
import { memoryStore, rtdbStore, type Store } from './internal/custom-auth/store.ts';
import { esc, page as basePage, templatesFor, type Templates } from './internal/custom-auth/templates.ts';
import { Buffer } from 'node:buffer';

export { outbox } from './internal/custom-auth/senders.ts';
export type { EmailMessage, PhoneMessage, EmailSendFn, PhoneSendFn } from './internal/custom-auth/senders.ts';
export type { Store } from './internal/custom-auth/store.ts';
export { memoryStore } from './internal/custom-auth/store.ts';
export type { Brand, Templates, TemplateVars } from './internal/custom-auth/templates.ts';
export { authEndpoint } from '@panth977/icebase/internal';

/** Your own email sender (config: email.sender = 'handler'). */
export const defineEmailSender = (fn: EmailSendFn): EmailSendFn => fn;
/** Your own phone sender (config: phone.sender = 'handler'). */
export const definePhoneSender = (fn: PhoneSendFn): PhoneSendFn => fn;

/** The admin Auth calls custom auth needs (firebase-admin's Auth fits). */
export type AuthDirectory = Pick<AdminAuthNative, 'getUserByEmail' | 'getUserByPhoneNumber' | 'getUser' | 'createUser' | 'updateUser' | 'createCustomToken' | 'verifyIdToken' | 'revokeRefreshTokens'>;

/** Who a new user is, as custom auth proved it: the verified email / phone, or the Google / Apple subject id. */
export interface NewUserIdentity {
  email?: string;
  phone?: string;
  google?: string;
  apple?: string;
}

/** How a custom token is being minted. */
export type SignInMethod = 'email' | 'phone' | 'google' | 'apple' | 'sso';
export interface SignInContext {
  method: SignInMethod;
  /** SSO: the app (config.auth.custom.sso.clients key) the person is signing into. */
  client?: string;
  /** SSO: the session id (also in the token as the `sid` claim). */
  sid?: string;
}

export interface AuthHandlerOptions {
  /** An admin app (initializeAdminApp); used for the default directory and store. */
  app?: IceBaseApp;
  /** The user directory. Default: getAdminAuth(app). */
  directory?: AuthDirectory;
  /** The security store. Default: the Realtime Database named in config.auth.custom.security.store. */
  store?: Store;
  senders?: { email?: EmailSendFn; phone?: PhoneSendFn };
  templates?: Partial<Templates>;
  /**
   * The uid of a user custom auth is about to create (email, phone, Google, Apple) — e.g. one derived
   * from the email, so people keep the uid an older system gave them. When a user with that uid
   * already exists, it is that user: the verified email / phone is set on it. undefined: Firebase picks.
   * The functions source's `newUserUid` export, when deployed by IceBase.
   */
  newUserUid?: (identity: NewUserIdentity) => string | undefined | Promise<string | undefined>;
  /**
   * Claims merged into every custom token custom auth mints (e.g. { role: 'authenticated', email }).
   * The functions source's `signInClaims` export, when deployed by IceBase.
   */
  signInClaims?: (user: UserRecord, ctx: SignInContext) => Record<string, unknown> | undefined | Promise<Record<string, unknown> | undefined>;
  /** The fetch used to reach Google and Apple (tests fake it). Default: the global fetch. */
  fetch?: typeof fetch;
  /** Clock, for tests. */
  now?: () => number;
}

/** One app session made by SSO sign-in (sessions/<uid>/<sid> in the security store). */
export interface SsoSession {
  sid: string;
  client: string;
  clientName: string;
  device: string;
  ip: string | null;
  createdAt: number;
  lastSeenAt: number;
  revoked: boolean;
  revokedAt?: number;
}

type Purpose = 'signIn' | 'passwordReset' | 'verifyEmail';
interface Challenge {
  channel: 'email' | 'phone';
  purpose: Purpose;
  mode: 'approval' | 'link' | 'code';
  identifier: string;
  uid?: string;
  codeHash?: string;
  approvalHash?: string;
  clientHash?: string;
  linkHash?: string;
  device: string;
  deviceSig: string;
  ip: string | null;
  site: string;
  state: 'pending' | 'approved' | 'revoked';
  attempts: number;
  claimed?: number;
  expiresAt: number;
  createdAt: number;
}

/** What the audit trail records. */
export type AuditEvent = 'start' | 'limited' | 'wrong-code' | 'burned' | 'refused-blocked' | 'blocked' | 'signed-in';
export interface AuditEntry {
  at: number;
  event: AuditEvent;
  channel?: 'email' | 'phone';
  ip?: string;
  device?: string;
}

class Fail extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
    readonly status = 400,
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const short = (s: string) => sha(s).slice(0, 24);
const secret = () => randomBytes(24).toString('base64url');
const same = (hash: string | undefined, value: string) => {
  if (!hash) return false;
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(sha(value), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164 = /^\+[1-9]\d{7,14}$/;

/** The security store of an admin app: the Realtime Database instance config.auth.custom.security.store names. */
async function appStore(config: AnyConfig, app: IceBaseApp): Promise<Store> {
  const sec = config.auth?.custom?.security ?? {};
  const [{ getDatabase, getDatabaseWithUrl }, { nativeAdminApp }] = await Promise.all([import('firebase-admin/database'), import('./internal/firebase-admin-app.ts')]);
  const instance = sec.store?.database && sec.store.database !== 'default' ? `https://${sec.store.database}.firebaseio.com` : undefined;
  return rtdbStore(instance ? getDatabaseWithUrl(instance, nativeAdminApp(app)) : getDatabase(nativeAdminApp(app)));
}

/** A readable device name from a user agent: "Chrome on macOS". */
export function describeDevice(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'a browser';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'an unknown system';
  return `${browser} on ${os}`;
}

/**
 * Realtime Database rules for the store path: nobody reads or writes it, except one sign-in's status
 * word, and an SSO session's `revoked` flag for its own user (so an app can listen for its revocation).
 */
export function customAuthDatabaseRules(config: AnyConfig): Record<string, unknown> {
  const path = config.auth?.custom?.security?.store?.path ?? STORE_DEFAULT_PATH;
  const leaf: Record<string, unknown> = {
    '.read': false,
    '.write': false,
    signin: { $id: { '.read': true } },
    sessions: { $uid: { $sid: { revoked: { '.read': 'auth != null && auth.uid == $uid' } } } },
  };
  return path
    .split('/')
    .filter(Boolean)
    .reverse()
    .reduce<Record<string, unknown>>((acc, seg) => ({ [seg]: acc }), leaf);
}

export function createAuthHandler(config: AnyConfig, env: string, opts: AuthHandlerOptions = {}): (req: Request) => Promise<Response> {
  const custom: CustomAuthConfig = config.auth?.custom ?? {};
  const sec = custom.security ?? {};
  const root = (sec.store?.path ?? STORE_DEFAULT_PATH).replace(/^\/|\/$/g, '');
  const ttlMs = (sec.challenge?.ttlMinutes ?? 10) * 60_000;
  const maxAttempts = sec.challenge?.maxAttempts ?? 5;
  const blockMs = (sec.blockMinutes ?? 5) * 60_000;
  const site = custom.site ?? config.name;
  const now = opts.now ?? Date.now;
  // config.auth.custom.brand: the default messages and IceBase's own pages in the app's look.
  const T: Templates = { ...templatesFor(custom.brand), ...opts.templates };
  const page = (title: string, body: string, script = '') => basePage(title, body, script, custom.brand);
  const endpoint = authEndpoint(config, env, opts.app);
  const selfOrigin = (() => {
    try {
      return new URL(endpoint).origin;
    } catch {
      return null;
    }
  })();
  const actionUrl = custom.email?.actionUrl ?? `${endpoint}/action`;

  // Lazily, so a handler can be built at import time in a functions bundle.
  let dir: AuthDirectory | undefined = opts.directory;
  let store: Store | undefined = opts.store;
  const directory = async (): Promise<AuthDirectory> => {
    if (dir) return dir;
    if (!opts.app) throw new Fail('auth/internal-error', 'createAuthHandler needs { app } (an admin app) or { directory }', 500);
    const { getAdminAuth } = await import('./admin.ts');
    return (dir = getAdminAuth(opts.app) as unknown as AuthDirectory);
  };
  const db = async (): Promise<Store> => {
    if (store) return store;
    if (!opts.app) return (store = memoryStore());
    return (store = await appStore(config, opts.app));
  };

  const sendEmail = (): EmailSendFn => {
    const s = custom.email?.sender;
    if (!s) throw new Fail('auth/operation-not-allowed', 'custom email auth is not configured', 400);
    if (s === 'handler') {
      if (!opts.senders?.email) throw new Fail('auth/internal-error', "config.auth.custom.email.sender is 'handler' but createAuthHandler got no senders.email", 500);
      return opts.senders.email;
    }
    return opts.senders?.email ?? emailSender(s);
  };
  const sendPhone = (): PhoneSendFn => {
    const s = custom.phone?.sender;
    if (!s) throw new Fail('auth/operation-not-allowed', 'custom phone auth is not configured', 400);
    if (s === 'handler') {
      if (!opts.senders?.phone) throw new Fail('auth/internal-error', "config.auth.custom.phone.sender is 'handler' but createAuthHandler got no senders.phone", 500);
      return opts.senders.phone;
    }
    return opts.senders?.phone ?? phoneSender(s);
  };

  // ── rate limits ────────────────────────────────────────────────────────────

  const hit = async (rule: string, key: string, limit: number | undefined, windowMs: number) => {
    if (!limit) return;
    const r = await (await db()).transaction<{ n: number; until: number }>(`${root}/rl/${rule}/${short(key)}`, (cur) => {
      const t = now();
      if (!cur || cur.until <= t) return { n: 1, until: t + windowMs };
      return { n: cur.n + 1, until: cur.until };
    });
    if (r.value && r.value.n > limit) throw new Fail('auth/too-many-requests', 'Too many attempts. Try again later.', 429, Math.max(1, Math.ceil((r.value.until - now()) / 1000)));
  };
  const H = 3_600_000;
  const limitStart = async (channel: 'email' | 'phone', identifier: string, ctx: { ip: string | null; device: string }) => {
    const l = sec.limits ?? {};
    try {
      await hit('id-hour', identifier, l.perIdentifier?.perHour ?? 5, H);
      await hit('id-day', identifier, l.perIdentifier?.perDay ?? 20, 24 * H);
      if (ctx.ip) await hit('ip-hour', ctx.ip, l.perIp?.perHour ?? 30, H);
      const global = channel === 'phone' ? l.global?.phoneSendsPerDay : l.global?.emailSendsPerDay;
      await hit(`global-${channel}`, 'all', global, 24 * H);
    } catch (e) {
      await audit(identifier, 'limited', { channel, ...ctx });
      throw e;
    }
    await audit(identifier, 'start', { channel, ...ctx });
  };
  const blockKey = (identifier: string, deviceSig: string) => `${root}/blocks/${short(identifier)}_${deviceSig}`;

  // ── audit trail: starts, failures and blocks per identifier (getAuthSecurity(app).listAttempts) ──

  // Keys sort in the order events happened: time-based, and strictly increasing within this instance.
  let lastKey = 0;
  const audit = async (identifier: string, event: AuditEvent, at: { channel?: 'email' | 'phone'; ip?: string | null; device?: string } = {}) => {
    const t = now();
    const k = (lastKey = Math.max(t, lastKey + 1));
    const entry: AuditEntry = { at: t, event, ...(at.channel ? { channel: at.channel } : {}), ...(at.ip ? { ip: at.ip } : {}), ...(at.device ? { device: at.device } : {}) };
    await (await db()).set(`${root}/audit/${short(identifier)}/${k.toString(36).padStart(9, '0')}${randomBytes(3).toString('hex')}`, entry);
  };

  // ── challenges ─────────────────────────────────────────────────────────────

  const issue = async (c: Omit<Challenge, 'state' | 'attempts' | 'expiresAt' | 'createdAt'>): Promise<string> => {
    const id = randomBytes(15).toString('base64url');
    const t = now();
    const full: Challenge = { ...c, state: 'pending', attempts: 0, expiresAt: t + ttlMs, createdAt: t };
    const s = await db();
    await s.set(`${root}/challenge/${id}`, JSON.parse(JSON.stringify(full)));
    if (c.mode === 'approval') await s.set(`${root}/signin/${id}`, { state: 'pending', approvedAt: null, expiresAt: full.expiresAt });
    return id;
  };
  const load = async (id: string): Promise<Challenge> => {
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) throw new Fail('auth/invalid-action-code', 'This link or code is not valid.');
    const c = await (await db()).get<Challenge>(`${root}/challenge/${id}`);
    if (!c) throw new Fail('auth/invalid-action-code', 'This link or code is not valid or was already used.');
    if (c.expiresAt <= now()) throw new Fail(c.channel === 'phone' || c.mode === 'code' ? 'auth/code-expired' : 'auth/expired-action-code', 'This link or code has expired. Ask for a new one.');
    return c;
  };
  const burn = async (id: string) => {
    const s = await db();
    await s.remove(`${root}/challenge/${id}`);
    await s.remove(`${root}/signin/${id}`);
  };
  /** One attempt at a code; throws on a wrong one, burns after too many. */
  const attempt = async (id: string, code: string): Promise<Challenge> => {
    const c = await load(id);
    if (!/^\d{4,10}$/.test(code)) throw new Fail('auth/invalid-verification-code', 'The code is not valid.');
    if (same(c.codeHash, code)) return c;
    const r = await (await db()).transaction<Challenge>(`${root}/challenge/${id}`, (cur) => (cur ? { ...cur, attempts: cur.attempts + 1 } : cur));
    await audit(c.identifier, 'wrong-code', { channel: c.channel, ip: c.ip, device: c.device });
    if ((r.value?.attempts ?? maxAttempts) >= maxAttempts) {
      await audit(c.identifier, 'burned', { channel: c.channel, ip: c.ip, device: c.device });
      await burn(id);
      throw new Fail('auth/too-many-requests', 'Too many wrong codes. Ask for a new one.', 429);
    }
    throw new Fail('auth/invalid-verification-code', 'The code is not right.');
  };
  /** A token `<id>.<secret>` → the challenge it opens. */
  const open = async (token: string, field: 'approvalHash' | 'linkHash'): Promise<[string, Challenge]> => {
    const [id, s] = token.split('.');
    if (!id || !s) throw new Fail('auth/invalid-action-code', 'This link is not valid.');
    const c = await load(id);
    if (!same(c[field], s)) throw new Fail('auth/invalid-action-code', 'This link is not valid.');
    return [id, c];
  };

  // ── users ──────────────────────────────────────────────────────────────────

  const notFound = (e: unknown) => (e as { code?: string }).code === 'auth/user-not-found';
  const getUserOrNull = async (uid: string): Promise<UserRecord | null> => {
    try {
      return await (await directory()).getUser(uid);
    } catch (e) {
      if (!notFound(e)) throw e;
      return null;
    }
  };
  /**
   * A new user for a proven identity — with the uid opts.newUserUid picks, if it does. That uid may
   * already be taken by a user made before this sign-in method (an older system's uid derived from
   * the email, with no email on the record): then it is that user, and what was just proven is set on it.
   */
  const createFor = async (identity: NewUserIdentity, props: CreateRequest): Promise<UserRecord> => {
    const d = await directory();
    const uid = opts.newUserUid ? await opts.newUserUid(identity) : undefined;
    if (!uid) return d.createUser(props);
    let existing = await getUserOrNull(uid);
    if (!existing) {
      try {
        return await d.createUser({ ...props, uid });
      } catch (e) {
        if ((e as { code?: string }).code !== 'auth/uid-already-exists') throw e;
        existing = await d.getUser(uid);
      }
    }
    const patch: UpdateRequest = {};
    if (props.email && props.emailVerified && (existing.email?.toLowerCase() !== props.email || !existing.emailVerified)) Object.assign(patch, { email: props.email, emailVerified: true });
    if (props.phoneNumber && existing.phoneNumber !== props.phoneNumber) patch.phoneNumber = props.phoneNumber;
    if (props.displayName && !existing.displayName) patch.displayName = props.displayName;
    if (props.photoURL && !existing.photoURL) patch.photoURL = props.photoURL;
    return Object.keys(patch).length ? d.updateUser(uid, patch) : existing;
  };
  const userForEmail = async (email: string): Promise<UserRecord> => {
    const d = await directory();
    let u: UserRecord;
    try {
      u = await d.getUserByEmail(email);
      if (!u.emailVerified) u = await d.updateUser(u.uid, { emailVerified: true });
    } catch (e) {
      if (!notFound(e)) throw e;
      u = await createFor({ email }, { email, emailVerified: true });
    }
    return u;
  };
  const userForPhone = async (phone: string): Promise<UserRecord> => {
    const d = await directory();
    try {
      return await d.getUserByPhoneNumber(phone);
    } catch (e) {
      if (!notFound(e)) throw e;
      return createFor({ phone }, { phoneNumber: phone });
    }
  };
  /** The custom token for a user: opts.signInClaims merged in, then `extra` (SSO's sid / client). */
  const token = async (u: UserRecord, ctx: SignInContext, extra: Record<string, unknown> = {}) => {
    if (u.disabled) throw new Fail('auth/user-disabled', 'This account has been disabled.', 403);
    const claims = { ...((opts.signInClaims && (await opts.signInClaims(u, ctx))) || {}), ...extra };
    return (await directory()).createCustomToken(u.uid, Object.keys(claims).length ? claims : undefined);
  };
  /** Google / Apple: identity link → verified email → a new user (newUserUid). */
  const oauthUser = async (provider: 'google' | 'apple', sub: string, p: { email?: string; emailVerified: boolean; name?: string; picture?: string }): Promise<UserRecord> => {
    const s = await db();
    const d = await directory();
    const link = `${root}/identities/${provider}/${short(sub)}`;
    const linked = await s.get<string>(link);
    let user = linked ? await getUserOrNull(linked) : null;
    const email = p.email?.toLowerCase();
    if (!user && email && p.emailVerified) {
      try {
        user = await d.getUserByEmail(email);
      } catch (e) {
        if (!notFound(e)) throw e;
      }
    }
    if (!user) {
      user = await createFor(
        { [provider]: sub, ...(email && p.emailVerified ? { email } : {}) },
        { ...(email ? { email, emailVerified: p.emailVerified } : {}), ...(p.name ? { displayName: p.name } : {}), ...(p.picture ? { photoURL: p.picture } : {}) },
      );
    } else if (p.name && !user.displayName) {
      // Apple sends the name only the first time: keep it when the account has none.
      user = await d.updateUser(user.uid, { displayName: p.name });
    }
    if (linked !== user.uid) await s.set(link, user.uid);
    return user;
  };

  // ── checks on input ────────────────────────────────────────────────────────

  const checkEmail = (raw: unknown): string => {
    const email = String(raw ?? '').trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) throw new Fail('auth/invalid-email', 'That email address is not valid.');
    const domains = sec.allow?.emailDomains;
    if (domains && !domains.includes('*') && !domains.includes(email.split('@')[1]!)) throw new Fail('auth/operation-not-allowed', 'Sign-in with this email domain is not allowed.', 403);
    return email;
  };
  const checkPhone = (raw: unknown): string => {
    const phone = String(raw ?? '').replace(/[\s()-]/g, '');
    if (!E164.test(phone)) throw new Fail('auth/invalid-phone-number', 'Use the full number with country code, e.g. +919812345678.');
    const prefixes = sec.allow?.phonePrefixes;
    if (prefixes && !prefixes.some((p) => phone.startsWith(p))) throw new Fail('auth/operation-not-allowed', 'Sign-in with numbers from this country is not allowed.', 403);
    return phone;
  };
  const code = (len: number) => String(randomInt(0, 10 ** len)).padStart(len, '0');
  const minutes = Math.round(ttlMs / 60_000);
  // Where a sign-in may hand its result: https on an authorized domain, http on this machine only,
  // or an app's own scheme listed in auth.authorizedSchemes (a native app's callback). The scheme is
  // checked, not only the host: `evil-app://localhost` must not receive a token.
  const allowedOrigin = (origin: string): boolean => {
    try {
      const u = new URL(origin);
      const scheme = u.protocol.replace(/:$/, '').toLowerCase();
      if ((config.auth?.authorizedSchemes ?? []).some((x) => x.toLowerCase() === scheme)) return true;
      const host = u.hostname;
      const local = host === 'localhost' || host === '127.0.0.1';
      if (!(scheme === 'https' || (scheme === 'http' && local))) return false;
      const pid = config.firebase?.projectId;
      const ok = ['localhost', '127.0.0.1', ...(pid ? [`${pid}.web.app`, `${pid}.firebaseapp.com`] : []), ...(config.auth?.authorizedDomains ?? [])];
      return ok.some((d) => host === d || host.endsWith(`.${d}`));
    } catch {
      return false;
    }
  };
  const withParam = (url: string, params: Record<string, string>) => {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  };

  // ── routes ─────────────────────────────────────────────────────────────────

  interface Ctx {
    ip: string | null;
    ua: string;
    device: string;
    deviceSig: string;
    origin: string | null;
  }

  const send = async (m: Omit<EmailMessage, 'rendered' | 'site' | 'minutes'>, tpl: keyof Omit<Templates, 'phoneCode'>) => {
    await sendEmail()({ ...m, site, minutes, rendered: T[tpl]({ site, email: m.to, ...(m.link ? { link: m.link } : {}), ...(m.code ? { code: m.code } : {}), device: m.device, minutes }) });
  };

  const routes: Record<string, (body: Record<string, unknown>, ctx: Ctx, url: URL) => Promise<unknown>> = {
    // email sign-in: approval | link | code
    async 'POST /email/start'(b, ctx) {
      const email = checkEmail(b.email);
      if (await (await db()).get(blockKey(email, ctx.deviceSig))) {
        const until = (await (await db()).get<number>(blockKey(email, ctx.deviceSig)))!;
        if (until > now()) {
          await audit(email, 'refused-blocked', { channel: 'email', ip: ctx.ip, device: ctx.device });
          throw new Fail('auth/too-many-requests', 'This device was turned away for this account a moment ago. Try again later.', 429, Math.ceil((until - now()) / 1000));
        }
      }
      await limitStart('email', email, ctx);
      const mode = custom.email?.signIn ?? 'link';
      if (mode === 'approval') {
        const approval = secret();
        const client = secret();
        const id = await issue({ channel: 'email', purpose: 'signIn', mode, identifier: email, approvalHash: sha(approval), clientHash: sha(client), device: ctx.device, deviceSig: ctx.deviceSig, ip: ctx.ip, site });
        await send({ kind: 'signIn', to: email, link: `${endpoint}/email/page?t=${id}.${approval}`, device: ctx.device }, 'signInApproval');
        return { mode, signinId: id, clientSecret: client, expiresAt: now() + ttlMs };
      }
      if (mode === 'code') {
        const c = code(6);
        const id = await issue({ channel: 'email', purpose: 'signIn', mode, identifier: email, codeHash: sha(c), device: ctx.device, deviceSig: ctx.deviceSig, ip: ctx.ip, site });
        await send({ kind: 'signIn', to: email, code: c, device: ctx.device }, 'signInCode');
        return { mode, signinId: id, expiresAt: now() + ttlMs };
      }
      const continueUrl = String(b.continueUrl ?? '');
      if (!continueUrl || !allowedOrigin(continueUrl)) throw new Fail('auth/unauthorized-domain', 'The continue URL is not on an authorized domain (config.auth.authorizedDomains).');
      const s = secret();
      const id = await issue({ channel: 'email', purpose: 'signIn', mode, identifier: email, linkHash: sha(s), device: ctx.device, deviceSig: ctx.deviceSig, ip: ctx.ip, site });
      await send({ kind: 'signIn', to: email, link: withParam(continueUrl, { icebase_link: `${id}.${s}` }), device: ctx.device }, 'signInLink');
      return { mode, expiresAt: now() + ttlMs };
    },
    async 'POST /email/link'(b) {
      const email = checkEmail(b.email);
      const [id, c] = await open(String(b.token ?? ''), 'linkHash');
      if (c.identifier !== email) throw new Fail('auth/invalid-action-code', 'This link was sent to a different email address.');
      await burn(id);
      await audit(email, 'signed-in', { channel: 'email', ip: c.ip, device: c.device });
      return { token: await token(await userForEmail(email), { method: 'email' }) };
    },
    async 'POST /email/code'(b) {
      const id = String(b.signinId ?? '');
      const c = await attempt(id, String(b.code ?? ''));
      await burn(id);
      await audit(c.identifier, 'signed-in', { channel: 'email', ip: c.ip, device: c.device });
      return { token: await token(await userForEmail(c.identifier), { method: 'email' }) };
    },
    async 'POST /email/collect'(b) {
      const id = String(b.signinId ?? '');
      let c: Challenge;
      try {
        c = await load(id);
      } catch (e) {
        if (e instanceof Fail && e.code === 'auth/expired-action-code') return { state: 'expired' };
        throw e;
      }
      if (!same(c.clientHash, String(b.clientSecret ?? ''))) throw new Fail('auth/invalid-action-code', 'This sign-in belongs to another tab.', 403);
      if (c.state === 'revoked') return { state: 'revoked' };
      if (c.state !== 'approved') return { state: 'pending' };
      // A double collect gets `busy`, not a second session.
      const claim = await (await db()).transaction<Challenge>(`${root}/challenge/${id}`, (cur) => (cur && !cur.claimed ? { ...cur, claimed: now() } : undefined));
      if (!claim.committed || !claim.value?.claimed) return { state: 'busy' };
      try {
        const t = await token(await userForEmail(c.identifier), { method: 'email' });
        await burn(id);
        await audit(c.identifier, 'signed-in', { channel: 'email', ip: c.ip, device: c.device });
        return { state: 'approved', token: t };
      } catch (e) {
        await (await db()).update(`${root}/challenge/${id}`, { claimed: null });
        throw e;
      }
    },
    async 'POST /email/approve'(b) {
      const [id, c] = await open(String(b.t ?? ''), 'approvalHash');
      if (c.state !== 'pending') return { state: c.state };
      const s = await db();
      await s.update(`${root}/challenge/${id}`, { state: 'approved' });
      await s.update(`${root}/signin/${id}`, { state: 'approved', approvedAt: now() });
      return { state: 'approved' };
    },
    async 'POST /email/reject'(b) {
      const [id, c] = await open(String(b.t ?? ''), 'approvalHash');
      const s = await db();
      await s.update(`${root}/challenge/${id}`, { state: 'revoked' });
      await s.update(`${root}/signin/${id}`, { state: 'revoked' });
      await s.set(blockKey(c.identifier, c.deviceSig), now() + blockMs);
      await audit(c.identifier, 'blocked', { channel: c.channel, ip: c.ip, device: c.device });
      return { state: 'revoked' };
    },
    async 'POST /email/cancel'(b) {
      const id = String(b.signinId ?? '');
      const c = await (await db()).get<Challenge>(`${root}/challenge/${id}`);
      if (c && same(c.clientHash, String(b.clientSecret ?? ''))) await burn(id);
      return { ok: true };
    },

    // password reset and email verification (Firebase's action-code shape: mode + oobCode)
    async 'POST /reset/start'(b, ctx) {
      const email = checkEmail(b.email);
      await limitStart('email', email, ctx);
      let uid: string | undefined;
      try {
        uid = (await (await directory()).getUserByEmail(email)).uid;
      } catch (e) {
        if (!notFound(e)) throw e;
      }
      // Same answer either way: this endpoint must not tell who has an account.
      if (!uid) return { ok: true };
      const s = secret();
      const id = await issue({ channel: 'email', purpose: 'passwordReset', mode: 'link', identifier: email, uid, linkHash: sha(s), device: ctx.device, deviceSig: ctx.deviceSig, ip: ctx.ip, site });
      const params: Record<string, string> = { mode: 'resetPassword', oobCode: `${id}.${s}` };
      if (typeof b.continueUrl === 'string' && allowedOrigin(b.continueUrl)) params.continueUrl = b.continueUrl;
      await send({ kind: 'passwordReset', to: email, link: withParam(actionUrl, params), device: ctx.device }, 'passwordReset');
      return { ok: true };
    },
    async 'POST /reset/check'(b) {
      const [, c] = await open(String(b.oobCode ?? ''), 'linkHash');
      if (c.purpose !== 'passwordReset') throw new Fail('auth/invalid-action-code', 'This link is not a password reset link.');
      return { email: c.identifier };
    },
    async 'POST /reset/confirm'(b) {
      const [id, c] = await open(String(b.oobCode ?? ''), 'linkHash');
      if (c.purpose !== 'passwordReset' || !c.uid) throw new Fail('auth/invalid-action-code', 'This link is not a password reset link.');
      const pw = String(b.newPassword ?? '');
      if (pw.length < 6) throw new Fail('auth/weak-password', 'Use at least 6 characters.');
      await (await directory()).updateUser(c.uid, { password: pw });
      await burn(id);
      return { email: c.identifier };
    },
    async 'POST /verify/start'(b, ctx) {
      let decoded: { uid: string; email?: string };
      try {
        decoded = await (await directory()).verifyIdToken(String(b.idToken ?? ''));
      } catch {
        throw new Fail('auth/invalid-id-token', 'Sign in again.', 401);
      }
      const email = decoded.email;
      if (!email) throw new Fail('auth/invalid-email', 'This account has no email address.');
      await limitStart('email', email, ctx);
      const s = secret();
      const id = await issue({ channel: 'email', purpose: 'verifyEmail', mode: 'link', identifier: email, uid: decoded.uid, linkHash: sha(s), device: ctx.device, deviceSig: ctx.deviceSig, ip: ctx.ip, site });
      const params: Record<string, string> = { mode: 'verifyEmail', oobCode: `${id}.${s}` };
      if (typeof b.continueUrl === 'string' && allowedOrigin(b.continueUrl)) params.continueUrl = b.continueUrl;
      await send({ kind: 'verifyEmail', to: email, link: withParam(actionUrl, params), device: ctx.device }, 'verifyEmail');
      return { ok: true };
    },
    async 'POST /verify/confirm'(b) {
      const [id, c] = await open(String(b.oobCode ?? ''), 'linkHash');
      if (c.purpose !== 'verifyEmail' || !c.uid) throw new Fail('auth/invalid-action-code', 'This link is not an email confirmation link.');
      const d = await directory();
      const u = await d.getUser(c.uid);
      if (u.email?.toLowerCase() !== c.identifier) throw new Fail('auth/invalid-action-code', 'The account email changed since this link was sent.');
      await d.updateUser(c.uid, { emailVerified: true });
      await burn(id);
      return { email: c.identifier };
    },

    // phone
    async 'POST /phone/start'(b, ctx) {
      const phone = checkPhone(b.phoneNumber);
      await limitStart('phone', phone, ctx);
      const c = code(custom.phone?.codeLength ?? 6);
      const id = await issue({ channel: 'phone', purpose: 'signIn', mode: 'code', identifier: phone, codeHash: sha(c), device: ctx.device, deviceSig: ctx.deviceSig, ip: ctx.ip, site });
      await sendPhone()({ to: phone, code: c, site, minutes, rendered: T.phoneCode({ site, code: c, device: ctx.device, minutes }) });
      return { verificationId: id, expiresAt: now() + ttlMs };
    },
    async 'POST /phone/verify'(b) {
      const id = String(b.verificationId ?? '');
      const c = await attempt(id, String(b.code ?? ''));
      await burn(id);
      await audit(c.identifier, 'signed-in', { channel: 'phone', ip: c.ip, device: c.device });
      return { token: await token(await userForPhone(c.identifier), { method: 'phone' }) };
    },

    // Sign in with Apple from a native app: the identity token of Apple's sheet.
    async 'POST /apple/token'(b) {
      const claims = await appleIdToken(String(b.idToken ?? ''), typeof b.nonce === 'string' ? b.nonce : undefined);
      return { token: await token(await appleUser(claims, appleName(b.name)), { method: 'apple' }) };
    },
  };

  // ── Google and Apple OAuth (code flow with your own client) ─────────────────

  const http: typeof fetch = (input, init) => (opts.fetch ?? globalThis.fetch)(input, init);
  type OAuthState = { provider?: 'google' | 'apple'; mode: 'popup' | 'redirect'; back: string; nonce: string; expiresAt: number };
  const oauthStart = async (provider: 'google' | 'apple', url: URL): Promise<OAuthState & { state: string }> => {
    const mode = url.searchParams.get('mode') === 'redirect' ? 'redirect' : 'popup';
    const back = url.searchParams.get('return') ?? '';
    if (!allowedOrigin(back)) throw new Fail('auth/unauthorized-domain', 'The return URL is not on an authorized domain (config.auth.authorizedDomains).', 403);
    const state = secret();
    const st: OAuthState = { provider, mode, back, nonce: secret(), expiresAt: now() + ttlMs };
    await (await db()).set(`${root}/oauth/${short(state)}`, st);
    return { ...st, state };
  };
  /** The state an OAuth callback carries, used up. */
  const oauthState = async (provider: 'google' | 'apple', state: string): Promise<OAuthState> => {
    const s = await db();
    const st = await s.get<OAuthState>(`${root}/oauth/${short(state)}`);
    if (!st || st.expiresAt <= now() || (st.provider ?? 'google') !== provider) throw new Fail('auth/invalid-action-code', 'The sign-in took too long. Start again.');
    await s.remove(`${root}/oauth/${short(state)}`);
    return st;
  };
  /** Hand the result to the page that started: postMessage to the opener (popup) or the return URL's hash (redirect). */
  const deliver = (provider: 'google' | 'apple', st: OAuthState, payload: { token?: string; error?: { code: string; message: string } }): Response => {
    if (st.mode === 'redirect') {
      const u = new URL(st.back);
      u.hash = payload.token ? `icebase_token=${payload.token}` : `icebase_error=${encodeURIComponent(payload.error!.code)}`;
      return Response.redirect(u.toString(), 302);
    }
    const origin = new URL(st.back).origin;
    return html(page('Signing in…', '<p>Signing you in…</p>', `try{window.opener.postMessage(${JSON.stringify({ icebase: provider, ...payload })},${JSON.stringify(origin)})}finally{window.close()}`));
  };
  const deliverUser = async (provider: 'google' | 'apple', st: OAuthState, user: () => Promise<UserRecord>): Promise<Response> => {
    try {
      return deliver(provider, st, { token: await token(await user(), { method: provider }) });
    } catch (e) {
      if (!(e instanceof Fail)) console.error('[icebase auth]', e);
      return deliver(provider, st, { error: { code: e instanceof Fail ? e.code : 'auth/internal-error', message: e instanceof Fail ? e.message : 'Something went wrong. Try again.' } });
    }
  };
  const claimsOf = <T>(jwt: string): T => JSON.parse(Buffer.from(String(jwt).split('.')[1] ?? '', 'base64url').toString()) as T;

  const google = () => {
    const g = custom.google;
    const id = g && readEnv(g.clientIdEnv);
    const sec2 = g && readEnv(g.clientSecretEnv);
    if (!g || !id || !sec2) throw new Fail('auth/operation-not-allowed', 'custom Google sign-in is not configured (config.auth.custom.google and its env vars)', 400);
    return { clientId: id, clientSecret: sec2 };
  };
  const googleStart = async (url: URL): Promise<Response> => {
    const { clientId } = google();
    const st = await oauthStart('google', url);
    const to = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    to.search = new URLSearchParams({ client_id: clientId, redirect_uri: `${endpoint}/google/callback`, response_type: 'code', scope: 'openid email profile', state: st.state, nonce: st.nonce, prompt: 'select_account' }).toString();
    return Response.redirect(to.toString(), 302);
  };
  const googleCallback = async (url: URL): Promise<Response> => {
    const st = await oauthState('google', url.searchParams.get('state') ?? '');
    if (url.searchParams.get('error')) return deliver('google', st, { error: { code: 'auth/popup-closed-by-user', message: url.searchParams.get('error')! } });
    const { clientId, clientSecret } = google();
    const res = await http('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: url.searchParams.get('code') ?? '', client_id: clientId, client_secret: clientSecret, redirect_uri: `${endpoint}/google/callback`, grant_type: 'authorization_code' }),
    });
    if (!res.ok) return deliver('google', st, { error: { code: 'auth/internal-error', message: `Google token exchange failed (${res.status})` } });
    const { id_token } = (await res.json()) as { id_token?: string };
    // Received straight from Google's token endpoint over TLS (OIDC §3.1.3.7): check the claims, not the signature.
    const claims = claimsOf<{ iss: string; aud: string; exp: number; nonce?: string; sub: string; email?: string; email_verified?: boolean; name?: string; picture?: string }>(String(id_token));
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || claims.aud !== clientId || claims.exp * 1000 < now() || claims.nonce !== st.nonce) {
      return deliver('google', st, { error: { code: 'auth/invalid-id-token', message: 'Google sign-in could not be verified.' } });
    }
    return deliverUser('google', st, () => oauthUser('google', claims.sub, { ...(claims.email ? { email: claims.email } : {}), emailVerified: !!claims.email_verified, ...(claims.name ? { name: claims.name } : {}), ...(claims.picture ? { picture: claims.picture } : {}) }));
  };

  // Sign in with Apple. The web flow (a Services ID) posts its answer back as a form; native apps
  // send the identity token of Apple's own sheet to /apple/token, which checks its signature.
  const APPLE = 'https://appleid.apple.com';
  const apple = () => {
    const a = custom.apple;
    if (!a) throw new Fail('auth/operation-not-allowed', 'custom Apple sign-in is not configured (config.auth.custom.apple)', 400);
    const env = (name?: string) => (name ? readEnv(name) : undefined);
    // A .p8 key kept in one env line has its newlines escaped.
    return { clientId: env(a.clientIdEnv), teamId: env(a.teamIdEnv), keyId: env(a.keyIdEnv), privateKey: env(a.privateKeyEnv)?.replace(/\\n/g, '\n'), audiences: a.audiences ?? [] };
  };
  const appleWeb = () => {
    const a = apple();
    if (!a.clientId || !a.teamId || !a.keyId || !a.privateKey) throw new Fail('auth/operation-not-allowed', 'Sign in with Apple on the web needs config.auth.custom.apple clientIdEnv, teamIdEnv, keyIdEnv and privateKeyEnv (and their env vars)', 400);
    return a as { clientId: string; teamId: string; keyId: string; privateKey: string; audiences: string[] };
  };
  /** Apple's client_secret: an ES256 JWT signed with the team's key, good for 5 minutes. */
  const appleClientSecret = (a: { clientId: string; teamId: string; keyId: string; privateKey: string }) => {
    const t = Math.floor(now() / 1000);
    const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${part({ alg: 'ES256', kid: a.keyId })}.${part({ iss: a.teamId, iat: t, exp: t + 300, aud: APPLE, sub: a.clientId })}`;
    const sig = cryptoSign('sha256', Buffer.from(input), { key: createPrivateKey(a.privateKey), dsaEncoding: 'ieee-p1363' });
    return `${input}.${sig.toString('base64url')}`;
  };
  // Apple's public keys, kept an hour; an unknown kid fetches them again (at most once a minute).
  let appleKeys: { at: number; keys: (JsonWebKey & { kid?: string })[] } | null = null;
  const appleKey = async (kid: string) => {
    const find = () => appleKeys?.keys.find((k) => k.kid === kid);
    if (!appleKeys || now() - appleKeys.at > 3_600_000 || (!find() && now() - appleKeys.at > 60_000)) {
      const res = await http(`${APPLE}/auth/keys`);
      if (!res.ok) throw new Fail('auth/internal-error', `Could not fetch Apple's keys (${res.status})`, 502);
      appleKeys = { at: now(), keys: ((await res.json()) as { keys: (JsonWebKey & { kid?: string })[] }).keys ?? [] };
    }
    return find();
  };
  type AppleClaims = { iss: string; aud: string; exp: number; sub: string; nonce?: string; email?: string; email_verified?: boolean | string };
  const appleName = (raw: unknown): string | undefined => {
    if (typeof raw === 'string') return raw.trim().slice(0, 200) || undefined;
    const n = raw as { firstName?: string; lastName?: string; givenName?: string; familyName?: string } | null;
    const full = [n?.firstName ?? n?.givenName, n?.lastName ?? n?.familyName].filter(Boolean).join(' ').trim();
    return full ? full.slice(0, 200) : undefined;
  };
  const appleUser = (c: AppleClaims, name?: string) => oauthUser('apple', c.sub, { ...(c.email ? { email: c.email } : {}), emailVerified: c.email_verified === true || c.email_verified === 'true', ...(name ? { name } : {}) });

  const appleStart = async (url: URL): Promise<Response> => {
    const { clientId } = appleWeb();
    const st = await oauthStart('apple', url);
    const to = new URL(`${APPLE}/auth/authorize`);
    to.search = new URLSearchParams({ client_id: clientId, redirect_uri: `${endpoint}/apple/callback`, response_type: 'code', response_mode: 'form_post', scope: 'name email', state: st.state, nonce: st.nonce }).toString();
    return Response.redirect(to.toString(), 302);
  };
  /** Apple posts the answer as a form (response_mode=form_post), from https://appleid.apple.com. */
  const appleCallback = async (req: Request): Promise<Response> => {
    const form = new URLSearchParams(await req.text());
    const st = await oauthState('apple', form.get('state') ?? '');
    if (form.get('error')) return deliver('apple', st, { error: { code: 'auth/popup-closed-by-user', message: form.get('error')! } });
    const a = appleWeb();
    const res = await http(`${APPLE}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: a.clientId, client_secret: appleClientSecret(a), code: form.get('code') ?? '', grant_type: 'authorization_code', redirect_uri: `${endpoint}/apple/callback` }),
    });
    if (!res.ok) return deliver('apple', st, { error: { code: 'auth/internal-error', message: `Apple token exchange failed (${res.status})` } });
    const { id_token } = (await res.json()) as { id_token?: string };
    // Straight from Apple's token endpoint over TLS: the claims are checked, as for Google.
    const claims = claimsOf<AppleClaims>(String(id_token));
    if (claims.iss !== APPLE || claims.aud !== a.clientId || claims.exp * 1000 < now() || claims.nonce !== st.nonce) {
      return deliver('apple', st, { error: { code: 'auth/invalid-id-token', message: 'Apple sign-in could not be verified.' } });
    }
    let name: string | undefined;
    try {
      name = appleName((JSON.parse(form.get('user') ?? 'null') as { name?: unknown } | null)?.name);
    } catch {
      name = undefined;
    }
    return deliverUser('apple', st, () => appleUser(claims, name));
  };
  /** A native app's identity token (Apple's sheet): its signature is checked against Apple's keys. */
  const appleIdToken = async (raw: string, nonce?: string): Promise<AppleClaims> => {
    const a = apple();
    const bad = (why: string) => new Fail('auth/invalid-id-token', `The Apple identity token is not valid: ${why}.`, 401);
    const [h, p, sig] = raw.split('.');
    if (!h || !p || !sig) throw bad('not a JWT');
    let header: { alg?: string; kid?: string };
    let claims: AppleClaims;
    try {
      header = JSON.parse(Buffer.from(h, 'base64url').toString()) as { alg?: string; kid?: string };
      claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as AppleClaims;
    } catch {
      throw bad('not a JWT');
    }
    if (header.alg !== 'RS256' || !header.kid) throw bad('not signed with RS256');
    const jwk = await appleKey(header.kid);
    if (!jwk) throw bad('signed with an unknown key');
    if (!cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(sig, 'base64url'))) throw bad('wrong signature');
    if (claims.iss !== APPLE) throw bad('wrong issuer');
    if (!claims.exp || claims.exp * 1000 < now()) throw bad('expired');
    const audiences = [...a.audiences, ...(a.clientId ? [a.clientId] : [])];
    if (!audiences.includes(claims.aud)) throw bad(`audience ${claims.aud} is not in config.auth.custom.apple.audiences`);
    // The app may pass the raw nonce it gave Apple (Apple's sheet carries it, often SHA-256 hashed).
    if (nonce !== undefined && claims.nonce !== nonce && claims.nonce !== sha(nonce)) throw bad('wrong nonce');
    if (!claims.sub) throw bad('no subject');
    return claims;
  };

  // ── SSO: one hosted sign-in page for many apps (authorization code + PKCE) ──
  //
  // An app sends the person to /sso/authorize; the hosted page (sso.loginUrl) signs them in with
  // any method, shows "Continue to <app>" and grants; the app gets a one-time code on its own
  // redirect URI and trades it, with the PKCE verifier only it has, for a custom token at /sso/token.
  // Each grant is a session (sessions/<uid>/<sid>) the person can see and revoke from the hosted page.

  const CODE_MS = 5 * 60_000;
  type SsoClient = { name: string; redirectUris: string[]; iconUrl?: string };
  type SsoRequest = { client: string; redirectUri: string; state?: string; challenge: string; expiresAt: number; createdAt: number };
  type SsoCode = { client: string; redirectUri: string; challenge: string; uid: string; sid: string; expiresAt: number; used?: number };
  const sso = () => {
    if (!custom.sso) throw new Fail('auth/operation-not-allowed', 'SSO is not configured (config.auth.custom.sso)', 400);
    return custom.sso;
  };
  const ssoClient = (id: string): SsoClient | undefined => (Object.prototype.hasOwnProperty.call(sso().clients, id) ? sso().clients[id] : undefined);
  /** Exact match; an entry ending in '*' matches by prefix (custom schemes too). */
  const redirectAllowed = (c: SsoClient, uri: string) => !!uri && c.redirectUris.some((r) => (r.endsWith('*') ? uri.startsWith(r.slice(0, -1)) : uri === r));
  const s256 = (verifier: string) => createHash('sha256').update(verifier).digest('base64url');
  const ssoRequest = async (rid: unknown): Promise<[string, SsoRequest]> => {
    const id = String(rid ?? '');
    if (!/^[A-Za-z0-9_-]{10,40}$/.test(id)) throw new Fail('auth/invalid-action-code', 'This sign-in request is not valid.');
    const r = await (await db()).get<SsoRequest>(`${root}/sso/req/${id}`);
    if (!r) throw new Fail('auth/invalid-action-code', 'This sign-in request is not valid or was already used.');
    if (r.expiresAt <= now()) throw new Fail('auth/expired-action-code', 'This sign-in request has expired. Go back to the app and start again.');
    return [id, r];
  };
  const caller = async (idToken: unknown) => {
    try {
      return await (await directory()).verifyIdToken(String(idToken ?? ''), true);
    } catch {
      throw new Fail('auth/invalid-id-token', 'Sign in again.', 401);
    }
  };
  const sessionsOf = async (uid: string) => Object.entries((await (await db()).get<Record<string, Omit<SsoSession, 'sid'>>>(`${root}/sessions/${uid}`)) ?? {}).map(([sid, x]) => ({ ...x, sid, revoked: !!x.revoked }) as SsoSession);
  const ssoAuthorize = (url: URL): Promise<Response> | Response => {
    const refuse = (why: string) => html(page('Sign-in request not valid', `<h1>This sign-in request is not valid</h1><p>${esc(why)}</p><p class="muted">Go back to the app and try again.</p>`), 400);
    const cfg = custom.sso;
    if (!cfg) return refuse('Single sign-on is not set up here.');
    const q = url.searchParams;
    const client = ssoClient(q.get('client_id') ?? '');
    // Never redirect to a URI that is not registered: an error page instead.
    if (!client) return refuse('Unknown app (client_id).');
    const redirectUri = q.get('redirect_uri') ?? '';
    if (!redirectAllowed(client, redirectUri)) return refuse(`The redirect URI is not registered for ${client.name}.`);
    const challenge = q.get('code_challenge') ?? '';
    if (q.get('code_challenge_method') !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return refuse('A PKCE code_challenge with code_challenge_method=S256 is required.');
    return (async () => {
      const rid = randomBytes(15).toString('base64url');
      const t = now();
      const state = q.get('state');
      const r: SsoRequest = { client: q.get('client_id')!, redirectUri, challenge, expiresAt: t + ttlMs, createdAt: t, ...(state ? { state } : {}) };
      await (await db()).set(`${root}/sso/req/${rid}`, r);
      return Response.redirect(withParam(cfg.loginUrl, { sso: rid }), 302);
    })();
  };
  Object.assign(routes, {
    async 'POST /sso/request'(b: Record<string, unknown>) {
      const [, r] = await ssoRequest(b.sso);
      const c = ssoClient(r.client);
      if (!c) throw new Fail('auth/invalid-action-code', 'This app is no longer registered.');
      return { client: { id: r.client, name: c.name, ...(c.iconUrl ? { iconUrl: c.iconUrl } : {}) }, expiresAt: r.expiresAt };
    },
    async 'POST /sso/grant'(b: Record<string, unknown>, ctx: Ctx) {
      const who = await caller(b.idToken);
      const [rid, r] = await ssoRequest(b.sso);
      const c = ssoClient(r.client);
      if (!c || !redirectAllowed(c, r.redirectUri)) throw new Fail('auth/invalid-action-code', 'This app is no longer registered.');
      const s = await db();
      await s.remove(`${root}/sso/req/${rid}`);
      const user = await (await directory()).getUser(who.uid);
      if (user.disabled) throw new Fail('auth/user-disabled', 'This account has been disabled.', 403);
      const t = now();
      const sid = randomBytes(12).toString('base64url');
      await s.set(`${root}/sessions/${who.uid}/${sid}`, { client: r.client, clientName: c.name, device: ctx.device, ip: ctx.ip, createdAt: t, lastSeenAt: t, revoked: false });
      const code = secret();
      const stored: SsoCode = { client: r.client, redirectUri: r.redirectUri, challenge: r.challenge, uid: who.uid, sid, expiresAt: t + CODE_MS };
      await s.set(`${root}/sso/code/${sha(code)}`, stored);
      return { redirect: withParam(r.redirectUri, { code, ...(r.state ? { state: r.state } : {}) }) };
    },
    async 'POST /sso/deny'(b: Record<string, unknown>) {
      const [rid, r] = await ssoRequest(b.sso);
      await (await db()).remove(`${root}/sso/req/${rid}`);
      return { redirect: withParam(r.redirectUri, { error: 'access_denied', ...(r.state ? { state: r.state } : {}) }) };
    },
    async 'POST /sso/token'(b: Record<string, unknown>) {
      const invalid = (why: string) => new Fail('auth/invalid-action-code', `The sign-in code is not valid: ${why}.`);
      const code = String(b.code ?? '');
      const verifier = String(b.code_verifier ?? '');
      if (!code || code.length > 100) throw invalid('missing');
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw invalid('bad code_verifier');
      const s = await db();
      const path = `${root}/sso/code/${sha(code)}`;
      // Single use: the first exchange claims the code, whatever comes after is refused.
      const claim = await s.transaction<SsoCode>(path, (cur) => (cur && !cur.used ? { ...cur, used: now() } : undefined));
      const c = claim.value;
      if (!claim.committed || !c?.used) throw invalid('unknown or already used');
      await s.remove(path);
      if (c.expiresAt <= now()) throw invalid('expired');
      if (c.client !== String(b.client_id ?? '') || c.redirectUri !== String(b.redirect_uri ?? '')) throw invalid('issued to another app or redirect URI');
      const a = Buffer.from(s256(verifier));
      const e = Buffer.from(c.challenge);
      if (a.length !== e.length || !timingSafeEqual(a, e)) throw invalid('wrong code_verifier');
      const session = await s.get<Omit<SsoSession, 'sid'>>(`${root}/sessions/${c.uid}/${c.sid}`);
      if (!session || session.revoked) throw invalid('the session was revoked');
      const user = await (await directory()).getUser(c.uid);
      const t = await token(user, { method: 'sso', client: c.client, sid: c.sid }, { sid: c.sid, client: c.client });
      await s.update(`${root}/sessions/${c.uid}/${c.sid}`, { lastSeenAt: now() });
      return { token: t, uid: c.uid, sid: c.sid };
    },
    async 'POST /sso/ping'(b: Record<string, unknown>) {
      let claims: { uid: string; sid?: unknown };
      try {
        claims = (await (await directory()).verifyIdToken(String(b.idToken ?? ''), true)) as { uid: string; sid?: unknown };
      } catch (e) {
        // Revoked refresh tokens, a disabled or deleted account: this session is over too.
        if (['auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found'].includes((e as { code?: string }).code ?? '')) return { revoked: true };
        throw new Fail('auth/invalid-id-token', 'Sign in again.', 401);
      }
      if (typeof claims.sid !== 'string') throw new Fail('auth/argument-error', 'This session did not come from SSO sign-in (no sid claim).');
      const path = `${root}/sessions/${claims.uid}/${claims.sid}`;
      const s = await db();
      const cur = await s.get<Omit<SsoSession, 'sid'>>(path);
      if (!cur || cur.revoked) return { revoked: true };
      await s.update(path, { lastSeenAt: now() });
      return { ok: true };
    },
    async 'POST /sso/sessions'(b: Record<string, unknown>) {
      const who = await caller(b.idToken);
      const current = typeof (who as { sid?: unknown }).sid === 'string' ? (who as { sid?: string }).sid : undefined;
      const sessions = (await sessionsOf(who.uid)).sort((x, y) => y.createdAt - x.createdAt).map((x) => ({ ...x, current: x.sid === current }));
      const apps = new Map<string, { client: string; clientName: string; iconUrl?: string; sessions: number; lastSeenAt: number }>();
      for (const x of sessions) {
        if (x.revoked) continue;
        const a = apps.get(x.client);
        if (a) {
          a.sessions++;
          a.lastSeenAt = Math.max(a.lastSeenAt, x.lastSeenAt);
        } else {
          const icon = custom.sso?.clients[x.client]?.iconUrl;
          apps.set(x.client, { client: x.client, clientName: x.clientName, ...(icon ? { iconUrl: icon } : {}), sessions: 1, lastSeenAt: x.lastSeenAt });
        }
      }
      return { sessions, apps: [...apps.values()].sort((x, y) => y.lastSeenAt - x.lastSeenAt) };
    },
    async 'POST /sso/revoke'(b: Record<string, unknown>) {
      const who = await caller(b.idToken);
      const all = b.all === true;
      if (!all && typeof b.sid !== 'string' && typeof b.client !== 'string') throw new Fail('auth/argument-error', 'Say which sessions: { sid }, { client } or { all: true }.');
      const s = await db();
      let revoked = 0;
      for (const x of await sessionsOf(who.uid)) {
        if (x.revoked || !(all || x.sid === b.sid || x.client === b.client)) continue;
        await s.update(`${root}/sessions/${who.uid}/${x.sid}`, { revoked: true, revokedAt: now() });
        revoked++;
      }
      // Everywhere: also every Firebase refresh token (every other sign-in of this account).
      if (all) await (await directory()).revokeRefreshTokens(who.uid);
      return { revoked };
    },
  });

  // ── pages ──────────────────────────────────────────────────────────────────

  const approvalPage = async (url: URL): Promise<Response> => {
    const t = url.searchParams.get('t') ?? '';
    let c: Challenge;
    try {
      [, c] = await open(t, 'approvalHash');
    } catch (e) {
      return html(page('Link not valid', `<h1>This link no longer works</h1><p>${esc((e as Error).message)}</p>`), 400);
    }
    if (c.state !== 'pending') return html(page('Already answered', `<h1>Already ${c.state === 'approved' ? 'approved' : 'turned down'}</h1><p class="muted">You can close this tab.</p>`));
    const body = `<h1>Sign in to ${esc(c.site)}?</h1>
<p><b>${esc(c.device)}</b> is asking to sign in as <b>${esc(c.identifier)}</b>.</p>
<p class="muted">Only approve if that's you, right now.</p>
<div id="a"><button class="go" data-r="approve">Yes, sign me in</button><button class="no" data-r="reject">This wasn't me</button></div>
<p id="m"></p>`;
    const script = `document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{document.getElementById('a').hidden=true;const r=await fetch(location.pathname.replace(/page$/,b.dataset.r),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({t:${JSON.stringify(t)}})});const j=await r.json();document.getElementById('m').innerHTML=j.state==='approved'?'<b class=ok>Approved.</b> Go back to the other tab; you are signed in there.':j.state==='revoked'?'<b class=bad>Turned down.</b> That device can\\'t ask again for a few minutes.':'Something went wrong: '+(j.error&&j.error.message||'')})`;
    return html(page(`Sign in to ${c.site}?`, body, script));
  };
  const actionPage = async (url: URL): Promise<Response> => {
    const mode = url.searchParams.get('mode');
    const oob = url.searchParams.get('oobCode') ?? '';
    const cont = url.searchParams.get('continueUrl');
    const back = cont && allowedOrigin(cont) ? `<p><a href="${esc(cont)}">Continue</a></p>` : '<p class="muted">You can close this tab.</p>';
    const base = url.pathname.replace(/\/action$/, '');
    if (mode === 'resetPassword') {
      const body = `<h1>Choose a new password</h1><form id="f"><input id="p" type="password" minlength="6" autocomplete="new-password" placeholder="New password" required><button class="go">Save password</button></form><p id="m"></p><div id="d" hidden>${back}</div>`;
      const script = `document.getElementById('f').onsubmit=async(e)=>{e.preventDefault();const r=await fetch(${JSON.stringify(`${base}/reset/confirm`)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({oobCode:${JSON.stringify(oob)},newPassword:document.getElementById('p').value})});const j=await r.json();if(r.ok){document.getElementById('f').hidden=true;document.getElementById('m').innerHTML='<b class=ok>Password changed.</b> Sign in with the new one.';document.getElementById('d').hidden=false}else{document.getElementById('m').innerHTML='<span class=bad>'+(j.error&&j.error.message||'Something went wrong')+'</span>'}}`;
      return html(page('Reset password', body, script));
    }
    if (mode === 'verifyEmail') {
      // A button, not an automatic call: mail scanners open links, and must not confirm addresses.
      const body = `<h1>Confirm your email</h1><button class="go" id="b">Confirm</button><p id="m"></p><div id="d" hidden>${back}</div>`;
      const script = `document.getElementById('b').onclick=async()=>{const r=await fetch(${JSON.stringify(`${base}/verify/confirm`)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({oobCode:${JSON.stringify(oob)}})});const j=await r.json();document.getElementById('b').hidden=true;document.getElementById('m').innerHTML=r.ok?'<b class=ok>Email confirmed.</b>':'<span class=bad>'+(j.error&&j.error.message||'Something went wrong')+'</span>';if(r.ok)document.getElementById('d').hidden=false}`;
      return html(page('Confirm email', body, script));
    }
    return html(page('Not found', '<h1>Unknown action</h1>'), 404);
  };

  // ── the handler ────────────────────────────────────────────────────────────

  const html = (body: string, status = 200) => new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const route = url.pathname.replace(/^.*?\/(email|phone|reset|verify|google|apple|sso|action)(\/|$)/, '/$1$2').replace(/\/$/, '');
    const origin = req.headers.get('origin');
    // /sso/* answers any origin: those calls carry no cookies, the code is bound by PKCE and the rest
    // by the caller's ID token — and the apps signing in through it are not the login site's domains.
    const ssoRoute = route.startsWith('/sso/');
    const cors: Record<string, string> = ssoRoute
      ? { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-max-age': '600' }
      : origin && allowedOrigin(origin)
        ? { 'access-control-allow-origin': origin, vary: 'origin', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'POST, GET, OPTIONS', 'access-control-max-age': '600' }
        : {};
    const json = (body: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors, ...extra } });
    try {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (req.method === 'GET') {
        if (route === '/email/page') return await approvalPage(url);
        if (route === '/action') return await actionPage(url);
        if (route === '/google/start') return await googleStart(url);
        if (route === '/google/callback') return await googleCallback(url);
        if (route === '/apple/start') return await appleStart(url);
        if (route === '/sso/authorize') return await ssoAuthorize(url);
      }
      // Apple posts its answer as a form from https://appleid.apple.com: not one of the app's origins.
      if (req.method === 'POST' && route === '/apple/callback') return await appleCallback(req);
      const fn = routes[`${req.method} ${route}`];
      if (!fn) return json({ error: { code: 'auth/argument-error', message: `No route ${req.method} ${route}` } }, 404);
      // The endpoint's own pages (the approval page, the action page) post back to it from its own
      // origin — e.g. https://<region>-<project>.cloudfunctions.net — which is never in the app's list.
      const own = origin === selfOrigin || origin === url.origin;
      if (origin && !own && !ssoRoute && !cors['access-control-allow-origin']) throw new Fail('auth/unauthorized-domain', `Origin ${origin} is not an authorized domain (config.auth.authorizedDomains).`, 403);
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      const ip = (req.headers.get('x-forwarded-for') ?? '').split(',')[0]!.trim() || null;
      const ua = req.headers.get('user-agent') ?? '';
      return json(await fn(body, { ip, ua, device: describeDevice(ua), deviceSig: short(`${ip}|${ua}`), origin }, url));
    } catch (e) {
      if (e instanceof Fail) return json({ error: { code: e.code, message: e.message, ...(e.retryAfter ? { retryAfter: e.retryAfter } : {}) } }, e.status, e.retryAfter ? { 'retry-after': String(e.retryAfter) } : {});
      console.error('[icebase auth]', e);
      return json({ error: { code: 'auth/internal-error', message: 'Something went wrong. Try again.' } }, 500);
    }
  };
}

// ─── admin: the security store and identity links ──────────────────────────────

/** What one identifier (an email or phone number) has been doing, and what holds it back. */
export interface IdentifierActivity {
  identifier: string;
  /** Rate-limit counters still running: rule, count, and when the window ends. */
  limits: { rule: string; count: number; resetsAt: number }[];
  /** Devices turned away ("this wasn't me" on the approval page), until when. */
  blocks: { device: string; until: number }[];
  /** The audit trail, newest first. */
  attempts: AuditEntry[];
}

export interface AuthSecurity {
  /** Lift every block on this identifier (all devices). */
  unblock(identifier: string): Promise<{ removed: number }>;
  /** Its counters, blocks and audit trail. */
  listAttempts(identifier: string): Promise<IdentifierActivity>;
  /** Clear its per-identifier rate-limit counters (sends can start again at once). */
  resetLimits(identifier: string): Promise<{ removed: number }>;
  /** Remove what has expired: challenges, counters, blocks, SSO requests and codes, and audit entries older than security.auditDays (30). */
  cleanup(): Promise<{ removed: number }>;
  /** A user's SSO sessions (one per app sign-in through the hosted page), newest first. */
  listSessions(uid: string): Promise<SsoSession[]>;
  /** Revoke one SSO session: its app's next ping (watchSsoSession) signs it out, and its code can no longer be exchanged. */
  revokeSession(uid: string, sid: string): Promise<{ revoked: boolean }>;
}

export type CustomIdentity = { email: string } | { phone: string } | { google: string } | { apple: string };

/** An email lower-cased, a phone number without spaces — as the handler keys them. */
const normalizeIdentifier = (id: string) => (id.includes('@') ? id.trim().toLowerCase() : id.replace(/[\s()-]/g, ''));

/** The security operations over a store (shared by firebase mode and the IceBase server). */
export function authSecurityOps(config: AnyConfig, store: Store, directory: () => Promise<AuthDirectory>, now: () => number = Date.now): AuthSecurity & {
  link(uid: string, id: CustomIdentity): Promise<{ uid: string }>;
  unlink(uid: string, kind: 'email' | 'phone' | 'google' | 'apple'): Promise<{ uid: string }>;
} {
  const sec = config.auth?.custom?.security ?? {};
  const root = (sec.store?.path ?? STORE_DEFAULT_PATH).replace(/^\/|\/$/g, '');
  const auditMs = (sec.auditDays ?? 30) * 86_400_000;
  const map = async <T>(path: string) => (await store.get<Record<string, T>>(path)) ?? {};
  const links = async (provider: 'google' | 'apple', uid: string) => Object.entries(await map<string>(`${root}/identities/${provider}`)).filter(([, u]) => u === uid).map(([k]) => k);
  return {
    async unblock(identifier) {
      const prefix = `${short(normalizeIdentifier(identifier))}_`;
      const keys = Object.keys(await map(`${root}/blocks`)).filter((k) => k.startsWith(prefix));
      for (const k of keys) await store.remove(`${root}/blocks/${k}`);
      return { removed: keys.length };
    },
    async resetLimits(identifier) {
      const key = short(normalizeIdentifier(identifier));
      let removed = 0;
      for (const rule of ['id-hour', 'id-day']) {
        if (await store.get(`${root}/rl/${rule}/${key}`)) {
          await store.remove(`${root}/rl/${rule}/${key}`);
          removed++;
        }
      }
      return { removed };
    },
    async listAttempts(identifier) {
      const id = normalizeIdentifier(identifier);
      const key = short(id);
      const t = now();
      const limits: IdentifierActivity['limits'] = [];
      for (const rule of ['id-hour', 'id-day']) {
        const c = await store.get<{ n: number; until: number }>(`${root}/rl/${rule}/${key}`);
        if (c && c.until > t) limits.push({ rule, count: c.n, resetsAt: c.until });
      }
      const blocks = Object.entries(await map<number>(`${root}/blocks`))
        .filter(([k, until]) => k.startsWith(`${key}_`) && until > t)
        .map(([k, until]) => ({ device: k.slice(key.length + 1), until }));
      const attempts = Object.entries(await map<AuditEntry>(`${root}/audit/${key}`))
        .sort(([a], [b]) => (a < b ? 1 : -1))
        .map(([, e]) => e);
      return { identifier: id, limits, blocks, attempts };
    },
    async cleanup() {
      const t = now();
      let removed = 0;
      const drop = async (path: string) => {
        await store.remove(path);
        removed++;
      };
      for (const [id, c] of Object.entries(await map<{ expiresAt?: number }>(`${root}/challenge`))) if ((c.expiresAt ?? 0) <= t) await drop(`${root}/challenge/${id}`);
      for (const [id, c] of Object.entries(await map<{ expiresAt?: number }>(`${root}/signin`))) if ((c.expiresAt ?? 0) <= t) await drop(`${root}/signin/${id}`);
      for (const [rule, keys] of Object.entries(await map<Record<string, { until: number }>>(`${root}/rl`))) for (const [k, c] of Object.entries(keys ?? {})) if (c.until <= t) await drop(`${root}/rl/${rule}/${k}`);
      for (const [k, until] of Object.entries(await map<number>(`${root}/blocks`))) if (until <= t) await drop(`${root}/blocks/${k}`);
      for (const [who, entries] of Object.entries(await map<Record<string, AuditEntry>>(`${root}/audit`))) for (const [k, e] of Object.entries(entries ?? {})) if (e.at <= t - auditMs) await drop(`${root}/audit/${who}/${k}`);
      for (const [id, st] of Object.entries(await map<{ expiresAt?: number }>(`${root}/oauth`))) if ((st.expiresAt ?? 0) <= t) await drop(`${root}/oauth/${id}`);
      for (const kind of ['req', 'code']) for (const [id, x] of Object.entries(await map<{ expiresAt?: number }>(`${root}/sso/${kind}`))) if ((x.expiresAt ?? 0) <= t) await drop(`${root}/sso/${kind}/${id}`);
      return { removed };
    },
    async listSessions(uid) {
      return Object.entries(await map<Omit<SsoSession, 'sid'>>(`${root}/sessions/${uid}`))
        .map(([sid, x]) => ({ ...x, sid, revoked: !!x.revoked }) as SsoSession)
        .sort((a, b) => b.createdAt - a.createdAt);
    },
    async revokeSession(uid, sid) {
      const path = `${root}/sessions/${uid}/${sid}`;
      const cur = await store.get<Omit<SsoSession, 'sid'>>(path);
      if (!cur) throw new Fail('auth/argument-error', 'No such session.', 404);
      if (!cur.revoked) await store.update(path, { revoked: true, revokedAt: now() });
      return { revoked: true };
    },
    async link(uid, id) {
      const d = await directory();
      await d.getUser(uid);
      if ('email' in id) {
        const email = normalizeIdentifier(id.email);
        if (!EMAIL.test(email)) throw new Fail('auth/invalid-email', 'That email address is not valid.');
        await d.updateUser(uid, { email, emailVerified: true });
      } else if ('phone' in id) {
        const phone = normalizeIdentifier(id.phone);
        if (!E164.test(phone)) throw new Fail('auth/invalid-phone-number', 'Use the full number with country code, e.g. +919812345678.');
        await d.updateUser(uid, { phoneNumber: phone });
      } else {
        const [provider, sub] = 'google' in id ? (['google', id.google] as const) : (['apple', id.apple] as const);
        const path = `${root}/identities/${provider}/${short(String(sub))}`;
        const cur = await store.get<string>(path);
        if (cur && cur !== uid) throw new Fail('auth/credential-already-in-use', `This ${provider === 'google' ? 'Google' : 'Apple'} account is already linked to another user.`, 409);
        await store.set(path, uid);
      }
      return { uid };
    },
    async unlink(uid, kind) {
      const d = await directory();
      const u = await d.getUser(uid);
      const google = await links('google', uid);
      const apple = await links('apple', uid);
      const has = { email: !!u.email, phone: !!u.phoneNumber, google: google.length > 0, apple: apple.length > 0 };
      if (!has[kind]) throw new Fail('auth/no-such-provider', `This account has no ${kind} to remove.`);
      // Never the last one: an account nothing can prove is an account nobody can open again.
      if (Object.entries(has).filter(([k, v]) => v && k !== kind).length === 0) {
        throw new Fail('auth/operation-not-allowed', 'That is the only way into this account. Link another identity first.', 409);
      }
      if (kind === 'email') throw new Fail('auth/operation-not-allowed', "Firebase Auth cannot remove an account's email; change it with linkCustomIdentity(uid, { email }).");
      if (kind === 'phone') await d.updateUser(uid, { phoneNumber: null as never });
      else for (const k of kind === 'google' ? google : apple) await store.remove(`${root}/identities/${kind}/${k}`);
      return { uid };
    },
  };
}

/** On the IceBase server (emulator mode): the custom-auth service's management API. */
async function onServer<T>(app: IceBaseApp, op: string, body: Record<string, unknown>): Promise<T> {
  const { emulatorFetch, emulatorOrigin } = await import('@panth977/icebase/app');
  const token = app.options.emulator?.adminToken ?? (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.ICEBASE_ADMIN_TOKEN ?? 'owner';
  const res = await emulatorFetch(`${emulatorOrigin(app)}/__/icebase/admin/manage/customAuth/${op}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  const j = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string; details?: { authCode?: string } } } & T;
  if (!res.ok || j.error) throw Object.assign(new Error(j.error?.message ?? `customAuth.${op}: ${res.status}`), { code: j.error?.details?.authCode ?? j.error?.code ?? 'internal' });
  return j;
}

async function securityOf(app: IceBaseApp) {
  if (app.kind !== 'admin') throw new Fail('auth/argument-error', 'getAuthSecurity needs an admin app (initializeAdminApp)');
  const { getAdminAuth } = await import('./admin.ts');
  return authSecurityOps(app.config as AnyConfig, await appStore(app.config as AnyConfig, app), async () => getAdminAuth(app) as unknown as AuthDirectory);
}

/** Custom auth's security store, for an admin (docs/prd/custom-auth.html): unblock, listAttempts, resetLimits, cleanup, listSessions, revokeSession. */
export function getAuthSecurity(app: IceBaseApp): AuthSecurity {
  const emu = app.modes.auth === 'emulator';
  const call = <T>(op: keyof AuthSecurity, identifier?: string): Promise<T> =>
    emu ? onServer<T>(app, op, identifier !== undefined ? { identifier } : {}) : securityOf(app).then((s) => (identifier !== undefined ? (s[op] as (x: string) => Promise<T>)(identifier) : (s[op] as () => Promise<T>)()));
  return {
    unblock: (identifier) => call('unblock', identifier),
    listAttempts: (identifier) => call('listAttempts', identifier),
    resetLimits: (identifier) => call('resetLimits', identifier),
    cleanup: () => call('cleanup'),
    listSessions: (uid) => (emu ? onServer(app, 'listSessions', { uid }) : securityOf(app).then((s) => s.listSessions(uid))),
    revokeSession: (uid, sid) => (emu ? onServer(app, 'revokeSession', { uid, sid }) : securityOf(app).then((s) => s.revokeSession(uid, sid))),
  };
}

/** Attach a verified identity to an existing account: { email }, { phone }, { google: <Google subject id> } or { apple: <Apple subject id> }. */
export async function linkCustomIdentity(app: IceBaseApp, uid: string, identity: CustomIdentity): Promise<{ uid: string }> {
  if (app.modes.auth === 'emulator') return onServer(app, 'link', { uid, identity });
  return (await securityOf(app)).link(uid, identity);
}

/** Take an identity off an account — never its last one. Firebase Auth cannot remove an email (change it instead). */
export async function unlinkCustomIdentity(app: IceBaseApp, uid: string, kind: 'email' | 'phone' | 'google' | 'apple'): Promise<{ uid: string }> {
  if (app.modes.auth === 'emulator') return onServer(app, 'unlink', { uid, kind });
  return (await securityOf(app)).unlink(uid, kind);
}
