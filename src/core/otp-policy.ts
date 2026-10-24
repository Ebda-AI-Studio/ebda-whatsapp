/** Toll-fraud limits for one-time codes over WhatsApp. Every code costs money and can be aimed at any number, so all are bounded. */
export type OtpPolicy = {
  /** Country calling codes (digits, no +) a code may be sent to. */
  allowedCallingCodes: readonly string[];
  /** Codes per workspace per window, counting every attempt (failed ones too). */
  workspaceMax: number;
  /** Codes per phone number per window. */
  phoneMax: number;
};

export const OTP_RATE_WINDOW_MS = 10 * 60 * 1000;
export const OTP_RATE_MAX = 5;
export const OTP_WORKSPACE_MAX = 30;
export const DEFAULT_OTP_POLICY: OtpPolicy = { allowedCallingCodes: ['20'], workspaceMax: OTP_WORKSPACE_MAX, phoneMax: OTP_RATE_MAX };
