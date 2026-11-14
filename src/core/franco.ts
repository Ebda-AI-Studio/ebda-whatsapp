/**
 * Franco-Arabic (Arabizi): Egyptian Arabic typed in Latin letters with numbers for the letters Latin lacks (3 = ع, 7 = ح, 2 = أ/ء, 5 = خ, 6 = ط, 8 = ق, 9 = ق/ص).
 * A message like "3ayez fostan a7mar" is Arabic, not English: canned acknowledgements and the model's language rule must treat it as Arabic (audit D6).
 * Heuristic, tested on both sides: an Arabic chat numeral standing in for a letter inside a word (see `isFrancoWord`) is the strongest sign; otherwise a word from the strong list, or two from the weak one.
 */
const ARABIC = /[؀-ۿ]/;
const LATIN = /[A-Za-z]/;
/** A number with an English unit / ordinal / size / time suffix ("5pm", "2nd", "6xl", "22nd", "8gb", "3x3"): never Franco. */
const ENGLISH_NUMBER = /^\d+(?:st|nd|rd|th|am|pm|xs|s|m|l|xl|xxl|xxxl|x\d*|pcs|pc|kg|g|cm|mm|ml|gb|tb|mb|k)$/;
/**
 * A Franco WORD: letters plus the Arabic chat numerals (2 3 5 6 7 8 9) standing in for letters, at least 4 characters, and the numeral must touch a vowel
 * so it reads as a letter inside a word: it leads the word before a vowel (3ayez, 7aga, 2ahmar) or sits next to a vowel inside it (ma3lesh, fo2ay, a7mar,
 * mawa3eed). Digits glued between consonants (b2b, p2p, mp3s) and short tokens (h2o, e2e, 3d) are English. Review I3.
 */
const FRANCO_WORD = /^(?:[2356789][aeiou][a-z]*|(?=[a-z0-9]*[a-z][2356789][aeiou]|[a-z0-9]*[aeiou][2356789][a-z])[a-z0-9]+)$/;
const isFrancoWord = (w: string): boolean => w.length >= 4 && /^[a-z0-9]+$/.test(w) && /[a-z]{2}/.test(w) && /[2356789]/.test(w) && !/[014]/.test(w) && !ENGLISH_NUMBER.test(w) && FRANCO_WORD.test(w);
const STRONG = new Set(['ezay', 'ezayak', 'ezayek', 'izayak', 'fein', 'feen', 'fen', 'bekam', 'bkam', 'momken', 'mmken', 'msh', 'keda', 'kda', 'aywa', 'aywaa', 'shukran', 'shokran', 'habibi', 'habibti', 'yaani', 'yani', 'mafeesh', 'mafish', 'ahlan', 'inshallah', 'wallahi', 'law samaht', 'ya basha', 'basha', 'gedan', 'awi', 'shwaya', 'ktir', 'kteer', 'dlwa2ty', 'delwa2ty']);
/** 'mesh' counts only with a second weak word (it is also an English product word); English words such as la, law, bas, kam, ay are not here. */
const WEAK = new Set(['mesh', 'ana', 'enta', 'enti', 'ya', 'el', 'bta3', 'bta3i', 'tamam', 'aho', 'eh', 'lel', 'lw', 'hena', 'henak', 'ezzay']);

const words = (t: string): string[] => t.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

export function isFranco(text: string): boolean {
  if (!text || ARABIC.test(text) || !LATIN.test(text)) return false;
  const w = words(text);
  if (w.some(isFrancoWord)) return true;
  if (w.some((x) => STRONG.has(x))) return true;
  return new Set(w.filter((x) => WEAK.has(x))).size >= 2;
}

/** Latin letters only (no Arabic script) and not Franco: the customer is writing English. */
export const isPlainEnglish = (text: string | null | undefined): boolean => !!text && LATIN.test(text) && !ARABIC.test(text) && !isFranco(text);
