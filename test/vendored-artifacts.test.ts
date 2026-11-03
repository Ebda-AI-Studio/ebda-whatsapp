import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The suite's shared artifacts, vendored byte for byte from the Store (tests/vectors/ebda-wa/ + SHA256SUMS there). The event contract has its own pin in
// test/guards.test.ts (and the Store pins the same bytes in tests/unit/wa-contract-pin.test.ts). A change on either side fails CI until both are re-vendored.
const PINS: Record<string, string> = {
  'vectors/phone.json': 'f1d99cadf8396fe60d04e4361edb2e46f595bfcaf7a0e0b0a72e2c10fd57009b',
  'vectors/buyer-key.json': '00c47c95622dc2516d3c86d492e609fc0f8659b5645416fd076634e245c62ca1',
  'vectors/buyer-key-probe.json': 'a38b2f9b58b3eb5cdbd0df21eecea0098109583a040bcbe8a90ca76826605cad',
  // The Store's studio-pages renderer + brand (packages/shared/src/{studio-pages,brand}/index.ts @ Store 0f58bab22, feat/studio-nav-footer-sites): the 404 page of Ruling WA-404-1. Re-vendor both together.
  'vendor/studio/brand/index.ts': '472ec780a6d9d888a3f26803e2d194d9a9f9e67fbc3d433a4100c9108ac5f165',
  'vendor/studio/studio-pages/index.ts': 'cf7a071da43aafed7abaadaf0b167294f9cab56f81e2f7343bebcc50eddad0c5',
};

it('every artifact shared with the Store is byte-identical to the pinned Store copy', () => {
  for (const [file, sha] of Object.entries(PINS)) {
    expect(createHash('sha256').update(readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex'), file).toBe(sha);
  }
});
