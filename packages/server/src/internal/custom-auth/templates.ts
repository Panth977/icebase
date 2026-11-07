// Default messages and pages for custom auth. Plain, readable, no tracking. Override any of
// them with createAuthHandler({ templates: { … } }).

export interface TemplateVars {
  site: string;
  email?: string;
  link?: string;
  code?: string;
  device: string;
  minutes: number;
}

export type EmailTemplate = (v: TemplateVars) => { subject: string; html: string; text: string };
export interface Templates {
  signInApproval: EmailTemplate;
  signInLink: EmailTemplate;
  signInCode: EmailTemplate;
  passwordReset: EmailTemplate;
  verifyEmail: EmailTemplate;
  phoneCode: (v: TemplateVars) => { text: string };
}

/** How IceBase's sign-in emails and pages look (config.auth.custom.brand). Every field optional. */
export interface Brand {
  /** An absolute https URL of the logo. PNG or JPEG for email (Gmail and Outlook drop SVG). */
  logoUrl?: string;
  /** Logo height in pixels (default 40). */
  logoHeight?: number;
  /** The colour of the main button and links (default #1f6feb). */
  accent?: string;
  /** Text on the main button (default #ffffff). */
  onAccent?: string;
  /** The page / email background (default #f5f6f8). */
  background?: string;
  /** The card (default #ffffff). */
  card?: string;
  /** Body text (default #1b1e24). */
  ink?: string;
  /** Secondary text (default #6a7280). */
  muted?: string;
  /** CSS font-family for text, and for headings. Web fonts load on the pages via fontCssUrl; email falls back. */
  font?: string;
  headingFont?: string;
  /** An https stylesheet with @font-face rules, linked from the pages (not from email). */
  fontCssUrl?: string;
}

const COLOR = /^#[0-9a-fA-F]{3,8}$|^rgba?\([0-9.,\s%/]+\)$/;
const FONT = /^[\w\s,'"-]+$/;
const httpsUrl = (u: string | undefined) => {
  if (!u) return undefined;
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.hostname === 'localhost' || x.hostname === '127.0.0.1' ? x.toString() : undefined;
  } catch {
    return undefined;
  }
};
/** The brand with defaults filled in, and anything that is not a plain colour / font name / https URL dropped. */
export function resolveBrand(b: Brand = {}): Required<Omit<Brand, 'logoUrl' | 'fontCssUrl'>> & { logoUrl?: string; fontCssUrl?: string } {
  const c = (v: string | undefined, d: string) => (v && COLOR.test(v) ? v : d);
  const f = (v: string | undefined, d: string) => (v && FONT.test(v) ? v : d);
  const sys = '-apple-system,Segoe UI,Roboto,sans-serif';
  const logoUrl = httpsUrl(b.logoUrl);
  const fontCssUrl = httpsUrl(b.fontCssUrl);
  return {
    ...(logoUrl ? { logoUrl } : {}),
    ...(fontCssUrl ? { fontCssUrl } : {}),
    logoHeight: Number.isFinite(b.logoHeight) && b.logoHeight! > 0 && b.logoHeight! <= 160 ? Math.round(b.logoHeight!) : 40,
    accent: c(b.accent, '#1f6feb'),
    onAccent: c(b.onAccent, '#ffffff'),
    background: c(b.background, '#f5f6f8'),
    card: c(b.card, '#ffffff'),
    ink: c(b.ink, '#1b1e24'),
    muted: c(b.muted, '#6a7280'),
    font: f(b.font, sys),
    headingFont: f(b.headingFont ?? b.font, sys),
  };
}

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const mailWith = (b: ReturnType<typeof resolveBrand>) => (title: string, lead: string, action: { label: string; link: string } | { code: string }, foot: string) => `<!doctype html>
<html><body style="margin:0;background:${b.background};font:15px/1.5 ${b.font};color:${b.ink}">
<div style="max-width:480px;margin:32px auto;background:${b.card};border-radius:12px;padding:28px">
${b.logoUrl ? `<img src="${esc(b.logoUrl)}" alt="" height="${b.logoHeight}" style="display:block;height:${b.logoHeight}px;width:auto;margin:0 0 20px;border:0">` : ''}
<h1 style="font:400 22px/1.2 ${b.headingFont};margin:0 0 12px">${esc(title)}</h1>
<p style="margin:0 0 20px">${lead}</p>
${'link' in action ? `<p style="margin:0 0 20px"><a href="${esc(action.link)}" style="display:inline-block;background:${b.accent};color:${b.onAccent};text-decoration:none;padding:11px 18px;border-radius:999px;font-weight:600">${esc(action.label)}</a></p>` : `<p style="font:600 28px/1 ui-monospace,Menlo,monospace;letter-spacing:6px;margin:0 0 20px">${esc(action.code)}</p>`}
<p style="margin:0;color:${b.muted};font-size:13px">${foot}</p>
</div></body></html>`;

/** The default messages, in a brand's look (config.auth.custom.brand). */
export function templatesFor(brand?: Brand): Templates {
  const mail = mailWith(resolveBrand(brand));
  return {
  signInApproval: (v) => ({
    subject: `Sign in to ${v.site}?`,
    html: mail(`Sign in to ${v.site}?`, `Something is asking to sign in as <b>${esc(v.email ?? '')}</b> from <b>${esc(v.device)}</b>. Open the link to approve or refuse it.`, { label: 'Review sign-in', link: v.link! }, `The link works for ${v.minutes} minutes. If this wasn't you, open it and press "This wasn't me".`),
    text: `Something is asking to sign in to ${v.site} as ${v.email} from ${v.device}.\nReview it: ${v.link}\nThe link works for ${v.minutes} minutes.`,
  }),
  signInLink: (v) => ({
    subject: `Your sign-in link for ${v.site}`,
    html: mail(`Sign in to ${v.site}`, `Press the button to sign in as <b>${esc(v.email ?? '')}</b>.`, { label: `Sign in to ${v.site}`, link: v.link! }, `The link works once, for ${v.minutes} minutes. If you didn't ask for it, ignore this email.`),
    text: `Sign in to ${v.site}: ${v.link}\nThe link works once, for ${v.minutes} minutes.`,
  }),
  signInCode: (v) => ({
    subject: `${v.code} is your ${v.site} code`,
    html: mail(`Your ${v.site} code`, `Enter this code to sign in as <b>${esc(v.email ?? '')}</b>.`, { code: v.code! }, `It works for ${v.minutes} minutes. If you didn't ask for it, ignore this email.`),
    text: `Your ${v.site} code: ${v.code}\nIt works for ${v.minutes} minutes.`,
  }),
  passwordReset: (v) => ({
    subject: `Reset your ${v.site} password`,
    html: mail(`Reset your password`, `Someone asked to reset the password for <b>${esc(v.email ?? '')}</b> on ${esc(v.site)}.`, { label: 'Choose a new password', link: v.link! }, `The link works once, for ${v.minutes} minutes. If you didn't ask, ignore this email; your password stays the same.`),
    text: `Reset your ${v.site} password: ${v.link}\nThe link works once, for ${v.minutes} minutes.`,
  }),
  verifyEmail: (v) => ({
    subject: `Confirm your email for ${v.site}`,
    html: mail(`Confirm your email`, `Confirm that <b>${esc(v.email ?? '')}</b> is yours.`, { label: 'Confirm email', link: v.link! }, `The link works for ${v.minutes} minutes.`),
    text: `Confirm your email for ${v.site}: ${v.link}`,
  }),
  phoneCode: (v) => ({ text: `${v.code} is your ${v.site} code. It works for ${v.minutes} minutes.` }),
  };
}

export const defaultTemplates: Templates = templatesFor();

/** The HTML shell of IceBase's own pages (approval, password reset, verify email), in a brand's look. */
export const page = (title: string, body: string, script = '', brand?: Brand) => {
  const b = resolveBrand(brand);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>${b.fontCssUrl ? `\n<link rel="stylesheet" href="${esc(b.fontCssUrl)}">` : ''}
<style>
body{margin:0;background:${b.background};font:16px/1.5 ${b.font};color:${b.ink}}
main{max-width:440px;margin:10vh auto;background:${b.card};border-radius:14px;padding:28px;box-shadow:0 1px 3px #0001}
.logo{display:block;height:${b.logoHeight}px;width:auto;margin:0 0 20px}
h1{font:400 26px/1.15 ${b.headingFont};margin:0 0 12px} p{margin:0 0 16px} .muted{color:${b.muted};font-size:14px}
button,input{font:inherit;border-radius:999px;padding:12px 16px;width:100%;box-sizing:border-box}
input{border:1px solid #0002;border-radius:10px;margin:0 0 12px} button{border:0;font-weight:600;cursor:pointer;margin:0 0 10px}
.go{background:${b.accent};color:${b.onAccent}} .no{background:transparent;color:${b.ink};border:1px solid #0002} .ok{color:#1a7f37} .bad{color:#cf222e}
a{color:${b.accent}}
</style></head><body><main>${b.logoUrl ? `<img class="logo" src="${esc(b.logoUrl)}" alt="">` : ''}${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
};
