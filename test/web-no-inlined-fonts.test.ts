import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';

// CHAT-QA-8: the build must not inline fonts as data: URIs. The page CSP is `font-src 'self'` (web/brands/*/public/_headers), so an inlined
// font is a blocked request on every first load. This builds the real web app and reads the emitted CSS.
it('the built stylesheet references fonts by file, never by data: URI, and the CSP does not allow data: fonts', async () => {
  const out = mkdtempSync(join(tmpdir(), 'wa-web-'));
  try {
    await build({ configFile: new URL('../web/vite.config.ts', import.meta.url).pathname, logLevel: 'silent', build: { outDir: out, emptyOutDir: true } });
    const assets = join(out, 'assets');
    const css = readdirSync(assets).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(assets, f), 'utf8')).join('\n');
    expect(css).toMatch(/@font-face/);
    expect(css).not.toMatch(/url\(\s*["']?data:/);
    expect(readdirSync(assets).some((f) => f.endsWith('.woff2'))).toBe(true);
    const headers = readFileSync(new URL('../web/brands/ebda/public/_headers', import.meta.url), 'utf8');
    const fontSrc = /font-src ([^;]*);/.exec(headers)?.[1] ?? '';
    expect(fontSrc).not.toMatch(/data:/);
  } finally {
    rmSync(out, { recursive: true });
  }
}, 60_000);
