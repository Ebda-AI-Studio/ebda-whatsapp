import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

const SRC = new URL('../web/src/', import.meta.url).pathname;
const sources: Record<string, string> = Object.fromEntries(readdirSync(join(SRC, 'components')).filter((f) => f.endsWith('.tsx')).map((f) => [`./components/${f}`, readFileSync(join(SRC, 'components', f), 'utf8')]));
// Chat wave 3 ratchet (ebda-foundation MOTION-1): motion, states, elevation and radius stay on the design-language tokens.
const css = readFileSync(join(SRC, 'styles.css'), 'utf8');
const decls = (prop: string): string[] => [...css.matchAll(new RegExp(`(?:^|[;{\\s])${prop}:\\s*([^;}]+)`, 'g'))].map((m) => m[1]!.trim());

it('mirrors the foundation motion tokens exactly (--ebda-ease, --ebda-dur-fast/base/slow)', () => {
  expect(css).toMatch(/--ease:\s*cubic-bezier\(0\.2, 0, 0, 1\)/);
  expect(css).toMatch(/--dur-fast:\s*150ms/);
  expect(css).toMatch(/--dur:\s*200ms/);
  expect(css).toMatch(/--dur-slow:\s*250ms/);
});
it('every transition and animation uses a duration token or a literal of at most 250 ms (the skeleton pulse loop excepted)', () => {
  const values = [...decls('transition'), ...decls('animation')].filter((v) => v !== 'none !important' && v !== 'none');
  expect(values.length).toBeGreaterThan(8);
  for (const v of values) {
    if (v.includes('skeleton-pulse')) continue;
    for (const [, n, unit] of v.matchAll(/(\d*\.?\d+)(ms|s)\b/g)) {
      const ms = unit === 's' ? Number(n) * 1000 : Number(n);
      expect(ms, v).toBeLessThanOrEqual(250);
    }
  }
});
it('reduced motion removes every animation and transition', () => {
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
  // Every keyframe animation that loops forever is gated behind no-preference.
  const infinite = css.split('\n').filter((l: string) => l.includes('infinite'));
  for (const l of infinite) expect(css.slice(0, css.indexOf(l)).lastIndexOf('prefers-reduced-motion: no-preference'), l).toBeGreaterThan(css.slice(0, css.indexOf(l)).lastIndexOf('\n}'));
});
it('slides mirror in RTL: no hard-coded horizontal translate, and no letter-spacing or per-letter text effects (breaks Arabic joining)', () => {
  for (const m of css.matchAll(/translateX\(([^)]*\)?)\)/g)) expect(m[0], 'translateX must be driven by --dir').toContain('--dir');
  expect(css).not.toMatch(/letter-spacing|::first-letter|word-spacing/);
});
it('one focus ring: 2px solid, offset 2px, and it never changes the element radius', () => {
  const rule = css.match(/^:focus-visible \{([^}]*)\}/m)?.[1] ?? '';
  expect(rule).toMatch(/outline:\s*2px solid var\(--focus\)/);
  expect(rule).toMatch(/outline-offset:\s*2px/);
  expect(rule).not.toMatch(/border-radius/);
});
it('every pressable control has a pressed state deeper than hover', () => {
  for (const sel of ['.btn', '.icon-btn', '.chip', '.lang-btn', '.row', '.rail a']) {
    expect(new RegExp(`${sel.replace('.', '\\.')}:active`).test(css), `${sel}:active`).toBe(true);
  }
  expect(css).not.toMatch(/:(hover|active)[^{]*\{[^}]*transform:\s*(translate|scale)/);
});
it('shadows come from the elevation tokens, radii from the foundation set', () => {
  for (const v of decls('box-shadow')) {
    const blur = [...v.matchAll(/(?:-?\d+(?:px)?\s+){2}(\d+)px/g)].map((m) => Number(m[1]));
    if (blur.some((b) => b >= 16)) expect(v, 'large shadows use --elev-2 / --elev-3').toMatch(/^var\(--elev-[23]\)$/);
  }
  const allowed = new Set(['3px', '4px', '6px', '8px', '12px', '14px', '50%', '999px', '0']);
  for (const v of decls('border-radius')) for (const part of v.split(/\s+/)) if (/^\d/.test(part)) expect(allowed.has(part), `${part} in "${v}"`).toBe(true);
});
it('regions load with a skeleton, never a bare ellipsis, and the skeleton announces itself', () => {
  const files = Object.entries(sources).filter(([f]) => !f.endsWith('.test.tsx'));
  expect(files.length).toBeGreaterThan(10);
  for (const [f, src] of files) expect(src, f).not.toMatch(/>…</);
  const sk = sources['./components/Skeleton.tsx']!;
  expect(sk).toContain('role="status"');
  expect(sk).toContain('aria-label');
  expect(css).toMatch(/\.skeleton-row\s*\{[^}]*height:\s*\d+px/);
});

it('each skeleton kind holds the row height measured on the loaded sample screen (phone / desktop), so no layout shift', () => {
  // Measured with Playwright on the sample build at 390 / 820 / 1280 / 1440 (Wave 3).
  const phone: Record<string, number> = { setting: 60, team: 74, contact: 94, number: 208, package: 102, funnel: 46, campaign: 259, wallet: 260 };
  for (const [k, h] of Object.entries(phone)) expect(css, k).toMatch(new RegExp(`\\.skeleton-row\\[data-k='${k}'\\]\\s*\\{\\s*height:\\s*${h}px`));
  expect(css).toMatch(/@media \(min-width: 820px\) \{[^@]*data-k='campaign'\] \{ height: 229px[^@]*data-k='wallet'\] \{ height: 263px/);
  expect(css).toMatch(/\.skeleton-head \{ height: 60px/);
  expect(css).toMatch(/\.skeleton-head \{ height: 68px/);
  // The skeleton kinds in use all exist in the component's type.
  const sk = sources['./components/Skeleton.tsx']!;
  for (const k of Object.keys(phone)) expect(sk, k).toContain(`'${k}'`);
});
it('sign-in shows one language at a time with a 44 px toggle, and every how-to link has the touch target', () => {
  const gate = sources['./components/SignInGate.tsx']!;
  expect(gate).toContain('gate-lang');
  expect(gate).not.toMatch(/gateBody\}<\/p>\s*<p lang="en"/);
  expect(css).toMatch(/\.howto, \.checklist li a, a\.muted \{ display: inline-flex; align-items: center; min-height: 44px/);
  for (const f of ['TeamScreen', 'NumbersScreen']) expect(sources[`./components/${f}.tsx`], f).toContain('className="howto"');
});
