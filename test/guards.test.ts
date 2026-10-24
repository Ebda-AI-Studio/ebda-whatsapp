import { expect, it } from 'vitest';
import { findMatches } from './helpers/grep';

it('repo carries no legacy brand strings', () => {
  expect(findMatches(/force|fwb|\bwbs\b|forcemediakw/i)).toEqual([]);
});

it('core never names the Ebda brand', () => {
  expect(findMatches(/ebda|إبدأ|ابدأ/i, 'src/core')).toEqual([]);
});

it('pins the Store event contract file: change it only together with the Store repo copy', async () => {
  const { readFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const file = readFileSync(new URL('../src/core/api/store-events.ts', import.meta.url));
  expect(createHash('sha256').update(file).digest('hex')).toBe('91a7faffa1d1a1aae416f840d0006596ca1e4f226b35efa24c04771199582d0d');
});
