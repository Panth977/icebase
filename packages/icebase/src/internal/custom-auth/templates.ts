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

export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const mail = (title: string, lead: string, action: { label: string; link: string } | { code: string }, foot: string) => `<!doctype html>
<html><body style="margin:0;background:#f5f6f8;font:15px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1b1e24">
<div style="max-width:480px;margin:32px auto;background:#fff;border-radius:12px;padding:28px">
<h1 style="font-size:20px;margin:0 0 12px">${esc(title)}</h1>
<p style="margin:0 0 20px">${lead}</p>
${'link' in action ? `<p style="margin:0 0 20px"><a href="${esc(action.link)}" style="display:inline-block;background:#1f6feb;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600">${esc(action.label)}</a></p>` : `<p style="font:600 28px/1 ui-monospace,Menlo,monospace;letter-spacing:6px;margin:0 0 20px">${esc(action.code)}</p>`}
<p style="margin:0;color:#6a7280;font-size:13px">${foot}</p>
</div></body></html>`;

export const defaultTemplates: Templates = {
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

/** The HTML shell of IceBase's own pages (approval, password reset, verify email). */
export const page = (title: string, body: string, script = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>${esc(title)}</title>
<style>
body{margin:0;background:#f5f6f8;font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#1b1e24}
main{max-width:440px;margin:10vh auto;background:#fff;border-radius:14px;padding:28px;box-shadow:0 1px 3px #0001}
h1{font-size:21px;margin:0 0 10px} p{margin:0 0 16px} .muted{color:#6a7280;font-size:14px}
button,input{font:inherit;border-radius:9px;padding:11px 14px;width:100%;box-sizing:border-box}
input{border:1px solid #cfd4dc;margin:0 0 12px} button{border:0;font-weight:600;cursor:pointer;margin:0 0 10px}
.go{background:#1f6feb;color:#fff} .no{background:#eef0f3;color:#1b1e24} .ok{color:#1a7f37} .bad{color:#cf222e}
</style></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ''}</body></html>`;
