import { foldArabic, searchTokens } from '../../text';

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
  const tokens = searchTokens(query);
  if (tokens.length === 0) return [{ text, match: false }];

  // Fold per original character so every folded index maps back to a range of the original. A character that folds to nothing (a
  // diacritic, a hamza seat) maps to no folded position and is carried by its neighbour; a run of و that the fold collapses (ؤ after a
  // deleted hamza seat) extends the range of the one و it became. The fold of a lone character equals its share of the fold of the text
  // for every step except the و collapse, which is redone here.
  let folded = '';
  const startOf: number[] = [];
  const endOf: number[] = [];
  const dropped: boolean[] = []; // per original UTF-16 unit: folds to nothing and is not a space
  let i = 0;
  for (const ch of text) {
    const f = foldArabic(ch);
    const next = i + ch.length;
    for (let k = 0; k < ch.length; k++) dropped.push(f === '' && ch.trim() !== '');
    for (const c of f) {
      if (c === 'و' && folded.endsWith('و')) endOf[endOf.length - 1] = next;
      else {
        folded += c;
        startOf.push(i);
        endOf.push(next);
      }
    }
    i = next;
  }

  const hit = new Array<boolean>(text.length).fill(false);
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(token, from);
      if (at === -1) break;
      const start = startOf[at] ?? 0;
      let end = endOf[at + token.length - 1] ?? 0;
      while (end < text.length && dropped[end]) end++; // trailing diacritics / hamza seats belong to the matched letter
      for (let p = start; p < end; p++) hit[p] = true;
      from = at + token.length;
    }
  }

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
