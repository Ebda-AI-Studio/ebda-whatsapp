import type { OtpPolicy } from '../../core/otp-policy';

/** Ebda Chat sends codes to Egyptian numbers only (+20), 5 per phone and 30 per store per 10 minutes. */
export const EBDA_OTP_POLICY: OtpPolicy = { allowedCallingCodes: ['20'], workspaceMax: 30, phoneMax: 5 };
