import { z } from 'zod';
import type { Env } from '../env';
import { alert, errClass } from './observability';
import { normaliseE164 } from './phone';
import { sendTemplate } from './meta/client';
import { storeLink } from './store-link';
import type { OtpFailure } from './otp';

export type PlatformOtpResult = { ok: true } | { ok: false; reason: Extract<OtpFailure, 'invalid' | 'country_not_allowed' | 'disabled' | 'send_failed' | 'unavailable'> };

const requestSchema = z.object({ phone: z.string().min(5).max(40), code: z.string().regex(/^[A-Za-z0-9]{1,15}$/) });

/**
 * A sign-in code for a PLATFORM account (the platform accounts service: password reset), sent from the platform number and from nowhere else (Ruling WA-OTP-SENDER-1).
 *
 * It belongs to no store. Deliberately, it touches NO workspace: no Durable Object call, no conversation, contact, message row, search index,
 * realtime event, export, backup or AI context. The code exists only in the Graph request. A store's number is never used, because anything a
 * store's number sends lands in that store's inbox history, readable by every staff member of the store.
 *
 * Off (`disabled`) until BOTH `PLATFORM_OTP_PHONE_NUMBER_ID` (the platform number, a Meta/third-party step) and `PLATFORM_OTP_TEMPLATE` (an approved
 * AUTHENTICATION template on its WABA) are set. Country allow-list is the store-link OTP policy's. Per-phone throttling is the caller's (accounts
 * limits a reset to 3 per address per window); this Worker keeps no per-phone state for it, on purpose, because that state would be a new place to hold phone numbers.
 */
export async function sendPlatformOtp(env: Env, input: unknown): Promise<PlatformOtpResult> {
  if (!env.PLATFORM_OTP_PHONE_NUMBER_ID || !env.PLATFORM_OTP_TEMPLATE || !env.META_SYSTEM_TOKEN) return { ok: false, reason: 'disabled' };
  const parsed = requestSchema.safeParse(input);
  const e164 = parsed.success ? normaliseE164(parsed.data.phone) : null;
  if (!parsed.success || !e164) return { ok: false, reason: 'invalid' };
  if (!storeLink().otp.allowedCallingCodes.some((c) => e164.startsWith(`+${c}`))) return { ok: false, reason: 'country_not_allowed' };
  const { code } = parsed.data;
  try {
    const sent = await sendTemplate({
      token: env.META_SYSTEM_TOKEN, graphVersion: env.META_GRAPH_VERSION, phoneNumberId: env.PLATFORM_OTP_PHONE_NUMBER_ID, to: e164.slice(1),
      name: env.PLATFORM_OTP_TEMPLATE, language: 'ar',
      components: [{ type: 'body', parameters: [{ type: 'text', text: code }] }, { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] }],
    });
    return sent.ok ? { ok: true } : { ok: false, reason: 'send_failed' };
  } catch (err) {
    alert('otp_failed', { scope: 'platform', error: errClass(err) });
    return { ok: false, reason: 'unavailable' };
  }
}
