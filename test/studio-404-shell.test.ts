import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

// F8: Chat's 404 is the foundation's studio-pages shell (foundation/studio-pages.ts, createStudioPages) bound to the vendored brand. This pins the
// shell's served bytes (footer year masked) so a re-vendor that changes what Chat serves shows up here and in review, never silently; and it pins the
// security shape: no inline script, no inline event handler, no style attribute (the CSP allows only the one <style> block and the help typeahead).
const sha = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
const PINS: Record<string, string> = {
  ar: 'bce512409dab59b96daa2b992d12330f2409b44c57bc830dfb2bf8404fca1287',
  en: '07aafea6eb35c4ba411896a21b8027137ff6ab78f9391da053f640014d68ecd0',
};

it.each(['ar', 'en'])('%s: 404 status, shell bytes pinned, no inline script / handler / style attribute', async (lang) => {
  const res = await SELF.fetch(`https://wa.test/zzz-nope?lang=${lang}`);
  expect(res.status).toBe(404);
  const html = await res.text();
  expect(await sha(html.replace(/© 20\d{2}/, '© YYYY'))).toBe(PINS[lang]);
  // split on any case / whitespace variant of a script open tag: exactly one element, and it is the help typeahead.
  const scripts = html.split(/<\s*script\b/i).slice(1).map((rest) => rest.slice(0, rest.indexOf('>')).trim());
  expect(scripts).toEqual(['src="https://help.ebda.app/assets/typeahead.js" defer']);
  expect(html).not.toMatch(/\son[a-z]+=/i);
  expect(html).not.toMatch(/\sstyle="/i);
  expect(html.match(/<style>/g)).toHaveLength(1);
});

it('Ebda Chat is listed as live (not "coming soon") and CRM / ERP are the coming-soon rows', async () => {
  const html = await (await SELF.fetch('https://wa.test/zzz-nope?lang=en')).text();
  expect(html).toContain('<a href="https://wa.ebda.app/">Ebda Chat</a>');
  expect(html).not.toMatch(/Ebda Chat<b>/);
  expect(html).toMatch(/Ebda CRM<b>Coming soon<\/b>/);
  expect(html).toMatch(/Ebda ERP<b>Coming soon<\/b>/);
});
