/**
 * Egyptian-register score (plan 4 Task 0.2). Lexicon based: Egyptian dialect markers vs Modern Standard Arabic stiffness.
 * Self-contained on purpose (no imports): the bake-off runner executes it directly under Node type stripping.
 */
export type RegisterResult = { score: number; arabicRatio: number; msaMarkers: string[]; egyMarkers: string[]; englishFirst: boolean };

const FOLD: Record<string, string> = { أ: 'ا', إ: 'ا', آ: 'ا', ى: 'ي', ة: 'ه', ؤ: 'و', ئ: 'ي' };
const fold = (s: string) => s.replace(/[ً-ٰٟـ]/g, '').replace(/[أإآىةؤئ]/g, (c) => FOLD[c] ?? c).toLowerCase();

const MSA = ['سوف', 'يرجي', 'لذلك', 'هل تريد', 'الرجاء', 'قم ب', 'يمكنك', 'بامكانك', 'نود', 'بالتالي', 'حيث ان', 'ماذا', 'كيف يمكن'];
const EGY = ['عايز', 'عايزه', 'ازاي', 'دلوقتي', 'ده', 'دي', 'دول', 'مش', 'بتاع', 'بتاعك', 'كده', 'اللي', 'فين', 'ايه', 'عشان', 'لسه', 'بقي', 'ادوس', 'تدوس', 'ممكن تعمل'];
const NOT_FUTURE = new Set(['هناك', 'هذا', 'هذه', 'هنا', 'هؤلاء', 'هندسه', 'هاتف']);

const ARABIC = /[ء-ي]/g;
const arabicRatioOf = (text: string): number => {
  // Latin tokens with digits or all-caps (SUMMER10, URL, SKU) are product/brand names, not language: exclude them.
  const kept = text.split(/\s+/).filter((t) => !/^[A-Za-z0-9._\-/{}]*([0-9]|[A-Z]{2,})[A-Za-z0-9._\-/{}]*$/.test(t));
  const letters = kept.join(' ');
  const ar = (letters.match(ARABIC) ?? []).length;
  const lat = (letters.match(/[A-Za-z]/g) ?? []).length;
  return ar + lat === 0 ? 0 : ar / (ar + lat);
};

export function registerScore(text: string, locale: 'ar' | 'en'): RegisterResult {
  const arabicRatio = arabicRatioOf(text);
  const first = text.split(/[.!?؟\n]/).find((s) => s.trim().length > 0) ?? '';
  const firstRatio = arabicRatioOf(first);
  const englishFirst = locale === 'ar' && /[A-Za-z]/.test(first) && firstRatio < 0.3;
  if (locale === 'en') return { score: arabicRatio < 0.2 ? 1 : 0.2, arabicRatio, msaMarkers: [], egyMarkers: [], englishFirst: false };
  const f = ` ${fold(text).replace(/[^ء-ي\s{}]/g, ' ')} `;
  const tokens = f.split(/\s+/).filter(Boolean);
  const has = (m: string) => (m.includes(' ') ? f.includes(` ${m}`) : tokens.includes(m) || (m.endsWith('ي') && tokens.includes(m))); // multiword: prefix match
  const msaMarkers = MSA.filter(has);
  const egyMarkers = EGY.filter(has);
  // future prefix: ه + [ت ي ا ن] + 3+ letters (هتلاقي, هيخصم, هنفتح), minus MSA words that merely start with هـ
  if (tokens.some((t) => /^ه[تيان][ء-ي]{3,}$/.test(t) && !NOT_FUTURE.has(t))) egyMarkers.push('هـ+فعل');
  let score = 0.55 + 0.15 * Math.min(egyMarkers.length, 3) - 0.3 * Math.min(msaMarkers.length, 2);
  if (englishFirst) score *= 0.5;
  if (arabicRatio < 0.6 && !englishFirst) score *= 0.7;
  return { score: Math.max(0, Math.min(1, score)), arabicRatio, msaMarkers, egyMarkers, englishFirst };
}
