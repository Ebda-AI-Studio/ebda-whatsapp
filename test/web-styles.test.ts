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

it('the desktop rail is wide enough for one-line labels, and says so (CHAT-QA-10)', () => {
  expect(Number(/--rail:\s*(\d+)px/.exec(css)?.[1])).toBeGreaterThanOrEqual(84); // the first --rail is the desktop value
  const desk = media('min-width: 820px');
  expect(hasRule(desk, '.rail a > span', /white-space:\s*nowrap/)).toBe(true);
  expect(hasRule(desk, '.rail a > span', /text-overflow:\s*ellipsis/)).toBe(true);
  expect(/\.rail a \{ width: 7[6-9]px;/.test(css)).toBe(true);
});

it('the help link is brand brass and never the browser default blue or visited purple (CHAT-QA-13)', () => {
  expect(/\.help-link,\s*\.help-link:visited\s*\{[^}]*color:\s*var\(--gold-ink\)/.test(css)).toBe(true);
});
