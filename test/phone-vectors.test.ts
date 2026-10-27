import { describe, expect, it } from 'vitest';
import { buyerKey } from '../src/core/buyer-key';
import { normaliseE164 } from '../src/core/phone';
import buyer from '../vectors/buyer-key.json';
import phone from '../vectors/phone.json';

// Shared with Ebda Store (vendored there at tests/vectors/ebda-wa/, SHA256SUMS): one customer, one buyerKey in every product (Ruling PHONE-2).
describe('shared phone vectors (PHONE-2)', () => {
  it.each(phone as { in: string; e164: string | null }[])('%j', (c) => expect(normaliseE164(c.in)).toBe(c.e164));
});

describe('shared buyer-key vectors', () => {
  it.each((buyer as { secret: string; cases: { e164: string; hex: string }[] }).cases)('$e164', async (c) => {
    expect(await buyerKey((buyer as { secret: string }).secret, c.e164)).toBe(c.hex);
  });
});
