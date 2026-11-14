/**
 * Franco-Arabic (Arabizi): Egyptian Arabic typed in Latin letters with numbers for the letters Latin lacks (3 = ع, 7 = ح, 2 = أ/ء, 5 = خ, 6 = ط, 8 = ق, 9 = ق/ص).
 * A message like "3ayez fostan a7mar" is Arabic, not English: canned acknowledgements and the model's language rule must treat it as Arabic (audit D6).
 * Heuristic, tested on both sides: a digit INSIDE or at the start of a word is the strongest sign; otherwise a word from the strong list, or two from the weak one.
 */
const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;
/** A digit among letters (ma3lesh, fo2ay, 7aga, 3ayez): not a trailing number such as iphone15, v2 or 4x4 and not a lone "3d". */
const DIGIT_IN_WORD = /[a-z][2356789][a-z]|\b[2356789][a-z]{2,}/i;
const STRONG = new Set(['ezay', 'ezayak', 'ezayek', 'izayak', 'fein', 'feen', 'fen', 'bekam', 'bkam', 'momken', 'mmken', 'mesh', 'msh', 'keda', 'kda', 'aywa', 'aywaa', 'shukran', 'shokran', 'habibi', 'habibti', 'yaani', 'yani', 'mafeesh', 'mafish', 'ahlan', 'inshallah', 'wallahi', 'law samaht', 'ya basha', 'basha', 'gedan', 'awi', 'shwaya', 'ktir', 'kteer', 'dlwa2ty', 'delwa2ty']);
const WEAK = new Set(['ana', 'enta', 'enti', 'ya', 'el', 'bta3', 'bta3i', 'tamam', 'la', 'aho', 'ay', 'eh', 'lel', 'lw', 'law', 'bas', 'hena', 'henak', 'kam', 'ezzay']);

const words = (t: string): string[] => t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function isFranco(text: string): boolean {
  if (!text || ARABIC.test(text) || !LATIN.test(text)) return false;
  if (DIGIT_IN_WORD.test(text)) return true;
  const w = words(text);
  if (w.some((x) => STRONG.has(x))) return true;
  return w.filter((x) => WEAK.has(x)).length >= 2;
}

/** Latin letters only (no Arabic script) and not Franco: the customer is writing English. */
export const isPlainEnglish = (text: string | null | undefined): boolean => !!text && LATIN.test(text) && !ARABIC.test(text) && !isFranco(text);
