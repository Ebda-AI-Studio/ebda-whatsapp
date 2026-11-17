import type { StoreLinkSettings } from './store-link/settings';

/**
 * SETTINGS-CONFIRM-1 (self-service action boundary). Turning ON a switch that messages customers (order confirmations) or costs money per use (store-login
 * codes over WhatsApp) takes two steps: `POST .../store-link/settings/preview` returns a server-issued token, and the PATCH must present it. The token is
 * single use, bound to the person and to a hash of the exact previewed payload (an edited payload, a replay, another person or an expired token are all
 * refused), and kept in the workspace's own storage. Turning a switch OFF is the safe direction and needs no token.
 * Cost if wrong: a stolen owner session could still switch sending on, but only with a fresh preview first, so a stale or scripted PATCH cannot.
 */
export const CONFIRM_TTL_MS = 5 * 60_000;
export const CONFIRM_MAX_PENDING = 20;
export type ConfirmOutcome = 'ok' | 'invalid' | 'expired' | 'mismatch';

/** The switches that need a confirm step when turned on. */
export const needsConfirm = (patch: Partial<StoreLinkSettings>): boolean => patch.orderConfirmations === true || patch.otpViaWhatsApp === true;

/** The three owner switches, audited one row each. */
export const SWITCH_KEYS = ['orderingBot', 'orderConfirmations', 'otpViaWhatsApp'] as const;

const canonical = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(',')}}`;
  return JSON.stringify(v);
};

/** SHA-256 (hex) of the payload with sorted keys, so key order never matters and any edit changes it. */
export async function payloadHash(patch: Partial<StoreLinkSettings>): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(patch))));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
