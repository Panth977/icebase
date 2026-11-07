// config.auth.custom.brand: IceBase's sign-in emails and pages in the app's look — and nothing
// in it can break out of the CSS or the markup.
import { describe, expect, it } from 'vitest';
import { defineConfig, senders } from '@panth977/icebase/config';
import { defineSchema } from '@panth977/icebase/schema';
import { createAuthHandler } from '../server/src/auth.ts';
import { page, resolveBrand, templatesFor } from '../server/src/internal/custom-auth/templates.ts';

const brand = { logoUrl: 'https://shop.example/email/logo.png', logoHeight: 44, accent: '#2f6d43', background: '#f5f1ea', card: '#fffdf8', ink: '#14110d', font: "Sanchez, Georgia, serif", headingFont: "Shrikhand, Georgia, serif", fontCssUrl: 'https://shop.example/fonts.css' };

describe('custom auth · brand', () => {
  it('emails carry the logo, colours and fonts', () => {
    const m = templatesFor(brand).signInApproval({ site: 'Shop', email: 'a@b.c', link: 'https://x/y', device: 'Chrome on macOS', minutes: 10 });
    expect(m.html).toContain('<img src="https://shop.example/email/logo.png"');
    expect(m.html).toContain('height:44px');
    expect(m.html).toContain('background:#2f6d43');
    expect(m.html).toContain('background:#f5f1ea');
    expect(m.html).toContain('Shrikhand, Georgia, serif');
    expect(m.text).not.toContain('<');
  });

  it('pages carry the logo, colours and the font stylesheet', () => {
    const h = page('T', '<h1>Hi</h1>', '', brand);
    expect(h).toContain('<link rel="stylesheet" href="https://shop.example/fonts.css">');
    expect(h).toContain('<img class="logo" src="https://shop.example/email/logo.png"');
    expect(h).toContain('.go{background:#2f6d43');
  });

  it('without a brand: the plain default, as before', () => {
    expect(page('T', 'x')).not.toContain('<img');
    expect(templatesFor().signInCode({ site: 'S', email: 'a@b.c', code: '123456', device: 'd', minutes: 10 }).html).toContain('background:#f5f6f8');
  });

  it('drops anything that is not a plain colour, font name or https URL', () => {
    const r = resolveBrand({ accent: 'red;}body{display:none', font: 'x;}</style><script>', logoUrl: 'javascript:alert(1)', fontCssUrl: 'http://evil.example/a.css', logoHeight: 9999 });
    expect(r.accent).toBe('#1f6feb');
    expect(r.font).not.toContain('<');
    expect(r.logoUrl).toBeUndefined();
    expect(r.fontCssUrl).toBeUndefined();
    expect(r.logoHeight).toBe(40);
    expect(page('T', 'x', '', { logoUrl: 'https://a.example/"><script>x</script>.png' })).not.toContain('"><script>');
  });

  it('the endpoint\'s own pages use config.auth.custom.brand', async () => {
    const cfg = defineConfig({
      name: 'brand',
      schema: defineSchema({}),
      auth: { providers: [], custom: { endpoint: 'https://auth.example.net/icebaseAuth', email: { sender: senders.console(), signIn: 'approval' }, brand } },
      firebase: { projectId: 'demo-brand' },
      environments: { prod: { mode: 'firebase' } },
    });
    const res = await createAuthHandler(cfg, 'prod', {})(new Request('https://auth.example.net/icebaseAuth/email/page?t=nope.nope'));
    const h = await res.text();
    expect(h).toContain('This link no longer works');
    expect(h).toContain('https://shop.example/email/logo.png');
    expect(h).toContain('#2f6d43');
  });
});
