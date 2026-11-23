import { foldArabic, foldArabicHamza, searchTokens, searchTokensHamza } from '../../text';

export interface HighlightSegment {
  text: string;
  match: boolean;
}

/**
 * Split `text` into plain / matched segments for the words in `query`, comparing through the shared
 * Arabic folding (alef, yeh, teh marbuta, diacritics, case) but cutting the ORIGINAL characters, so
 * the shopper sees their catalogue's spelling with the matched part marked. Returns React-safe data:
 * callers render `<mark>` text nodes, never HTML.
 */
export function highlightSegments(text: string, query: string): HighlightSegment[] {
  if (!text) return [];
  const tokensB = searchTokens(query);
  if (tokensB.length === 0) return [{ text, match: false }];
  const hit = new Array<boolean>(text.length).fill(false);
  // A word is marked where it matches under fold B OR under fold A (Ruling F7-HAMZA-2): the same either-fold rule the search uses.
  mark(text, tokensB, foldArabic, false, hit);
  mark(text, searchTokensHamza(query), foldArabicHamza, true, hit);

  const out: HighlightSegment[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = cursor + 1;
    while (end < text.length && hit[end] === hit[cursor]) end++;
    out.push({ text: text.slice(cursor, end), match: hit[cursor] === true });
    cursor = end;
  }
  return out;
}

/**
 * Marks `hit` for every occurrence of `tokens` in `text` under one fold. Folds per original character so every folded index maps back to a
 * range of the original: a character that folds to nothing (a diacritic) is carried by its neighbour; with `collapseWaw` (fold A) a run of و
 * that the fold collapses extends the range of the one و it became.
 */
function mark(text: string, tokens: string[], fold: (s: string) => string, collapseWaw: boolean, hit: boolean[]): void {
  let folded = '';
  const startOf: number[] = [];
  const endOf: number[] = [];
  const dropped: boolean[] = []; // per UTF-16 unit: folds to nothing and is not a space
  let i = 0;
  for (const ch of text) {
    const f = fold(ch);
    const next = i + ch.length;
    for (let k = 0; k < ch.length; k++) dropped.push(f === '' && ch.trim() !== '');
    for (const c of f) {
      if (collapseWaw && c === 'و' && folded.endsWith('و')) endOf[endOf.length - 1] = next;
      else {
        folded += c;
        startOf.push(i);
        endOf.push(next);
      }
    }
    i = next;
  }
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(token, from);
      if (at === -1) break;
      const start = startOf[at] ?? 0;
      let end = endOf[at + token.length - 1] ?? 0;
      while (end < text.length && dropped[end]) end++; // trailing diacritics belong to the matched letter
      for (let p = start; p < end; p++) hit[p] = true;
      from = at + token.length;
    }
  }
}
