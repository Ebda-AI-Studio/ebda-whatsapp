import { describe, expect, it } from 'vitest';
import { buyerKey } from '../src/core/buyer-key';
import { normaliseE164 } from '../src/core/phone';

describe('normaliseE164', () => {
  it.each(['01001234567', '201001234567', '+20 100 123 4567', '٠١٠٠١٢٣٤٥٦٧', '۰۱۰۰۱۲۳۴۵۶۷', '00201001234567', '+201001234567', '(+20) 100-123-4567'])(
    '%s → +201001234567',
    (input) => expect(normaliseE164(input)).toBe('+201001234567'),
  );
  it('keeps a foreign number', () => expect(normaliseE164('+965 5000 1234')).toBe('+96550001234'));
  it.each(['', 'abc', '123', '+2010012345678901', '+0201001234567'])('rejects %s', (input) => expect(normaliseE164(input)).toBeNull());
});

describe('buyerKey', () => {
  it('matches the pinned suite vector', async () => {
    expect(await buyerKey('ebda-suite-buyer-key-test-v1', '+201001234567')).toBe('e8771d4105457e95d06a8589827d6c09043f73bb1750f2ef525bccbc22d67edd');
  });
  it('refuses a non-E.164 input', async () => {
    await expect(buyerKey('s', '01001234567')).rejects.toThrow();
  });
});
