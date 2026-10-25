// Meta Embedded Signup (v4+) in the page: Meta's SDK opens the popup, the popup posts the session (WABA + phone number ids) as a
// window message, and FB.login returns a one-time code. The code lives 30 seconds, so the caller sends it to the server at once.
// Docs: developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation/ (checked 2026-10-25).

export type SignupEvent = 'FINISH' | 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING';
export type SignupResult = { code: string; event: SignupEvent; wabaId: string; phoneNumberId: string; businessId?: string };
export class SignupStopped extends Error {
  constructor(public readonly reason: 'cancelled' | 'error' | 'no_number' | 'sdk_unavailable', public readonly step?: string) {
    super(reason);
  }
}

type Fb = {
  init(o: Record<string, unknown>): void;
  login(cb: (r: { authResponse?: { code?: string } | null }) => void, o: Record<string, unknown>): void;
};
declare global {
  interface Window { FB?: Fb; fbAsyncInit?: () => void }
}

/** Only Meta's own hosts may post the session: a suffix check (`endsWith('facebook.com')`) would also accept notfacebook.com. */
export function isMetaOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    return u.protocol === 'https:' && (u.hostname === 'facebook.com' || u.hostname.endsWith('.facebook.com'));
  } catch {
    return false;
  }
}

let sdk: Promise<Fb> | null = null;
/** Loads Meta's SDK once (CSP allows connect.facebook.net and *.facebook.com frames, see web/public/_headers). */
export function loadSdk(appId: string, graphVersion: string): Promise<Fb> {
  if (window.FB) return Promise.resolve(window.FB);
  sdk ??= new Promise<Fb>((resolve, reject) => {
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, autoLogAppEvents: true, xfbml: false, version: graphVersion });
      resolve(window.FB!);
    };
    const s = document.createElement('script');
    s.src = 'https://connect.facebook.net/en_US/sdk.js';
    s.async = true;
    s.crossOrigin = 'anonymous';
    s.onerror = () => { sdk = null; reject(new SignupStopped('sdk_unavailable')); };
    document.head.appendChild(s);
  });
  return sdk;
}

export async function launchEmbeddedSignup(cfg: { appId: string; configId: string; graphVersion: string }): Promise<SignupResult> {
  const fb = await loadSdk(cfg.appId, cfg.graphVersion);
  return new Promise<SignupResult>((resolve, reject) => {
    let code: string | null = null;
    let session: { event: SignupEvent; wabaId: string; phoneNumberId: string; businessId?: string } | null = null;
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; window.removeEventListener('message', onMessage); fn(); };
    const settle = () => { if (code && session) { const s = session; const c = code; finish(() => resolve({ code: c, ...s })); } };

    function onMessage(e: MessageEvent) {
      if (!isMetaOrigin(e.origin)) return;
      let msg: { type?: string; event?: string; data?: Record<string, string> };
      try { msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch { return; }
      if (msg?.type !== 'WA_EMBEDDED_SIGNUP') return;
      const d = msg.data ?? {};
      if (msg.event === 'CANCEL') return finish(() => reject(new SignupStopped('cancelled', d.current_step)));
      if (msg.event === 'ERROR') return finish(() => reject(new SignupStopped('error')));
      if (msg.event === 'FINISH_ONLY_WABA' || ((msg.event === 'FINISH' || msg.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') && !d.phone_number_id)) {
        return finish(() => reject(new SignupStopped('no_number')));
      }
      if ((msg.event === 'FINISH' || msg.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') && d.waba_id && d.phone_number_id) {
        session = { event: msg.event, wabaId: d.waba_id, phoneNumberId: d.phone_number_id, ...(d.business_id ? { businessId: d.business_id } : {}) };
        settle();
      }
    }
    window.addEventListener('message', onMessage);
    fb.login((r) => {
      if (r.authResponse?.code) { code = r.authResponse.code; settle(); return; }
      // No code and no session yet = the popup was closed; give a late CANCEL message a moment to name the step.
      setTimeout(() => finish(() => reject(new SignupStopped('cancelled'))), 300);
    }, { config_id: cfg.configId, response_type: 'code', override_default_response_type: true, extras: { setup: {} } });
  });
}
