import { z } from 'zod';
import type { Env } from '../../env';
import { isRetryable } from '../meta/errors';

/** Meta answers within seconds; a hung signup call must not outlive the request. */
const TIMEOUT_MS = 15_000;
/** Meta error code: 10 registration attempts in 72 hours, the number is locked until the window passes. */
export const REGISTRATION_LOCKED_CODE = 133016;
/** Webhook error: the merchant declined to share their chat history during onboarding. */
export const HISTORY_DECLINED_CODE = 2593109;

export type GraphFail = { ok: false; status: number; code: number; retryable: boolean };
export type GraphRes<T> = { ok: true; value: T } | GraphFail;

type Opts = { token?: string; query?: Record<string, string>; body?: Record<string, unknown> };

/**
 * One Graph call. The failure carries Meta's numeric code only: the message text is never returned or logged
 * (it can quote a phone number), and the token only ever travels in the Authorization header.
 */
async function call<T>(env: Env, method: 'GET' | 'POST' | 'DELETE', path: string, schema: z.ZodType<T>, opts: Opts = {}): Promise<GraphRes<T>> {
  const qs = opts.query ? `?${new URLSearchParams(opts.query).toString()}` : '';
  let res: Response;
  try {
    res = await fetch(`https://graph.facebook.com/${env.META_GRAPH_VERSION}/${path}${qs}`, {
      method,
      headers: { ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}), ...(opts.body ? { 'content-type': 'application/json' } : {}) },
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, status: 0, code: 0, retryable: true };
  }
  const json = (await res.json().catch(() => null)) as { error?: { code?: number } } | null;
  if (!res.ok || json?.error) {
    const code = json?.error?.code ?? 0;
    return { ok: false, status: res.status, code, retryable: isRetryable(code, res.status) };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, status: res.status, code: 0, retryable: false };
}

const success = z.object({ success: z.boolean() }).loose();

/** Embedded Signup: the 30-second code → the merchant's business token. No second (long-lived) exchange: that step is for user tokens. */
export function exchangeCode(env: Env, appId: string, code: string) {
  return call(env, 'GET', 'oauth/access_token', z.object({ access_token: z.string().min(1) }).loose(), { query: { client_id: appId, client_secret: env.META_APP_SECRET, code } });
}

export const subscribeApp = (env: Env, token: string, wabaId: string) => call(env, 'POST', `${wabaId}/subscribed_apps`, success, { token });
export const unsubscribeApp = (env: Env, token: string, wabaId: string) => call(env, 'DELETE', `${wabaId}/subscribed_apps`, success, { token });
export const registerNumber = (env: Env, token: string, phoneNumberId: string, pin: string) =>
  call(env, 'POST', `${phoneNumberId}/register`, success, { token, body: { messaging_product: 'whatsapp', pin } });
export const deregisterNumber = (env: Env, token: string, phoneNumberId: string) => call(env, 'POST', `${phoneNumberId}/deregister`, success, { token, body: {} });

/** One-shot data sync for a number onboarded from the WhatsApp Business app: contacts, then history. Each can run once, within 24 h. */
export const requestSync = (env: Env, token: string, phoneNumberId: string, syncType: 'smb_app_state_sync' | 'history') =>
  call(env, 'POST', `${phoneNumberId}/smb_app_data`, z.object({ request_id: z.string().optional() }).loose(), { token, body: { messaging_product: 'whatsapp', sync_type: syncType } });

export const PHONE_FIELDS = 'id,display_phone_number,verified_name,status,quality_rating,messaging_limit_tier,throughput,name_status,platform_type,is_on_biz_app';
const phoneSchema = z.object({
  id: z.string(),
  display_phone_number: z.string().optional(),
  verified_name: z.string().optional(),
  quality_rating: z.string().optional(),
  messaging_limit_tier: z.string().optional(),
  throughput: z.object({ level: z.string().optional() }).loose().optional(),
  name_status: z.string().optional(),
  platform_type: z.string().optional(),
  is_on_biz_app: z.boolean().optional(),
}).loose();
export type PhoneStatus = z.infer<typeof phoneSchema>;

export const fetchPhone = (env: Env, token: string, phoneNumberId: string) => call(env, 'GET', phoneNumberId, phoneSchema, { token, query: { fields: PHONE_FIELDS } });

/** The numbers of a WABA. Reading it proves the token has access to the WABA, and ties a number id to it. */
export const fetchWabaNumbers = (env: Env, token: string, wabaId: string) =>
  call(env, 'GET', `${wabaId}/phone_numbers`, z.object({ data: z.array(phoneSchema) }).loose(), { token, query: { fields: PHONE_FIELDS, limit: '100' } });
