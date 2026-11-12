import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const plist = readFileSync(new URL('../ops/com.ebda.wa-backup-pull.plist', import.meta.url), 'utf8');

describe('com.ebda.wa-backup-pull.plist', () => {
  it('puts Homebrew first on PATH (launchd otherwise resolves a hanging /usr/local/bin/npx)', () => {
    const m = plist.match(/<key>PATH<\/key><string>([^<]+)<\/string>/);
    expect(m?.[1].split(':')[0]).toBe('/opt/homebrew/bin');
  });
  it('keeps its label', () => {
    expect(plist).toContain('<string>com.ebda.wa-backup-pull</string>');
  });
});
