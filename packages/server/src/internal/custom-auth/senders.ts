// Built-in senders for custom auth. Each throws with the provider's own words on failure:
// "template not found" or "number not on WhatsApp" is a two-minute fix only if you can read it.

import type { EmailSender, PhoneSender } from '@panth977/icebase/config';
import { readEnv } from '@panth977/icebase/config';
import { IceBaseError } from '@panth977/icebase/errors';

export interface EmailMessage {
  kind: 'signIn' | 'passwordReset' | 'verifyEmail';
  to: string;
  /** The approval / sign-in / action link, when there is one. */
  link?: string;
  code?: string;
  device: string;
  site: string;
  minutes: number;
  rendered: { subject: string; html: string; text: string };
}
export interface PhoneMessage {
  to: string;
  code: string;
  site: string;
  minutes: number;
  rendered: { text: string };
}
export type EmailSendFn = (m: EmailMessage) => Promise<void>;
export type PhoneSendFn = (m: PhoneMessage) => Promise<void>;

/** What console senders wrote, newest last (the emulator console shows it). */
export const outbox: { at: number; channel: 'email' | 'phone'; to: string; subject?: string; text: string; link?: string; code?: string }[] = [];

const need = (name: string): string => {
  const v = readEnv(name);
  if (!v) throw new IceBaseError('failed-precondition', `custom auth: env var ${name} is not set`, { reason: 'config', service: 'auth' });
  return v;
};

async function check(res: Response, who: string): Promise<void> {
  if (res.ok) return;
  const said = (await res.text()).slice(0, 400);
  throw new IceBaseError('unavailable', `${who} ${res.status}: ${said}`, { service: 'auth' });
}

export function emailSender(s: EmailSender): EmailSendFn {
  switch (s.kind) {
    case 'console':
      return async (m) => {
        outbox.push({ at: Date.now(), channel: 'email', to: m.to, subject: m.rendered.subject, text: m.rendered.text, ...(m.link ? { link: m.link } : {}), ...(m.code ? { code: m.code } : {}) });
        console.log(`[icebase auth] email to ${m.to}: ${m.rendered.subject}\n${m.rendered.text}`);
      };
    case 'resend':
      return async (m) => {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${need(s.apiKeyEnv)}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: s.from, to: [m.to], subject: m.rendered.subject, html: m.rendered.html, text: m.rendered.text }),
        });
        await check(res, 'Resend');
      };
    case 'smtp':
      return async (m) => {
        let nodemailer: { createTransport(url: string): { sendMail(o: object): Promise<unknown> } };
        try {
          const name: string = 'nodemailer';
          nodemailer = (await import(/* @vite-ignore */ name)) as typeof nodemailer;
        } catch {
          throw new IceBaseError('failed-precondition', 'custom auth smtp sender needs the `nodemailer` package installed next to icebase', { reason: 'config', service: 'auth' });
        }
        const t = (nodemailer as unknown as { default?: typeof nodemailer }).default ?? nodemailer;
        await t.createTransport(need(s.urlEnv)).sendMail({ from: s.from, to: m.to, subject: m.rendered.subject, html: m.rendered.html, text: m.rendered.text });
      };
  }
}

export function phoneSender(s: PhoneSender): PhoneSendFn {
  switch (s.kind) {
    case 'console':
      return async (m) => {
        outbox.push({ at: Date.now(), channel: 'phone', to: m.to, text: m.rendered.text, code: m.code });
        console.log(`[icebase auth] code for ${m.to}: ${m.code}`);
      };
    case 'whatsappCloud':
      // WhatsApp authentication template: the code in the body and again on the copy-code button.
      return async (m) => {
        const res = await fetch(`https://graph.facebook.com/v21.0/${need(s.phoneNumberIdEnv)}/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${need(s.tokenEnv)}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: m.to.replace(/^\+/, ''),
            type: 'template',
            template: {
              name: s.template,
              language: { code: s.language ?? 'en' },
              components: [
                { type: 'body', parameters: [{ type: 'text', text: m.code }] },
                { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: m.code }] },
              ],
            },
          }),
        });
        await check(res, 'WhatsApp Cloud API');
      };
    case 'infobipWhatsapp':
      return async (m) => {
        const res = await fetch(`${s.baseUrl.replace(/\/$/, '')}/whatsapp/1/message/template`, {
          method: 'POST',
          headers: { authorization: `App ${need(s.apiKeyEnv)}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({
            messages: [{ from: s.from, to: m.to.replace(/^\+/, ''), content: { templateName: s.template, templateData: { body: { placeholders: [m.code] }, buttons: [{ type: 'URL', parameter: m.code }] }, language: s.language ?? 'en' } }],
          }),
        });
        await check(res, 'Infobip');
      };
    case 'twilio':
      return async (m) => {
        const sid = need(s.accountSidEnv);
        const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
          method: 'POST',
          headers: { authorization: `Basic ${btoa(`${sid}:${need(s.authTokenEnv)}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ To: m.to, From: s.from, Body: m.rendered.text }),
        });
        await check(res, 'Twilio');
      };
    case 'msg91':
      return async (m) => {
        const u = new URL('https://control.msg91.com/api/v5/otp');
        u.searchParams.set('template_id', s.templateId);
        u.searchParams.set('mobile', m.to.replace(/^\+/, ''));
        u.searchParams.set('otp', m.code);
        const res = await fetch(u, { method: 'POST', headers: { authkey: need(s.authKeyEnv), 'content-type': 'application/json' }, body: '{}' });
        await check(res, 'MSG91');
      };
  }
}
