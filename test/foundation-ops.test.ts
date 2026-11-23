import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error plain .mjs without types (vendored from ebda-foundation, F10)
import { cronsFromWrangler, lintWrangler } from '../scripts/foundation/cron-lint.mjs';

// F10: cron-lint is vendored from ebda-foundation (scripts/foundation). Cloudflare rejects a numeric weekday 0 and reads 1 as Sunday, and ONE bad cron
// makes the whole schedules PUT fail while /health shows the new commit; so wrangler.jsonc may only use weekday names or *.
it('wrangler.jsonc declares its crons and every one is Cloudflare-valid (weekday names or *)', () => {
  const text = readFileSync(join(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8');
  expect(cronsFromWrangler(text, 'wrangler.jsonc').length).toBeGreaterThan(0);
  expect(lintWrangler(text, 'wrangler.jsonc')).toEqual([]);
});
