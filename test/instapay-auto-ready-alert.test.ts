import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkAutoReadiness } from '../src/core/billing/instapay-auto';

const setMode = (mode: string) => env.DB.prepare("INSERT INTO instapay_auto_settings (key, value, updated_by, updated_at) VALUES ('mode', ?, 't', 1) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(mode).run();
const alerts = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('instapay_auto_not_ready'));
const broken = { ...env, INSTAPAY_BRIDGE_SECRET: undefined, BRAIN_BRIDGE_URL: undefined } as typeof env;
afterEach(() => { vi.restoreAllMocks(); });

describe('checkAutoReadiness', () => {
  it('shadow or live with a missing secret/URL raises instapay_auto_not_ready naming what is missing', async () => {
    for (const mode of ['shadow', 'live']) {
      await setMode(mode);
      const spy = vi.spyOn(console, 'error');
      await checkAutoReadiness(broken);
      const lines = alerts(spy);
      expect(lines.length, mode).toBe(1);
      expect(lines[0]).toContain('INSTAPAY_BRIDGE_SECRET');
      expect(lines[0]).toContain('BRAIN_BRIDGE_URL');
      spy.mockRestore();
    }
  });
  it('mode off is a decision, not a fault: no alert; and a ready setup raises nothing', async () => {
    await setMode('off');
    const spy = vi.spyOn(console, 'error');
    await checkAutoReadiness(broken);
    await setMode('live');
    await checkAutoReadiness(env);
    expect(alerts(spy)).toEqual([]);
  });
});
