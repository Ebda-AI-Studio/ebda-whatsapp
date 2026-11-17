// InstaPay auto-confirm decision (money path, spec 7.4). ONE pure function: it never reads a clock, a database or the network, and it
// never short-circuits, so the digest and the admin screen show EVERY reason a payment waits. Auto-confirm iff there are zero reasons.
// Every comparison fails CLOSED: a value that is not a safe integer / finite number / known enum (undefined and null included, e.g. isFirstPayment)
// can only add a reason, never remove one.
import { asciiLower, type ReceiptExtract } from './instapay-extract';

export type ReasonCode =
  | 'KILL_GLOBAL'
  | 'KILL_STORE'
  | 'SHADOW_MODE'
  | 'EXTRACT_INCOMPLETE'
  | 'AMOUNT_MISMATCH'
  | 'WRONG_HANDLE'
  | 'DATE_STALE'
  | 'DATE_FUTURE'
  | 'DUPLICATE_REFERENCE'
  | 'DUPLICATE_IMAGE'
  | 'FIRST_PAYMENT_OVER_CAP'
  | 'ABOVE_DUAL_CONTROL_THRESHOLD'
  | 'LOOKS_EDITED'
  | 'SUSPICIOUS_TEXT'
  | 'LOW_CONFIDENCE';

/** the canonical order reasons are reported in */
export const REASON_ORDER: readonly ReasonCode[] = [
  'KILL_GLOBAL', 'KILL_STORE', 'SHADOW_MODE', 'EXTRACT_INCOMPLETE', 'AMOUNT_MISMATCH', 'WRONG_HANDLE', 'DATE_STALE', 'DATE_FUTURE',
  'DUPLICATE_REFERENCE', 'DUPLICATE_IMAGE', 'FIRST_PAYMENT_OVER_CAP', 'ABOVE_DUAL_CONTROL_THRESHOLD', 'LOOKS_EDITED', 'SUSPICIOUS_TEXT', 'LOW_CONFIDENCE',
];

export const MAX_TRANSFER_AGE_MS = 48 * 3600_000;
export const FUTURE_TOLERANCE_MS = 10 * 60_000;
export const MIN_CONFIDENCE = 0.8;

export type DecisionInput = {
  extract: ReceiptExtract | null;
  expected: { amountMinor: number; payeeHandle: string };
  now: number;
  mode: 'off' | 'shadow' | 'live';
  storeEnabled: boolean;
  isFirstPayment: boolean;
  firstPaymentCapMinor: number;
  dualControlThresholdMinor: number | null;
  duplicate: 'none' | 'reference' | 'image' | 'both';
  flags: { looksEdited: boolean; suspiciousText: boolean; confidence: number };
};

export type Decision = { verdict: 'auto_confirm' | 'needs_human'; reasons: ReasonCode[] };

const HANDLE_RE = /^[a-z0-9._-]+(?:@[a-z0-9._-]+)?$/;

/** printable ASCII only (checked BEFORE lower-casing, so U+212A KELVIN SIGN, fullwidth letters, zero-width characters and Cyrillic look-alikes are
 *  rejected, never folded into a match), trim, ASCII lower-case, drop ONE leading "@"; null for empty, masked (* or bullet or ellipsis), spaced or over-long */
export function normalizeHandle(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.trim();
  if (!/^[\x21-\x7e]+$/.test(t)) return null;
  let s = asciiLower(t);
  if (s.startsWith('@')) s = s.slice(1);
  if (s.length === 0 || s.length > 64 || !HANDLE_RE.test(s)) return null;
  return s;
}

const posInt = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

export function decideInstapay(i: DecisionInput): Decision {
  const r = new Set<ReasonCode>();
  if (i.mode === 'shadow') r.add('SHADOW_MODE');
  else if (i.mode !== 'live') r.add('KILL_GLOBAL'); // 'off' and anything unknown
  if (i.storeEnabled !== true) r.add('KILL_STORE');

  const e = i.extract;
  const complete = !!e && posInt(e.amountMinor) && Number.isFinite(e.transferredAt) && typeof e.recipientHandle === 'string' && e.recipientHandle.length > 0 && typeof e.reference === 'string' && e.reference.length > 0;
  if (!complete) r.add('EXTRACT_INCOMPLETE');
  const expectedOk = posInt(i.expected?.amountMinor);
  if (complete) {
    if (e!.amountMinor !== i.expected?.amountMinor) r.add('AMOUNT_MISMATCH'); // e.amountMinor is a positive safe integer here, so equality implies the expected one is too
    const got = normalizeHandle(e!.recipientHandle);
    const want = normalizeHandle(i.expected?.payeeHandle);
    if (got === null || want === null || got !== want) r.add('WRONG_HANDLE');
    if (!Number.isFinite(i.now)) r.add('DATE_STALE');
    else {
      const age = i.now - e!.transferredAt;
      if (age > MAX_TRANSFER_AGE_MS) r.add('DATE_STALE');
      if (age < -FUTURE_TOLERANCE_MS) r.add('DATE_FUTURE');
    }
  } else if (!expectedOk) r.add('AMOUNT_MISMATCH');

  if (i.duplicate === 'reference' || i.duplicate === 'both') r.add('DUPLICATE_REFERENCE');
  if (i.duplicate === 'image' || i.duplicate === 'both') r.add('DUPLICATE_IMAGE');
  if (i.duplicate !== 'none' && i.duplicate !== 'reference' && i.duplicate !== 'image' && i.duplicate !== 'both') {
    r.add('DUPLICATE_REFERENCE');
    r.add('DUPLICATE_IMAGE');
  }

  if (i.isFirstPayment !== false && !(expectedOk && i.expected.amountMinor <= i.firstPaymentCapMinor)) r.add('FIRST_PAYMENT_OVER_CAP');
  if (i.dualControlThresholdMinor !== null && !(expectedOk && i.expected.amountMinor < i.dualControlThresholdMinor)) r.add('ABOVE_DUAL_CONTROL_THRESHOLD');

  if (i.flags?.looksEdited !== false) r.add('LOOKS_EDITED');
  if (i.flags?.suspiciousText !== false) r.add('SUSPICIOUS_TEXT');
  if (!(typeof i.flags?.confidence === 'number' && i.flags.confidence >= MIN_CONFIDENCE)) r.add('LOW_CONFIDENCE');

  const reasons = REASON_ORDER.filter((c) => r.has(c));
  return { verdict: reasons.length === 0 ? 'auto_confirm' : 'needs_human', reasons };
}
