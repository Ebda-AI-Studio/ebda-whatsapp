import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMetaOrigin, launchEmbeddedSignup } from './embedded-signup';

type LoginCb = (r: { authResponse?: { code?: string } | null }) => void;

function fakeFb(onLogin: (cb: LoginCb, opts: Record<string, unknown>) => void) {
  const fb = { init: vi.fn(), login: vi.fn(onLogin) };
  (window as unknown as { FB: typeof fb }).FB = fb;
  return fb;
}
const post = (data: unknown, origin = 'https://www.facebook.com') => window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data), origin }));

afterEach(() => { delete (window as unknown as { FB?: unknown }).FB; });

describe('Embedded Signup launcher', () => {
  it('opens Meta login with the v4 configuration and returns the code with the session ids', async () => {
    const fb = fakeFb((cb) => {
      post({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { phone_number_id: '8001', waba_id: '9001', business_id: '7001' } });
      cb({ authResponse: { code: 'code-xyz' } });
    });
    const r = await launchEmbeddedSignup({ appId: 'app-1', configId: 'cfg-1', graphVersion: 'v25.0' });
    expect(fb.login.mock.calls[0]![1]).toEqual({ config_id: 'cfg-1', response_type: 'code', override_default_response_type: true, extras: { setup: {} } });
    expect(r).toEqual({ code: 'code-xyz', event: 'FINISH', wabaId: '9001', phoneNumberId: '8001', businessId: '7001' });
  });

  it('works when the code arrives before the session message (either order)', async () => {
    fakeFb((cb) => {
      cb({ authResponse: { code: 'c2' } });
      setTimeout(() => post({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { phone_number_id: '8002', waba_id: '9002' } }), 5);
    });
    const r = await launchEmbeddedSignup({ appId: 'a', configId: 'c', graphVersion: 'v25.0' });
    expect(r).toMatchObject({ code: 'c2', event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', wabaId: '9002', phoneNumberId: '8002' });
  });

  it('ignores session messages from look-alike origins', async () => {
    fakeFb((cb) => {
      post({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { phone_number_id: 'evil', waba_id: 'evil' } }, 'https://notfacebook.com');
      post({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { phone_number_id: '8003', waba_id: '9003' } });
      cb({ authResponse: { code: 'c3' } });
    });
    const r = await launchEmbeddedSignup({ appId: 'a', configId: 'c', graphVersion: 'v25.0' });
    expect(r.phoneNumberId).toBe('8003');
    expect(isMetaOrigin('https://notfacebook.com')).toBe(false);
    expect(isMetaOrigin('https://facebook.com.evil.example')).toBe(false);
    expect(isMetaOrigin('http://www.facebook.com')).toBe(false);
    expect(isMetaOrigin('https://web.facebook.com')).toBe(true);
  });

  it('reports cancel with the step, and an ERROR message', async () => {
    fakeFb((cb) => { post({ type: 'WA_EMBEDDED_SIGNUP', event: 'CANCEL', data: { current_step: 'PHONE_NUMBER_SETUP' } }); cb({ authResponse: null }); });
    await expect(launchEmbeddedSignup({ appId: 'a', configId: 'c', graphVersion: 'v25.0' })).rejects.toMatchObject({ reason: 'cancelled', step: 'PHONE_NUMBER_SETUP' });
    fakeFb(() => post({ type: 'WA_EMBEDDED_SIGNUP', event: 'ERROR', data: { error_message: 'boom' } }));
    await expect(launchEmbeddedSignup({ appId: 'a', configId: 'c', graphVersion: 'v25.0' })).rejects.toMatchObject({ reason: 'error' });
  });

  it('a WABA without a phone number (FINISH_ONLY_WABA) is not something the inbox can connect', async () => {
    fakeFb((cb) => { post({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH_ONLY_WABA', data: { waba_id: '9004' } }); cb({ authResponse: { code: 'c4' } }); });
    await expect(launchEmbeddedSignup({ appId: 'a', configId: 'c', graphVersion: 'v25.0' })).rejects.toMatchObject({ reason: 'no_number' });
  });
});
