import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

// M-167 (UI-16): small touch-target and label-size items of the web app, pinned against the stylesheet.
const css = readFileSync(new URL('../web/src/styles.css', import.meta.url), 'utf8');
/** The body of the first `@media` block whose query contains `needle` (brace-balanced). */
function media(needle: string): string {
  const lines = css.split('\n');
  const at = lines.findIndex((l) => l.startsWith('@media') && l.includes(needle));
  expect(at, `@media ${needle}`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(at).join('\n');
  let depth = 0;
  for (let i = rest.indexOf('{'); i < rest.length; i++) {
    if (rest[i] === '{') depth++;
    if (rest[i] === '}' && --depth === 0) return rest.slice(rest.indexOf('{') + 1, i);
  }
  throw new Error('unbalanced braces');
}
const hasRule = (block: string, selector: string, decl: RegExp): boolean => [...block.matchAll(/([^{}]+)\{([^}]*)\}/g)].some(([, sel, body]) => sel!.split(',').map((s) => s.trim()).includes(selector) && decl.test(body!));

it('on coarse pointers (and phones) .lang-btn, .link-btn and .chip are at least 44 px tall', () => {
  const coarse = media('pointer: coarse');
  for (const sel of ['.lang-btn', '.link-btn', '.chip']) expect(hasRule(coarse, sel, /min-height:\s*44px/), sel).toBe(true);
});
it('the phone rail label is 12 px, not 11', () => {
  const phone = media('max-width: 819px');
  expect(hasRule(phone, '.rail a', /font-size:\s*12px/)).toBe(true);
  expect(hasRule(phone, '.rail a', /font-size:\s*11px/)).toBe(false);
});

// A later `.btn.danger { color: var(--bad) }` once matched the filled --bad background and hid every destructive confirm label (operator Assistant screen, 2026-11-23).
it('no plain `.btn.danger` rule sets a text colour other than white; the filled background is --bad', () => {
  const rules = [...css.matchAll(/(^|\n)\.btn\.danger\s*\{([^}]*)\}/g)].map((m) => m[2]!);
  expect(rules.some((b) => /background:\s*var\(--bad\)/.test(b))).toBe(true);
  for (const body of rules) {
    const c = /(^|;|\s)color:\s*([^;]+)/.exec(body)?.[2]?.trim();
    if (c) expect(c).toBe('#fff');
  }
});
