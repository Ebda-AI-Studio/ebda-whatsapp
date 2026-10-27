import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The suite's shared artifacts, vendored byte for byte from the Store (tests/vectors/ebda-wa/ + SHA256SUMS there; the event contract is pinned
// on the Store side to these same bytes in tests/unit/wa-contract-pin.test.ts). A change on either side fails CI until both are re-vendored.
const PINS: Record<string, string> = {
  'src/core/api/store-events.ts': '3c24ed64267e9d051bce1b1959a7d0c2dd2f28cec1bab03d8a47147b375fc4af', // contract v1.5 (Store apps/api/src/contracts/wa-v1.ts)
  'vectors/phone.json': 'f1d99cadf8396fe60d04e4361edb2e46f595bfcaf7a0e0b0a72e2c10fd57009b',
  'vectors/buyer-key.json': '00c47c95622dc2516d3c86d492e609fc0f8659b5645416fd076634e245c62ca1',
  'vectors/buyer-key-probe.json': 'a38b2f9b58b3eb5cdbd0df21eecea0098109583a040bcbe8a90ca76826605cad',
};

it('every artifact shared with the Store is byte-identical to the pinned Store copy', () => {
  for (const [file, sha] of Object.entries(PINS)) {
    expect(createHash('sha256').update(readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex'), file).toBe(sha);
  }
});
