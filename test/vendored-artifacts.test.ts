import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The suite's shared artifacts, vendored byte for byte from the Store (tests/vectors/ebda-wa/ + SHA256SUMS there). The event contract has its own pin in
// test/guards.test.ts (and the Store pins the same bytes in tests/unit/wa-contract-pin.test.ts). A change on either side fails CI until both are re-vendored.
const PINS: Record<string, string> = {
  'vectors/phone.json': 'f1d99cadf8396fe60d04e4361edb2e46f595bfcaf7a0e0b0a72e2c10fd57009b',
  'vectors/buyer-key.json': '00c47c95622dc2516d3c86d492e609fc0f8659b5645416fd076634e245c62ca1',
  'vectors/buyer-key-probe.json': 'a38b2f9b58b3eb5cdbd0df21eecea0098109583a040bcbe8a90ca76826605cad',
  // The Store's studio-pages renderer + brand (packages/shared/src/{studio-pages,brand}/index.ts @ Store e31baea15): the 404 page of Ruling WA-404-1. Re-vendor both together.
  'vendor/studio/brand/index.ts': 'b2996581dd4cc8778ba40bbf606f87ac8a3dc2d40f7b901bbe5917f84b612837',
  'vendor/studio/studio-pages/index.ts': '2641c172fbdfe145b0deaf0dc71d642070cab5b03cc3c073bcc1579a6d45fa4e',
};

it('every artifact shared with the Store is byte-identical to the pinned Store copy', () => {
  for (const [file, sha] of Object.entries(PINS)) {
    expect(createHash('sha256').update(readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex'), file).toBe(sha);
  }
});
