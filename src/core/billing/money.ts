/**
 * Money arithmetic. Everything is an integer: USD micros (1e-6 USD), EGP piasters (1e-2 EGP), basis points. No floats anywhere on a
 * price path. Rounding is half-even ("banker's"), done ONCE per ledger row, so rows add up exactly and a statement never recomputes.
 */
export const DEFAULT_COUNTRY = 'EG';

/** n / d rounded to the nearest integer, ties to the even neighbour. `n` >= 0, `d` > 0. */
export function roundHalfEvenDiv(n: bigint, d: bigint): bigint {
  const q = n / d;
  const twice = (n % d) * 2n;
  if (twice > d) return q + 1n;
  if (twice === d) return q % 2n === 0n ? q : q + 1n;
  return q;
}

/**
 * piasters = roundHalfEven(usd_micros x fx_micros x (10000 + margin_bps) / 10^14), with the FX buffer folded into the same single
 * rounding: x (10000 + fx_buffer_bps) / 10^4 more. With a zero buffer this is exactly the formula in the plan.
 *
 * Units: usd_micros (1e-6 USD) x fx_micros (1e-6 EGP per USD) = 1e-12 EGP; x 100 piasters per EGP and / 10^4 for the basis points gives
 * the 10^14.
 */
export function priceMinor(a: { usdMicros: number; fxMicros: number; marginBps: number; fxBufferBps?: number }): number {
  const buf = BigInt(a.fxBufferBps ?? 0);
  const num = BigInt(a.usdMicros) * BigInt(a.fxMicros) * (10000n + BigInt(a.marginBps)) * (10000n + buf);
  return Number(roundHalfEvenDiv(num, 10n ** 18n));
}

/** VAT on a net amount at `vatBps` basis points, rounded half-even; stored per row and never recomputed. */
export function vatOf(netMinor: number, vatBps: number): number {
  if (netMinor === 0 || vatBps === 0) return 0;
  const sign = netMinor < 0 ? -1 : 1;
  return sign * Number(roundHalfEvenDiv(BigInt(Math.abs(netMinor)) * BigInt(vatBps), 10000n));
}

/** "12.34" for 1234 piasters (a statement column; exact, no float). */
export function egpString(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
