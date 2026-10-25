import { z } from 'zod';
import type { Env } from '../env';
import { normaliseE164 } from './phone';
import { errClass } from './observability';
import { activeNumberFor } from './routing';
import { storeLink } from './store-link';

export type OtpFailure = 'invalid' | 'country_not_allowed' | 'not_found' | 'disabled' | 'no_number' | 'template_unavailable' | 'rate_limited' | 'send_failed' | 'wallet_empty' | 'unavailable';
export type OtpResult = { ok: true } | { ok: false; reason: OtpFailure };

const requestSchema = z.object({
  storeId: z.string().min(1).max(64),
  phone: z.string().min(5).max(40),
  code: z.string().regex(/^[A-Za-z0-9]{1,15}$/),
});

/**
 * Sends a one-time code over WhatsApp for a store's customer (OTP-1: email is the main channel; this is optional and off
 * unless the store switches `otpViaWhatsApp` on). Expected failures are result objects. The code is never logged, and the
 * workspace stores it masked (the authentication template path), so it exists only in the Graph request.
 */
export async function sendOtp(env: Env, input: unknown): Promise<OtpResult> {
  const parsed = requestSchema.safeParse(input);
  const e164 = parsed.success ? normaliseE164(parsed.data.phone) : null;
  if (!parsed.success || !e164) return { ok: false, reason: 'invalid' };
  const { storeId, code } = parsed.data;
  if (!storeLink().otp.allowedCallingCodes.some((c) => e164.startsWith(`+${c}`))) return { ok: false, reason: 'country_not_allowed' };
  try {
    const known = await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(storeId).first();
    if (!known) return { ok: false, reason: 'not_found' };
    const number = await activeNumberFor(env.DB, storeId);
    if (!number) return { ok: false, reason: 'no_number' };
    return await env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(storeId)).queueOtp(e164.slice(1), number.phoneNumberId, code);
  } catch (err) {
    console.error(JSON.stringify({ alert: 'otp_failed', storeId, error: errClass(err) }));
    return { ok: false, reason: 'unavailable' };
  }
}
