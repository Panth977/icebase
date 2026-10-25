// Auth on the IceBase server: the Identity Toolkit + Secure Token REST API that Firebase's own
// auth emulator speaks, so firebase/auth (connectAuthEmulator) and firebase-admin
// (FIREBASE_AUTH_EMULATOR_HOST) work against it unchanged. Users live in SQLite. ID tokens are
// unsigned JWTs, exactly like Firebase's emulator, which both SDKs accept in emulator mode.

import { randomBytes, randomInt, scryptSync, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { json, type EmulatorContext, type Service } from './server.ts';
import { Buffer } from 'node:buffer';

interface UserRec {
  localId: string;
  email?: string;
  emailVerified?: boolean;
  displayName?: string;
  photoUrl?: string;
  phoneNumber?: string;
  passwordHash?: string;
  disabled?: boolean;
  customAttributes?: string;
  providerUserInfo: { providerId: string; rawId: string; email?: string; phoneNumber?: string; displayName?: string; photoUrl?: string; federatedId?: string }[];
  createdAt: string;
  lastLoginAt?: string;
  validSince: string;
  lastRefreshAt?: string;
  isAnonymous?: boolean;
}

const b64u = (s: string) => Buffer.from(s).toString('base64url');
const now = () => Date.now();
const newId = () => randomBytes(21).toString('base64url').replace(/[-_]/g, 'x').slice(0, 28);

function hashPw(pw: string): string {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('base64')}$${scryptSync(pw, salt, 32).toString('base64')}`;
}
function checkPw(pw: string, stored: string | undefined): boolean {
  if (!stored) return false;
  const [, salt, hash] = stored.split('$');
  const a = scryptSync(pw, Buffer.from(salt!, 'base64'), 32);
  const b = Buffer.from(hash!, 'base64');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Identity Toolkit's error shape: { error: { code, message: 'EMAIL_NOT_FOUND' } } — the SDKs map the message. */
const fail = (message: string, code = 400) => json({ error: { code, message, errors: [{ message, domain: 'global', reason: 'invalid' }] } }, code);
class AuthFail extends Error {
  constructor(readonly msg: string) {
    super(msg);
  }
}

export function decodeToken(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function authService(ctx: EmulatorContext): Service {
  const p = ctx.projectId;
  const db = new DatabaseSync(ctx.dataDir === ':memory:' ? ':memory:' : join(ctx.dataDir, 'auth.sqlite'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (uid TEXT PRIMARY KEY, email TEXT, phone TEXT, rec TEXT NOT NULL);
    CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users (email) WHERE email IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS users_phone ON users (phone) WHERE phone IS NOT NULL;
    CREATE TABLE IF NOT EXISTS refresh (token TEXT PRIMARY KEY, uid TEXT NOT NULL, provider TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS oob (code TEXT PRIMARY KEY, email TEXT, kind TEXT NOT NULL, uid TEXT, link TEXT, at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS phone_codes (session TEXT PRIMARY KEY, phone TEXT NOT NULL, code TEXT NOT NULL, at INTEGER NOT NULL);
  `);
  const q = {
    byUid: db.prepare(`SELECT rec FROM users WHERE uid = ?`),
    byEmail: db.prepare(`SELECT rec FROM users WHERE email = ?`),
    byPhone: db.prepare(`SELECT rec FROM users WHERE phone = ?`),
    put: db.prepare(`INSERT INTO users (uid, email, phone, rec) VALUES (?, ?, ?, ?) ON CONFLICT(uid) DO UPDATE SET email = excluded.email, phone = excluded.phone, rec = excluded.rec`),
    del: db.prepare(`DELETE FROM users WHERE uid = ?`),
    page: db.prepare(`SELECT rec FROM users WHERE uid > ? ORDER BY uid LIMIT ?`),
    refreshPut: db.prepare(`INSERT INTO refresh (token, uid, provider) VALUES (?, ?, ?)`),
    refreshGet: db.prepare(`SELECT uid, provider FROM refresh WHERE token = ?`),
    oobPut: db.prepare(`INSERT INTO oob (code, email, kind, uid, link, at) VALUES (?, ?, ?, ?, ?, ?)`),
    oobGet: db.prepare(`SELECT * FROM oob WHERE code = ?`),
    oobDel: db.prepare(`DELETE FROM oob WHERE code = ?`),
    oobAll: db.prepare(`SELECT * FROM oob ORDER BY at`),
    codePut: db.prepare(`INSERT INTO phone_codes (session, phone, code, at) VALUES (?, ?, ?, ?)`),
    codeGet: db.prepare(`SELECT * FROM phone_codes WHERE session = ?`),
    codeAll: db.prepare(`SELECT * FROM phone_codes ORDER BY at`),
  };
  const read = (r: unknown): UserRec | null => (r ? (JSON.parse((r as { rec: string }).rec) as UserRec) : null);
  const get = (uid: string) => read(q.byUid.get(uid));
  const getByEmail = (email: string) => read(q.byEmail.get(email.toLowerCase()));
  const getByPhone = (phone: string) => read(q.byPhone.get(phone));
  const save = (u: UserRec) => {
    if (u.email) u.email = u.email.toLowerCase();
    try {
      q.put.run(u.localId, u.email ?? null, u.phoneNumber ?? null, JSON.stringify(u));
    } catch (e) {
      if (/UNIQUE/.test(String(e))) throw new AuthFail(/email/.test(String(e)) ? 'EMAIL_EXISTS' : 'PHONE_NUMBER_EXISTS');
      throw e;
    }
    return u;
  };
  const fresh = (patch: Partial<UserRec> = {}): UserRec => ({ localId: patch.localId ?? newId(), providerUserInfo: [], createdAt: String(now()), validSince: String(Math.floor(now() / 1000)), ...patch });

  const provider = (u: UserRec, signIn: string) => (u.isAnonymous ? 'anonymous' : signIn);
  const idToken = (u: UserRec, signInProvider: string) => {
    const t = Math.floor(now() / 1000);
    const claims = u.customAttributes ? (JSON.parse(u.customAttributes) as Record<string, unknown>) : {};
    const identities: Record<string, string[]> = {};
    if (u.email) identities.email = [u.email];
    if (u.phoneNumber) identities.phone = [u.phoneNumber];
    for (const pi of u.providerUserInfo) if (pi.providerId !== 'password' && pi.providerId !== 'phone') (identities[pi.providerId] ??= []).push(pi.rawId);
    const payload = {
      ...claims,
      ...(u.displayName ? { name: u.displayName } : {}),
      ...(u.photoUrl ? { picture: u.photoUrl } : {}),
      ...(u.email ? { email: u.email, email_verified: !!u.emailVerified } : {}),
      ...(u.phoneNumber ? { phone_number: u.phoneNumber } : {}),
      auth_time: t,
      user_id: u.localId,
      firebase: { identities, sign_in_provider: provider(u, signInProvider) },
      iat: t,
      exp: t + 3600,
      aud: p,
      iss: `https://securetoken.google.com/${p}`,
      sub: u.localId,
    };
    return `${b64u(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64u(JSON.stringify(payload))}.`;
  };
  const tokens = (u: UserRec, signInProvider: string, extra: Record<string, unknown> = {}) => {
    const refreshToken = randomBytes(24).toString('base64url');
    q.refreshPut.run(refreshToken, u.localId, provider(u, signInProvider));
    u.lastLoginAt = String(now());
    save(u);
    return { kind: 'identitytoolkit#VerifyPasswordResponse', localId: u.localId, email: u.email ?? '', displayName: u.displayName ?? '', idToken: idToken(u, signInProvider), refreshToken, expiresIn: '3600', registered: true, ...extra };
  };
  const userInfo = (u: UserRec) => {
    const { passwordHash, ...rest } = u;
    return { ...rest, ...(passwordHash ? { passwordHash: 'IceBase-hashed', passwordUpdatedAt: Number(u.validSince) * 1000 } : {}), emailVerified: !!u.emailVerified, disabled: !!u.disabled };
  };
  const fromIdToken = (t: unknown): UserRec => {
    const c = decodeToken(String(t ?? ''));
    if (!c || typeof c.user_id !== 'string') throw new AuthFail('INVALID_ID_TOKEN');
    if ((c.exp as number) * 1000 < now()) throw new AuthFail('TOKEN_EXPIRED');
    const u = get(c.user_id);
    if (!u) throw new AuthFail('USER_NOT_FOUND');
    if (Number(c.iat) < Number(u.validSince)) throw new AuthFail('TOKEN_EXPIRED');
    return u;
  };
  const live = (u: UserRec | null): UserRec => {
    if (!u) throw new AuthFail('EMAIL_NOT_FOUND');
    if (u.disabled) throw new AuthFail('USER_DISABLED');
    return u;
  };
  const oob = (kind: string, email: string | null, uid: string | null, continueUrl?: string) => {
    const code = randomBytes(18).toString('base64url');
    const mode = { PASSWORD_RESET: 'resetPassword', VERIFY_EMAIL: 'verifyEmail', EMAIL_SIGNIN: 'signIn' }[kind] ?? kind;
    const link = `${ctx.origin}/emulator/action?mode=${mode}&lang=en&oobCode=${code}&apiKey=fake-api-key${continueUrl ? `&continueUrl=${encodeURIComponent(continueUrl)}` : ''}`;
    q.oobPut.run(code, email, kind, uid, link, now());
    return { code, link };
  };
  const takeOob = (code: unknown, kind?: string) => {
    const r = q.oobGet.get(String(code ?? '')) as { code: string; email: string; kind: string; uid: string | null; at: number } | undefined;
    if (!r || (kind && r.kind !== kind)) throw new AuthFail('INVALID_OOB_CODE');
    if (r.at < now() - 3600_000) throw new AuthFail('EXPIRED_OOB_CODE');
    return r;
  };
  const claimsOf = (t: string) => decodeToken(t);

  // Rules (and every other service) learn who is calling from here.
  ctx.verify = async (token) => {
    if (!token) return { admin: false, auth: null };
    if (token === ctx.adminToken) return { admin: true, auth: null };
    const c = claimsOf(token);
    if (!c || typeof c.user_id !== 'string' || (c.exp as number) * 1000 < now()) return { admin: false, auth: null };
    return { admin: false, auth: { uid: c.user_id, token: c } };
  };

  // ── events and blocking functions ───────────────────────────────────────────

  /** A user as Cloud Functions' auth events carry it (firebase-admin's UserRecord). */
  const userEvent = (u: UserRec) => ({
    uid: u.localId,
    ...(u.email ? { email: u.email } : {}),
    emailVerified: !!u.emailVerified,
    ...(u.displayName ? { displayName: u.displayName } : {}),
    ...(u.photoUrl ? { photoURL: u.photoUrl } : {}),
    ...(u.phoneNumber ? { phoneNumber: u.phoneNumber } : {}),
    disabled: !!u.disabled,
    metadata: { creationTime: new Date(Number(u.createdAt)).toUTCString(), lastSignInTime: u.lastLoginAt ? new Date(Number(u.lastLoginAt)).toUTCString() : null },
    providerData: u.providerUserInfo.map((p) => ({ providerId: p.providerId, uid: p.rawId, ...(p.email ? { email: p.email } : {}) })),
    ...(u.customAttributes ? { customClaims: JSON.parse(u.customAttributes) as Record<string, unknown> } : {}),
    tenantId: null,
  });
  const emitAuth = (event: 'created' | 'deleted', u: UserRec) => {
    for (const h of ctx.hooks.auth) h({ event, user: userEvent(u) });
  };
  /** Apply what a blocking function returned (displayName, photoURL, emailVerified, disabled, customClaims; sessionClaims for this token). */
  const applyPatch = (u: UserRec, patch: Record<string, unknown> | void): Record<string, unknown> | undefined => {
    if (!patch) return undefined;
    if (typeof patch.displayName === 'string') u.displayName = patch.displayName;
    if (typeof patch.photoURL === 'string') u.photoUrl = patch.photoURL;
    if (typeof patch.emailVerified === 'boolean') u.emailVerified = patch.emailVerified;
    if (typeof patch.disabled === 'boolean') u.disabled = patch.disabled;
    if (patch.customClaims && typeof patch.customClaims === 'object') u.customAttributes = JSON.stringify(patch.customClaims);
    return patch.sessionClaims && typeof patch.sessionClaims === 'object' ? (patch.sessionClaims as Record<string, unknown>) : undefined;
  };
  const blocked = (e: unknown) => new AuthFail(`BLOCKING_FUNCTION_ERROR_RESPONSE : ${(e as Error).message ?? 'refused'}`);
  /** A new user: beforeUserCreated, then saved, then the created event. */
  const create = async (u: UserRec, how: string): Promise<UserRec> => {
    if (ctx.hooks.beforeCreate) {
      try {
        applyPatch(u, await ctx.hooks.beforeCreate(userEvent(u), how));
      } catch (e) {
        throw blocked(e);
      }
    }
    save(u);
    emitAuth('created', u);
    return u;
  };
  /** A sign-in: beforeUserSignedIn may refuse, change the user, or add claims to this session's token. */
  const signIn = async (u: UserRec, how: string): Promise<UserRec> => {
    if (!ctx.hooks.beforeSignIn) return u;
    let session: Record<string, unknown> | undefined;
    try {
      session = applyPatch(u, await ctx.hooks.beforeSignIn(userEvent(u), how));
    } catch (e) {
      throw blocked(e);
    }
    save(u);
    if (u.disabled) throw new AuthFail('USER_DISABLED');
    return session ? { ...u, customAttributes: JSON.stringify({ ...(u.customAttributes ? JSON.parse(u.customAttributes) : {}), ...session }) } : u;
  };

  // ── the routes ──────────────────────────────────────────────────────────────

  const client: Record<string, (b: Record<string, unknown>) => unknown> = {
    async signUp(b) {
      if (!b.email && !b.password) return tokens(await signIn(await create(fresh({ isAnonymous: true }), 'anonymous'), 'anonymous'), 'anonymous');
      const email = String(b.email ?? '').toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new AuthFail('INVALID_EMAIL');
      if (String(b.password ?? '').length < 6) throw new AuthFail('WEAK_PASSWORD : Password should be at least 6 characters');
      if (getByEmail(email)) throw new AuthFail('EMAIL_EXISTS');
      // Upgrading an anonymous user keeps the uid.
      const anon = b.idToken ? fromIdToken(b.idToken) : null;
      const u = anon ?? fresh();
      Object.assign(u, { email, passwordHash: hashPw(String(b.password)), isAnonymous: false, displayName: (b.displayName as string) ?? u.displayName });
      u.providerUserInfo = [...u.providerUserInfo.filter((x) => x.providerId !== 'password'), { providerId: 'password', rawId: email, email, federatedId: email }];
      return tokens(await signIn(anon ? save(u) : await create(u, 'password'), 'password'), 'password');
    },
    async signInWithPassword(b) {
      const u = getByEmail(String(b.email ?? ''));
      if (!u || !checkPw(String(b.password ?? ''), u.passwordHash)) throw new AuthFail(u ? 'INVALID_PASSWORD' : 'EMAIL_NOT_FOUND');
      return tokens(await signIn(live(u), 'password'), 'password');
    },
    async signInWithCustomToken(b) {
      const c = claimsOf(String(b.token ?? ''));
      if (!c || typeof c.uid !== 'string') throw new AuthFail('INVALID_CUSTOM_TOKEN');
      const isNewUser = !get(c.uid);
      const u = await signIn(live(get(c.uid) ?? (await create(fresh({ localId: c.uid }), 'custom'))), 'custom');
      if (c.claims && typeof c.claims === 'object') {
        // Developer claims from createCustomToken(uid, claims) ride on this session's tokens only.
        const merged = { ...(u.customAttributes ? JSON.parse(u.customAttributes) : {}), ...(c.claims as object) };
        return tokens(live({ ...u, customAttributes: JSON.stringify(merged) }), 'custom', { isNewUser });
      }
      return tokens(u, 'custom', { isNewUser });
    },
    lookup(b) {
      return { kind: 'identitytoolkit#GetAccountInfoResponse', users: [userInfo(fromIdToken(b.idToken))] };
    },
    update(b) {
      if (b.oobCode) {
        const r = takeOob(b.oobCode, 'VERIFY_EMAIL');
        q.oobDel.run(r.code);
        const u = live(r.uid ? get(r.uid) : getByEmail(r.email));
        u.emailVerified = true;
        save(u);
        return { kind: 'identitytoolkit#SetAccountInfoResponse', email: u.email, emailVerified: true, localId: u.localId };
      }
      const u = live(fromIdToken(b.idToken));
      let reissue = false;
      if (typeof b.displayName === 'string') u.displayName = b.displayName;
      if (typeof b.photoUrl === 'string') u.photoUrl = b.photoUrl;
      for (const a of (b.deleteAttribute as string[]) ?? []) {
        if (a === 'DISPLAY_NAME') delete u.displayName;
        if (a === 'PHOTO_URL') delete u.photoUrl;
      }
      if (typeof b.password === 'string') {
        if (b.password.length < 6) throw new AuthFail('WEAK_PASSWORD : Password should be at least 6 characters');
        u.passwordHash = hashPw(b.password);
        reissue = true;
      }
      if (typeof b.email === 'string') {
        if (getByEmail(b.email) && getByEmail(b.email)!.localId !== u.localId) throw new AuthFail('EMAIL_EXISTS');
        u.email = b.email.toLowerCase();
        u.emailVerified = false;
        reissue = true;
      }
      save(u);
      return { kind: 'identitytoolkit#SetAccountInfoResponse', localId: u.localId, email: u.email, displayName: u.displayName, photoUrl: u.photoUrl, emailVerified: !!u.emailVerified, providerUserInfo: u.providerUserInfo, ...(reissue || b.returnSecureToken ? { idToken: idToken(u, 'password'), refreshToken: tokens(u, 'password').refreshToken, expiresIn: '3600' } : {}) };
    },
    sendOobCode(b) {
      const kind = String(b.requestType);
      if (kind === 'VERIFY_EMAIL') {
        const u = live(fromIdToken(b.idToken));
        const { link } = oob(kind, u.email ?? null, u.localId, b.continueUrl as string | undefined);
        return { kind: 'identitytoolkit#GetOobConfirmationCodeResponse', email: u.email, ...(b.returnOobLink ? { oobLink: link } : {}) };
      }
      const email = String(b.email ?? '').toLowerCase();
      if (kind === 'PASSWORD_RESET' && !getByEmail(email)) throw new AuthFail('EMAIL_NOT_FOUND');
      const { link } = oob(kind, email, getByEmail(email)?.localId ?? null, b.continueUrl as string | undefined);
      return { kind: 'identitytoolkit#GetOobConfirmationCodeResponse', email, ...(b.returnOobLink ? { oobLink: link } : {}) };
    },
    resetPassword(b) {
      const r = takeOob(b.oobCode, 'PASSWORD_RESET');
      if (b.newPassword === undefined) return { email: r.email, requestType: 'PASSWORD_RESET' };
      const u = live(getByEmail(r.email));
      if (String(b.newPassword).length < 6) throw new AuthFail('WEAK_PASSWORD : Password should be at least 6 characters');
      u.passwordHash = hashPw(String(b.newPassword));
      u.validSince = String(Math.floor(now() / 1000));
      save(u);
      q.oobDel.run(r.code);
      return { email: r.email, requestType: 'PASSWORD_RESET' };
    },
    async signInWithEmailLink(b) {
      const r = takeOob(b.oobCode, 'EMAIL_SIGNIN');
      const email = String(b.email ?? '').toLowerCase();
      if (r.email !== email) throw new AuthFail('INVALID_EMAIL');
      q.oobDel.run(r.code);
      let u = getByEmail(email);
      const isNewUser = !u;
      if (!u) u = await create(fresh({ email, emailVerified: true, providerUserInfo: [{ providerId: 'password', rawId: email, email, federatedId: email }] }), 'emailLink');
      u.emailVerified = true;
      return tokens(await signIn(live(save(u)), 'emailLink'), 'emailLink', { isNewUser });
    },
    createAuthUri(b) {
      const u = getByEmail(String(b.identifier ?? ''));
      return { kind: 'identitytoolkit#CreateAuthUriResponse', registered: !!u, signinMethods: u ? [u.passwordHash ? 'password' : 'emailLink'] : [], sessionId: newId() };
    },
    delete(b) {
      const u = b.localId ? get(String(b.localId)) : fromIdToken(b.idToken);
      if (u) {
        q.del.run(u.localId);
        emitAuth('deleted', u);
      }
      return { kind: 'identitytoolkit#DeleteAccountResponse' };
    },
    sendVerificationCode(b) {
      const phone = String(b.phoneNumber ?? '');
      if (!/^\+[1-9]\d{7,14}$/.test(phone)) throw new AuthFail('INVALID_PHONE_NUMBER');
      const sessionInfo = randomBytes(18).toString('base64url');
      q.codePut.run(sessionInfo, phone, String(randomInt(0, 1e6)).padStart(6, '0'), now());
      return { sessionInfo };
    },
    async signInWithPhoneNumber(b) {
      const r = q.codeGet.get(String(b.sessionInfo ?? '')) as { phone: string; code: string } | undefined;
      if (!r) throw new AuthFail('INVALID_SESSION_INFO');
      if (r.code !== String(b.code)) throw new AuthFail('INVALID_CODE');
      let u = getByPhone(r.phone);
      const isNewUser = !u;
      if (!u) u = await create(fresh({ phoneNumber: r.phone, providerUserInfo: [{ providerId: 'phone', rawId: r.phone, phoneNumber: r.phone }] }), 'phone');
      return { ...tokens(await signIn(live(u), 'phone'), 'phone'), phoneNumber: r.phone, isNewUser };
    },
  };

  // firebase-admin's calls, under /v1/projects/<p>/…
  const admin: Record<string, (b: Record<string, unknown>) => unknown> = {
    accounts(b) {
      const u = fresh({ ...(b.localId ? { localId: String(b.localId) } : {}) });
      if (b.email) Object.assign(u, { email: String(b.email).toLowerCase(), providerUserInfo: [{ providerId: 'password', rawId: String(b.email).toLowerCase(), email: String(b.email).toLowerCase() }] });
      if (b.password) u.passwordHash = hashPw(String(b.password));
      if (b.phoneNumber) {
        u.phoneNumber = String(b.phoneNumber);
        u.providerUserInfo.push({ providerId: 'phone', rawId: u.phoneNumber, phoneNumber: u.phoneNumber });
      }
      if (b.displayName) u.displayName = String(b.displayName);
      if (b.photoUrl) u.photoUrl = String(b.photoUrl);
      if (b.emailVerified !== undefined) u.emailVerified = !!b.emailVerified;
      if (b.disabled !== undefined) u.disabled = !!b.disabled;
      if (get(u.localId)) throw new AuthFail('DUPLICATE_LOCAL_ID');
      // Admin SDK creates skip blocking functions (as in Firebase) but fire the created event.
      save(u);
      emitAuth('created', u);
      return { kind: 'identitytoolkit#SignupNewUserResponse', localId: u.localId };
    },
    'accounts:lookup'(b) {
      const out: UserRec[] = [];
      for (const id of (b.localId as string[]) ?? []) out.push(...[get(id)].filter((x): x is UserRec => !!x));
      for (const e of (b.email as string[]) ?? []) out.push(...[getByEmail(e)].filter((x): x is UserRec => !!x));
      for (const ph of (b.phoneNumber as string[]) ?? []) out.push(...[getByPhone(ph)].filter((x): x is UserRec => !!x));
      return out.length ? { kind: 'identitytoolkit#GetAccountInfoResponse', users: out.map(userInfo) } : { kind: 'identitytoolkit#GetAccountInfoResponse' };
    },
    'accounts:update'(b) {
      const u = get(String(b.localId));
      if (!u) throw new AuthFail('USER_NOT_FOUND');
      if (b.email !== undefined) {
        const e = String(b.email).toLowerCase();
        const other = getByEmail(e);
        if (other && other.localId !== u.localId) throw new AuthFail('EMAIL_EXISTS');
        u.email = e;
      }
      if (b.password !== undefined) {
        u.passwordHash = hashPw(String(b.password));
        if (u.email && !u.providerUserInfo.some((x) => x.providerId === 'password')) u.providerUserInfo.push({ providerId: 'password', rawId: u.email, email: u.email });
      }
      if (b.phoneNumber !== undefined) u.phoneNumber = String(b.phoneNumber);
      if (b.displayName !== undefined) u.displayName = String(b.displayName);
      if (b.photoUrl !== undefined) u.photoUrl = String(b.photoUrl);
      if (b.emailVerified !== undefined) u.emailVerified = !!b.emailVerified;
      if (b.disableUser !== undefined) u.disabled = !!b.disableUser;
      if (b.customAttributes !== undefined) u.customAttributes = String(b.customAttributes);
      if (b.validSince !== undefined) u.validSince = String(b.validSince);
      for (const a of (b.deleteAttribute as string[]) ?? []) {
        if (a === 'DISPLAY_NAME') delete u.displayName;
        if (a === 'PHOTO_URL') delete u.photoUrl;
      }
      for (const prov of (b.deleteProvider as string[]) ?? []) {
        u.providerUserInfo = u.providerUserInfo.filter((x) => x.providerId !== prov);
        if (prov === 'phone') delete u.phoneNumber;
      }
      save(u);
      return { kind: 'identitytoolkit#SetAccountInfoResponse', localId: u.localId };
    },
    'accounts:delete'(b) {
      const u = get(String(b.localId));
      q.del.run(String(b.localId));
      if (u) emitAuth('deleted', u);
      return { kind: 'identitytoolkit#DeleteAccountResponse' };
    },
    'accounts:batchDelete'(b) {
      for (const id of (b.localIds as string[]) ?? []) {
        const u = get(id);
        q.del.run(id);
        if (u) emitAuth('deleted', u);
      }
      return {};
    },
    'accounts:sendOobCode'(b) {
      return client.sendOobCode!({ ...b, returnOobLink: true });
    },
    'accounts:query'(b) {
      const all = (db.prepare(`SELECT rec FROM users ORDER BY uid`).all() as { rec: string }[]).map(read).filter((x): x is UserRec => !!x);
      return { recordsCount: String(all.length), ...(b.returnUserInfo === false ? {} : { userInfo: all.map(userInfo) }) };
    },
  };

  return {
    async handle(req, url) {
      const path = url.pathname;
      try {
        if (path.startsWith('/identitytoolkit.googleapis.com/')) {
          const rest = path.replace(/^\/identitytoolkit\.googleapis\.com\/v[12]\//, '');
          if (req.method === 'GET') {
            const m = /^projects\/[^/]+\/accounts:batchGet$/.exec(rest);
            if (m) {
              const max = Math.min(Number(url.searchParams.get('maxResults') ?? 1000), 1000);
              const after = url.searchParams.get('nextPageToken') ?? '';
              const users = (q.page.all(after, max) as { rec: string }[]).map(read).filter((x): x is UserRec => !!x);
              return json({ kind: 'identitytoolkit#DownloadAccountResponse', users: users.map(userInfo), ...(users.length === max ? { nextPageToken: users[users.length - 1]!.localId } : {}) });
            }
            if (/^projects\/[^/]+\/config$/.test(rest) || rest === 'recaptchaParams') return json({ signIn: { allowDuplicateEmails: false }, recaptchaStoken: 'fake' });
            return null;
          }
          const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
          const proj = /^projects\/[^/]+\/(.+)$/.exec(rest);
          if (proj) {
            const fn = admin[proj[1]!] ?? client[proj[1]!.replace(/^accounts:/, '')];
            if (fn) return json(await fn(body));
          }
          const fn = client[rest.replace(/^accounts:/, '')];
          if (fn) return json(await fn(body));
          return null;
        }
        if (path === '/securetoken.googleapis.com/v1/token') {
          const form = new URLSearchParams(await req.text());
          const r = q.refreshGet.get(form.get('refresh_token') ?? '') as { uid: string; provider: string } | undefined;
          if (!r) return fail('INVALID_REFRESH_TOKEN');
          const u = get(r.uid);
          if (!u) return fail('USER_NOT_FOUND');
          if (u.disabled) return fail('USER_DISABLED');
          const t = idToken(u, r.provider);
          return json({ id_token: t, access_token: t, refresh_token: form.get('refresh_token'), expires_in: '3600', token_type: 'Bearer', user_id: u.localId, project_id: p });
        }
        const emu = /^\/emulator\/v1\/projects\/[^/]+\/(oobCodes|verificationCodes|accounts)$/.exec(path);
        if (emu) {
          if (emu[1] === 'oobCodes') return json({ oobCodes: (q.oobAll.all() as { code: string; email: string; kind: string; link: string }[]).map((r) => ({ email: r.email, requestType: r.kind, oobCode: r.code, oobLink: r.link })) });
          if (emu[1] === 'verificationCodes') return json({ verificationCodes: (q.codeAll.all() as { phone: string; code: string; session: string }[]).map((r) => ({ phoneNumber: r.phone, code: r.code, sessionInfo: r.session })) });
          if (req.method === 'DELETE') {
            db.exec(`DELETE FROM users; DELETE FROM refresh; DELETE FROM oob; DELETE FROM phone_codes;`);
            return json({});
          }
        }
        return null;
      } catch (e) {
        if (e instanceof AuthFail) return fail(e.msg);
        throw e;
      }
    },
    close: () => db.close(),
  };
}

