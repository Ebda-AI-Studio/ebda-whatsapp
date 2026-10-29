import { createExecutionContext, env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlatformOtp } from '../src/index';
import { stubGraph } from './helpers/graph';
import { storeWorkspace, useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

// Ruling WA-OTP-SENDER-1: a platform account's sign-in code is sent from the platform number only and is never written anywhere a store can see.
useStoreLink();
afterEach(() => vi.restoreAllMocks());
const CODE = 'K7Q93X';
const PLATFORM = { PLATFORM_OTP_PHONE_NUMBER_ID: 'platform-pn-1', PLATFORM_OTP_TEMPLATE: 'platform_otp_code' };
const svc = (over: Record<string, unknown> = PLATFORM) => new PlatformOtp(createExecutionContext(), { ...env, ...over } as typeof env);
const posts = (g: ReturnType<typeof stubGraph>) => g.calls.filter((c) => c.method === 'POST');
const W = (n: number) => `00000000-0000-4000-8000-0000000049${String(n).padStart(2, '0')}`;

describe('PlatformOtp.sendCode', () => {
  it('is OFF until the platform number and its template are configured: nothing is sent', async () => {
    const g = stubGraph();
    for (const over of [{}, { PLATFORM_OTP_PHONE_NUMBER_ID: 'platform-pn-1' }, { PLATFORM_OTP_TEMPLATE: 'platform_otp_code' }]) {
      expect(await svc(over).sendCode('01001234567', CODE)).toEqual({ ok: false, reason: 'disabled' });
    }
    expect(g.calls).toEqual([]);
  });

  it('sends the authentication template from the PLATFORM number to the normalised phone, and rejects bad input and other countries before any call', async () => {
    const g = stubGraph();
    expect(await svc().sendCode('٠١٠٠١٢٣٤٥٦٧', CODE)).toEqual({ ok: true });
    expect(posts(g)).toHaveLength(1);
    expect(posts(g)[0]!.url).toContain('/platform-pn-1/messages');
    expect(posts(g)[0]!.body).toMatchObject({ to: '201001234567', type: 'template', template: { name: 'platform_otp_code', language: { code: 'ar' } } });
    expect(await svc().sendCode('not a phone', CODE)).toEqual({ ok: false, reason: 'invalid' });
    expect(await svc().sendCode('01001234567', 'bad code!')).toEqual({ ok: false, reason: 'invalid' });
    expect(await svc().sendCode('+14155550123', CODE)).toEqual({ ok: false, reason: 'country_not_allowed' });
    expect(posts(g)).toHaveLength(1);
  });

  it('a Meta refusal or a network failure is send_failed (the caller keeps email)', async () => {
    stubGraph(() => ({ status: 400, json: { error: { message: 'bad', code: 100 } } }));
    expect(await svc().sendCode('01001234567', CODE)).toEqual({ ok: false, reason: 'send_failed' });
    vi.restoreAllMocks();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'));
    expect(await svc().sendCode('01001234567', CODE)).toEqual({ ok: false, reason: 'send_failed' });
  });

  it('writes the code and the phone NOWHERE a store can see: no store conversation, message, contact, search row, platform D1 row or log line', async () => {
    const a = W(1);
    const b = W(2);
    for (const ws of [a, b]) { await storeWorkspace(ws); await workspace(ws).setStoreLinkSettings({ otpViaWhatsApp: true }); }
    const logs: string[] = [];
    for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...x: unknown[]) => { logs.push(x.map(String).join(' ')); });
    stubGraph();
    expect(await svc().sendCode('01001234567', CODE)).toEqual({ ok: true });
    for (const ws of [a, b]) {
      expect(await rows(ws, 'SELECT 1 FROM messages')).toEqual([]);
      expect(await rows(ws, 'SELECT 1 FROM conversations')).toEqual([]);
      expect(await rows(ws, 'SELECT 1 FROM contacts')).toEqual([]);
      // nothing in ANY table of the store's database contains the code or the number
      const tables = await rows(ws, "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'") as { name: string }[];
      for (const t of tables) {
        const dump = JSON.stringify(await rows(ws, `SELECT * FROM "${t.name}"`));
        expect(dump, `${t.name} must not hold the code`).not.toContain(CODE);
        expect(dump, `${t.name} must not hold the phone`).not.toContain('1001234567');
      }
    }
    const d1Tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%'").all<{ name: string }>()).results;
    for (const t of d1Tables) {
      const dump = JSON.stringify((await env.DB.prepare(`SELECT * FROM "${t.name}"`).all()).results);
      expect(dump, `D1 ${t.name} must not hold the code`).not.toContain(CODE);
      expect(dump, `D1 ${t.name} must not hold the phone`).not.toContain('1001234567');
    }
    expect(logs.join('\n')).not.toContain(CODE);
    expect(logs.join('\n')).not.toContain('1001234567');
  });
});
