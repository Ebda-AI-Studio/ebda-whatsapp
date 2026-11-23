import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// The suite's shared artifacts, vendored byte for byte from the Store (tests/vectors/ebda-wa/ + SHA256SUMS there). The event contract has its own pin in
// test/guards.test.ts (and the Store pins the same bytes in tests/unit/wa-contract-pin.test.ts). A change on either side fails CI until both are re-vendored.
const PINS: Record<string, string> = {
  'vectors/phone.json': 'f1d99cadf8396fe60d04e4361edb2e46f595bfcaf7a0e0b0a72e2c10fd57009b',
  'vectors/buyer-key.json': '00c47c95622dc2516d3c86d492e609fc0f8659b5645416fd076634e245c62ca1',
  'vectors/bridge-recs-v1.json': '4500abceb8e2d94a159e1260aa4b67feed4f7728fc4dce1dff1d7ced14ee2c74',
  'vectors/bridge-v1.json': 'f0996bbaf81a52952c2e838b71a6ed55a410153caf20262da5939f51b0da36a9',
  // Chat-agent context cases (Store rulings CHAT-AGENT-1 + CHAT-AGENT-6, ebda-store pr 757; v2 adds `degraded` to the search answer): its own file, so the bridge-v1.json pin above moves only with pr 67.
  'vectors/bridge-chat-context-v2.json': '6b960d598bfee5dabbbf154f8972ca46446c89a4158d8b49c98c916768b87c70',
  'vectors/buyer-key-probe.json': 'a38b2f9b58b3eb5cdbd0df21eecea0098109583a040bcbe8a90ca76826605cad',
  // The Store's studio-pages renderer + brand (packages/shared/src/{studio-pages,brand}/index.ts @ Store 87bf7f3c5, feat/studio-nav-footer-sites): the BRAND data of the 404 page of Ruling WA-404-1 (the page shell itself is the foundation's studio-pages, F8).
  'vendor/studio/brand/index.ts': '62a9eefb180a937a9df019d8991d50365f03cd8dc940d4868d7c994bc6373b9a',
};

it('every artifact shared with the Store is byte-identical to the pinned Store copy', () => {
  for (const [file, sha] of Object.entries(PINS)) {
    expect(createHash('sha256').update(readFileSync(new URL(`../${file}`, import.meta.url))).digest('hex'), file).toBe(sha);
  }
});
