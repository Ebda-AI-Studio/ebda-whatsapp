import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMetaOrigin, launchEmbeddedSignup, loadSdk } from './embedded-signup';

type LoginCb = (r: { authResponse?: { code?: string; userID?: string } | null }) => void;

function fakeFb(onLogin: (cb: LoginCb, opts: Record<string, unknown>) => void) {
  const fb = { init: vi.fn(), login: vi.fn(onLogin) };
  (window as unknown as { FB: typeof fb }).FB = fb;
  return fb;
}
const post = (data: unknown, origin = 'https://www.facebook.com') => window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data), origin }));

afterEach(() => { delete (window as unknown as { FB?: unknown }).FB; vi.useRealTimers(); });
const CFG = { appId: 'a', configId: 'c', graphVersion: 'v25.0' };
/** Settles a promise into a label so a never-settling one is a failed assertion, not a hung test. */
const watch = (p: Promise<unknown>) => { const w = { state: 'pending' as string }; p.then(() => { w.state = 'resolved'; }, (e: { reason?: string }) => { w.state = `rejected:${e.reason}`; }); return w; };

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

  it('passes the app-scoped user id on (digits only), so Meta\'s data-deletion callback can find the connection', async () => {
    fakeFb((cb) => { post({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { phone_number_id: '8001', waba_id: '9001' } }); cb({ authResponse: { code: 'c', userID: '1234567890' } }); });
    expect((await launchEmbeddedSignup(CFG)).fbUserId).toBe('1234567890');
    fakeFb((cb) => { post({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { phone_number_id: '8001', waba_id: '9001' } }); cb({ authResponse: { code: 'c', userID: '12 34; drop' } }); });
    expect((await launchEmbeddedSignup(CFG)).fbUserId).toBeUndefined();
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

  it('a code with no session message ends in an error after 25 seconds instead of hanging (the code expires at 30)', async () => {
    vi.useFakeTimers();
    fakeFb((cb) => cb({ authResponse: { code: 'late' } }));
    const w = watch(launchEmbeddedSignup(CFG));
    await vi.advanceTimersByTimeAsync(24_000);
    expect(w.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(w.state).toBe('rejected:error');
  });

  it('a Meta SDK that never loads is sdk_unavailable after 15 seconds, and a later try can load it again', async () => {
    vi.useFakeTimers();
    const w = watch(loadSdk('a', 'v25.0'));
    await vi.advanceTimersByTimeAsync(14_000);
    expect(w.state).toBe('pending');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(w.state).toBe('rejected:sdk_unavailable');
    const w2 = watch(loadSdk('a', 'v25.0')); // not stuck on the failed promise
    window.FB = { init: vi.fn(), login: vi.fn() };
    window.fbAsyncInit?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(w2.state).toBe('resolved');
  });

  it('a popup closed after FINISH with no code is an error, not a cancel', async () => {
    vi.useFakeTimers();
    fakeFb((cb) => { post({ type: 'WA_EMBEDDED_SIGNUP', event: 'FINISH', data: { phone_number_id: '8005', waba_id: '9005' } }); cb({ authResponse: null }); });
    const w = watch(launchEmbeddedSignup(CFG));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.state).toBe('rejected:error');
    fakeFb((cb) => cb({ authResponse: null }));
    const w2 = watch(launchEmbeddedSignup(CFG));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w2.state).toBe('rejected:cancelled'); // closed with nothing done = cancel
  });

  it('with the SDK already loaded, FB.login is called synchronously (a browser only opens the popup inside the click)', () => {
    const fb = fakeFb(() => undefined);
    void launchEmbeddedSignup(CFG).catch(() => undefined);
    expect(fb.login).toHaveBeenCalledTimes(1);
  });
});
