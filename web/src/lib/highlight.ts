import { normaliseText } from '../../../src/core/text-normalise';

export type Segment = { text: string; match: boolean };

/** Folds one character the way the search index does; '' for tashkeel/tatweel/punctuation (they never break or form a match). */
const fold = (ch: string) => normaliseText(ch).replace(/ /g, '');

/**
 * Splits `text` into segments, marking where `query` matches. Matching uses the shared normaliser per character, so
 * أ/ا, ة/ه, ى/ي, tashkeel and Arabic-Indic digits are insensitive; the returned segments keep the ORIGINAL characters.
 * Only letters and digits take part (spaces and punctuation in the query are ignored, as the server does).
 */
export function highlight(text: string, query: string): Segment[] {
  if (!text) return [];
  const needle = normaliseText(query).replace(/ /g, '');
  if (!needle) return [{ text, match: false }];
  const chars = [...text];
  // folded[i] = the folded form of chars[i]; positions with '' are transparent (diacritics) and ride along with their base letter.
  const folded = chars.map(fold);
  const marks = new Array<boolean>(chars.length).fill(false);
  for (let start = 0; start < chars.length; start++) {
    if (!folded[start]) continue;
    let k = 0, i = start;
    while (i < chars.length && k < needle.length) {
      const f = folded[i]!;
      if (f) { if (needle.startsWith(f, k)) k += f.length; else break; }
      i++;
    }
    if (k === needle.length) {
      // Keep trailing diacritics of the last matched letter inside the match.
      while (i < chars.length && !folded[i] && /[\p{M}ـ]/u.test(chars[i]!)) i++;
      for (let j = start; j < i; j++) marks[j] = true;
      start = i - 1;
    }
  }
  const out: Segment[] = [];
  chars.forEach((ch, i) => {
    const last = out[out.length - 1];
    if (last && last.match === marks[i]) last.text += ch; else out.push({ text: ch, match: marks[i]! });
  });
  return out;
}
