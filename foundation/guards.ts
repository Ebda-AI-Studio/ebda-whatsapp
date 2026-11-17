/**
 * Design-token guard rules, shared by every Ebda product (docs: design/DESIGN.md "Guard rules").
 * A product's own test walks its UI source, calls `countRule` per file and keeps a shrinking per-file baseline
 * (see ebda-store tests/unit/admin-design-tokens.test.ts). Pure functions, no file access.
 *
 *   G1  raw Tailwind palette colour (text-red-500, bg-emerald-50/10): use the semantic roles and their `-ink` text pair
 *   G2  one-off type size `text-[13px]`: use the type scale
 *   G3  hex colour literal: colours come from the CSS variables
 *   G4  the bare `rounded` class (4px): control, surface or pill radius only
 *   G5  letter-spacing (`tracking-*` other than tracking-normal): it breaks Arabic letter joining
 *   G6  a `data-ui="nav"` item that does not take its classes from the product's nav-class function (`navIssues`)
 */
const PALETTE = 'gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose';

export const GUARD_RULES = {
  G1: new RegExp(
    `(?<![\\w-])(?:[a-z-]+:)*(?:text|bg|border|ring|from|to|via|fill|stroke|divide|outline|decoration|accent|caret|placeholder)-(?:${PALETTE})-\\d{2,3}(?:/\\d+)?(?![\\w-])`,
    'g',
  ),
  G2: /(?<![\w-])(?:[a-z-]+:)*text-\[\d+(?:\.\d+)?(?:px|rem)\](?![\w-])/g,
  G3: /#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b/g,
  G4: /(?<=[\s'"`:])(?:[a-z-]+:)*rounded(?=[\s'"`])/g,
  G5: /(?<![\w-])(?:[a-z-]+:)*tracking-(?:tighter|tight|wide|wider|widest)(?![\w-])/g,
} as const;

export type GuardRule = keyof typeof GUARD_RULES;

/** The source with line and block comments blanked (so prose never trips a rule). */
export function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`])\/\/[^\n]*/g, (m, a: string) => a + ' '.repeat(m.length - a.length));
}

export function countRule(rule: GuardRule, src: string): number {
  return (stripComments(src).match(GUARD_RULES[rule]) ?? []).length;
}

/** The JSX opening tag starting at `i` (brace-balanced, so `=>` inside handlers does not end it). */
export function openingTag(src: string, i: number): string {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0 && src[j - 1] !== '=') return src.slice(i, j + 1);
  }
  return src.slice(i);
}

/** Everything the className attribute can resolve to (static string or the whole expression). */
export function classAttr(tag: string): string {
  const s = tag.match(/\bclassName="([^"]*)"/);
  if (s) return s[1] ?? '';
  const at = tag.search(/\bclassName=\{/);
  if (at < 0) return '';
  let depth = 0;
  const start = tag.indexOf('{', at);
  for (let j = start; j < tag.length; j++) {
    if (tag[j] === '{') depth++;
    else if (tag[j] === '}' && --depth === 0) return tag.slice(start + 1, j);
  }
  return tag.slice(start + 1);
}

/** G6: `file:line` of every `data-ui="nav"` tag whose className does not call one of `navFns`. */
export function navIssues(file: string, src: string, navFns: readonly string[]): string[] {
  const out: string[] = [];
  const call = new RegExp(`\\b(?:${navFns.join('|')})\\(`);
  const re = /<[A-Za-z.]+(?=[\s>])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const tag = openingTag(src, m.index);
    if (!/\bdata-ui=["']nav["']/.test(tag)) continue;
    if (!call.test(classAttr(tag))) out.push(`${file}:${src.slice(0, m.index).split('\n').length}`);
  }
  return out;
}
