import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// CHAT-QA-14: wa.ebda.app answered 404 for /.well-known/security.txt and /llms.txt. They are static assets of the Ebda brand
// (publicDir of the web build), so they ship in web/dist and are served before the Worker's 404 page.
const pub = join(import.meta.dirname, '..', 'web', 'brands', 'ebda', 'public');
const read = (p: string) => readFileSync(join(pub, p), 'utf8');

it('security.txt carries the same contact and policy as the Store, a future Expires, and this host as canonical (RFC 9116)', () => {
  const t = read('.well-known/security.txt');
  expect(t).toMatch(/^Contact: mailto:security@ebda\.app$/m);
  expect(t).toMatch(/^Policy: https:\/\/ebda\.app\/legal\/$/m);
  expect(t).toMatch(/^Canonical: https:\/\/wa\.ebda\.app\/\.well-known\/security\.txt$/m);
  const expires = /^Expires: (.+)$/m.exec(t)?.[1] ?? '';
  expect(Date.parse(expires)).toBeGreaterThan(Date.now()); // fails the day the file goes stale
});

it('llms.txt describes Ebda Chat and links the ebda.app legal pages', () => {
  const t = read('llms.txt');
  expect(t.startsWith('# Ebda Chat')).toBe(true);
  for (const url of ['https://ebda.app/legal/', 'https://ebda.app/privacy/', 'https://ebda.app/terms/', 'https://ebda.app/legal/whatsapp-terms/', 'https://ebda.app/legal/whatsapp-privacy/', 'https://ebda.app/legal/data-deletion/']) expect(t).toContain(`](${url})`);
  expect(t).not.toMatch(/orange/i);
});

it('both are served as text/plain with a charset', () => {
  const h = read('_headers');
  for (const path of ['/.well-known/security.txt', '/llms.txt']) {
    const block = new RegExp(`^${path.replace(/[.]/g, '\\.')}\\n((?:  .+\\n?)+)`, 'm').exec(h)?.[1] ?? '';
    expect(block, path).toContain('Content-Type: text/plain; charset=utf-8');
  }
});

it('the dot-folder is not excluded from the asset upload', () => {
  expect(statSync(join(pub, '.well-known')).isDirectory()).toBe(true);
  for (const f of ['.assetsignore', join('..', '..', '..', '.assetsignore'), join('..', '..', '..', '..', '.assetsignore')]) {
    const p = join(pub, f);
    if (existsSync(p)) expect(readFileSync(p, 'utf8')).not.toMatch(/well-known|llms/);
  }
});
