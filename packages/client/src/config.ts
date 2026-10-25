// icebase/config — the one config file (icebase.config.ts).

import { configError } from './errors.ts';
import type { AnyCollection, FieldMap, Infer, Schema } from './schema.ts';

/** Where a service runs.
 * firebase — the real Firebase product (default).
 * emulator — local IceBase server, SQLite + disk; for development and CI.
 * vm — self-hosted IceBase server (one Docker image) on Postgres. Not in phase 1. */
export type Mode = 'firebase' | 'emulator' | 'vm';
export type Service = 'firestore' | 'auth' | 'database' | 'storage' | 'functions' | 'hosting';
export const SERVICES: readonly Service[] = ['firestore', 'auth', 'database', 'storage', 'functions', 'hosting'];

export interface Environment {
  /** Mode for every service in this environment… */
  mode: Mode;
  /** …unless overridden per service, e.g. Firestore on Firebase but functions on the VM. */
  services?: Partial<Record<Service, Mode>>;
}

/** Firebase's web app config (public, not a secret). */
export interface FirebaseWebConfig {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  databaseURL?: string;
  measurementId?: string;
}

export type AuthProviderId = 'password' | 'anonymous' | 'emailLink' | 'phone' | 'google';

/** Where a custom-auth message is sent from. Secrets are env-var names. */
export type EmailSender =
  | { kind: 'smtp'; urlEnv: string; from: string }
  | { kind: 'resend'; apiKeyEnv: string; from: string }
  | { kind: 'console' };
export type PhoneSender =
  | { kind: 'whatsappCloud'; tokenEnv: string; phoneNumberIdEnv: string; template: string; language?: string }
  | { kind: 'infobipWhatsapp'; apiKeyEnv: string; baseUrl: string; from: string; template: string; language?: string }
  | { kind: 'twilio'; accountSidEnv: string; authTokenEnv: string; from: string }
  | { kind: 'msg91'; authKeyEnv: string; templateId: string }
  | { kind: 'console' };

export interface CustomAuthConfig {
  /** Where the IceBase auth endpoint is served. Default: the generated `icebaseAuth` function
   * (firebase mode: https://<region>-<project>.cloudfunctions.net/icebaseAuth; emulator: the IceBase server). */
  endpoint?: string;
  /** What the person is signing into, shown in emails and on the approval page. Default: config.name. */
  site?: string;
  email?: {
    /** A built-in sender, or 'handler' to send it yourself (createAuthHandler({ senders: { email } })). */
    sender: EmailSender | 'handler';
    /** 'approval' (cross-device approve button), 'link' (sign-in link) or 'code' (6 digits). Default 'link'. */
    signIn?: 'approval' | 'link' | 'code';
    /** Page that handles reset-password and verify-email links. Default: IceBase's own page at <endpoint>/action. */
    actionUrl?: string;
  };
  phone?: { sender: PhoneSender | 'handler'; codeLength?: number };
  google?: { clientIdEnv: string; clientSecretEnv: string };
  security?: {
    /** Realtime Database instance + root path for challenges, counters, blocks. */
    store?: { database?: string; path?: string };
    limits?: {
      perIdentifier?: { perHour?: number; perDay?: number };
      perIp?: { perHour?: number };
      global?: { phoneSendsPerDay?: number; emailSendsPerDay?: number };
    };
    challenge?: { ttlMinutes?: number; maxAttempts?: number };
    blockMinutes?: number;
    /** e.g. emailDomains: ['acme.com'], phonePrefixes: ['+91', '+1']. Default: everything. */
    allow?: { emailDomains?: string[]; phonePrefixes?: string[] };
  };
}

export interface IceBaseConfig<C extends Record<string, AnyCollection>, E extends string, K extends FieldMap = FieldMap> {
  name: string;
  schema: Schema<C, any, any>;
  /** Firebase rules syntax, used by every mode. Paths relative to the project root. */
  rules?: { firestore?: string; storage?: string; database?: string };
  functions?: { source: string; runtime?: 'nodejs20' | 'nodejs22'; region?: string };
  hosting?: {
    public: string;
    site?: string;
    spa?: boolean;
    cleanUrls?: boolean;
    trailingSlash?: boolean;
    rewrites?: ({ source: string; function: string; region?: string } | { source: string; destination: string })[];
    redirects?: { source: string; destination: string; type?: 301 | 302 }[];
    headers?: { source: string; headers: Record<string, string> }[];
  };
  auth?: {
    providers: AuthProviderId[];
    authorizedDomains?: string[];
    /** Custom claims, typed (SCH-6): setCustomUserClaims, getIdTokenResult().claims and request.auth.token use them. */
    claims?: K;
    /** Take over sign-in with your own senders and OAuth client (see docs/prd/custom-auth.html). */
    custom?: CustomAuthConfig;
  };
  storage?: { maxUploadMb?: number };
  /** The API's schema (icebase/api defineApi): every callable and HTTP endpoint, its input and output. */
  api?: import('./api.ts').Api;

  /** Needed when any environment uses mode 'firebase'. Secrets come from env vars, never from this file. */
  firebase?: {
    projectId: string;
    /** The web config inline (it is public), or… */
    webConfig?: FirebaseWebConfig;
    /** …the name of an env var holding it as JSON. */
    webConfigEnv?: string;
    /** Env var holding a service-account JSON or a path to one (admin only). Unset = application default credentials. */
    serviceAccountEnv?: string;
    databaseURL?: string;
    storageBucket?: string;
  };
  /** Needed when any environment uses mode 'vm' (phase 3). */
  vm?: { url: string; databaseUrlEnv: string; blobs?: { kind: 'disk'; dir: string } | { kind: 's3'; bucket: string; endpointEnv?: string } };
  /** Emulator defaults: data in .icebase/, API on :4400, hosting on :5002. */
  emulator?: { dataDir?: string; port?: number; hostingPort?: number; host?: string; seed?: string; /** Sign ID tokens and refuse unsigned ones (a server others reach). */ signTokens?: boolean };

  environments: Record<E, Environment>;
  /** Same console GUI for every mode. */
  console?: { port?: number; enabled?: boolean };
}

export type AnyConfig = IceBaseConfig<Record<string, AnyCollection>, string, any>;
export type EnvOf<Cfg> = Cfg extends IceBaseConfig<any, infer E> ? E : never;
/** The custom claims declared in config.auth.claims (all optional: a user may have none yet). */
export type ClaimsOf<Cfg> = Cfg extends IceBaseConfig<any, any, infer K> ? (FieldMap extends K ? Record<string, unknown> : Partial<Infer<K>>) : Record<string, unknown>;

const MODES: readonly Mode[] = ['firebase', 'emulator', 'vm'];

export function defineConfig<const C extends Record<string, AnyCollection>, const E extends string, const K extends FieldMap = {}>(c: IceBaseConfig<C, E, K>): IceBaseConfig<C, E, K> {
  if (!c || typeof c.name !== 'string' || !c.name) throw configError('defineConfig: `name` is required');
  if (!c.schema || typeof c.schema !== 'object' || !('collections' in c.schema)) throw configError('defineConfig: `schema` must come from defineSchema(…)');
  const envs = Object.entries(c.environments ?? {}) as [string, Environment][];
  if (envs.length === 0) throw configError('defineConfig: declare at least one environment, e.g. environments: { local: { mode: "emulator" } }');
  for (const [name, env] of envs) {
    if (!MODES.includes(env.mode)) throw configError(`defineConfig: environments.${name}.mode must be one of ${MODES.join(', ')}`);
    for (const [svc, mode] of Object.entries(env.services ?? {})) {
      if (!SERVICES.includes(svc as Service)) throw configError(`defineConfig: environments.${name}.services.${svc} is not a service (${SERVICES.join(', ')})`);
      if (!MODES.includes(mode as Mode)) throw configError(`defineConfig: environments.${name}.services.${svc} must be one of ${MODES.join(', ')}`);
    }
  }
  const uses = (m: Mode) => envs.some(([, e]) => e.mode === m || Object.values(e.services ?? {}).includes(m));
  if (uses('firebase') && !c.firebase?.projectId) throw configError('defineConfig: an environment uses mode "firebase", so `firebase.projectId` is required');
  if (uses('vm') && !c.vm?.url) throw configError('defineConfig: an environment uses mode "vm", so `vm.url` is required');
  return c;
}

/** The mode of every service in one environment. */
export function resolveModes(config: AnyConfig, env: string): Record<Service, Mode> {
  const e = (config.environments as Record<string, Environment>)[env];
  if (!e) throw configError(`environment '${env}' is not in icebase.config (environments: ${Object.keys(config.environments).join(', ')})`);
  const out = {} as Record<Service, Mode>;
  for (const s of SERVICES) out[s] = e.services?.[s] ?? e.mode;
  return out;
}

/** Read an env var in Node, Deno, Bun or a bundler that defines process.env. */
export function readEnv(name: string): string | undefined {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> }; Deno?: { env: { get(n: string): string | undefined } } };
  return g.process?.env?.[name] ?? g.Deno?.env.get(name);
}

/** Built-in senders for config.auth.custom (secrets are env-var names). */
export const senders = {
  smtp: (o: { urlEnv: string; from: string }): EmailSender => ({ kind: 'smtp', ...o }),
  resend: (o: { apiKeyEnv: string; from: string }): EmailSender => ({ kind: 'resend', ...o }),
  whatsappCloud: (o: { tokenEnv: string; phoneNumberIdEnv: string; template: string; language?: string }): PhoneSender => ({ kind: 'whatsappCloud', ...o }),
  infobipWhatsapp: (o: { apiKeyEnv: string; baseUrl: string; from: string; template: string; language?: string }): PhoneSender => ({ kind: 'infobipWhatsapp', ...o }),
  twilio: (o: { accountSidEnv: string; authTokenEnv: string; from: string }): PhoneSender => ({ kind: 'twilio', ...o }),
  msg91: (o: { authKeyEnv: string; templateId: string }): PhoneSender => ({ kind: 'msg91', ...o }),
  /** Logs the message (and shows it in the emulator's outbox). For development. */
  console: (): EmailSender & PhoneSender => ({ kind: 'console' }),
};
