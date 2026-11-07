// The custom-auth endpoint and the Origin of the requests it takes: the app's authorized domains,
// and its own origin (its approval and action pages post back to it from there).
import { describe, expect, it } from 'vitest';
import { defineConfig, senders } from '@panth977/icebase/config';
import { defineSchema } from '@panth977/icebase/schema';
import { createAuthHandler } from '../server/src/auth.ts';

const cfg = defineConfig({
  name: 'origin-check',
  schema: defineSchema({}),
  auth: { providers: [], authorizedDomains: ['shop.example'], custom: { endpoint: 'https://auth.example.net/icebaseAuth', email: { sender: senders.console(), signIn: 'approval' } } },
  firebase: { projectId: 'demo-origin' },
  environments: { prod: { mode: 'firebase' } },
});

describe('custom auth · request origins', () => {
  const handler = createAuthHandler(cfg, 'prod', {});
  const approve = (origin: string) =>
    handler(new Request('https://auth.example.net/icebaseAuth/email/approve', { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify({ t: 'nope.nope' }) }));

  it('takes its own origin (its approval page) and the authorized domains, refuses the rest', async () => {
    const statusOf = async (o: string) => {
      const r = await approve(o);
      return { status: r.status, code: ((await r.json()) as { error?: { code: string } }).error?.code };
    };
    // Past the origin check: the (bogus) token is what is refused.
    expect((await statusOf('https://auth.example.net')).code).not.toBe('auth/unauthorized-domain');
    expect((await statusOf('https://shop.example')).code).not.toBe('auth/unauthorized-domain');
    expect(await statusOf('https://evil.example')).toEqual({ status: 403, code: 'auth/unauthorized-domain' });
    expect((await statusOf('https://auth.example.net.evil.example')).code).toBe('auth/unauthorized-domain');
  });
});
