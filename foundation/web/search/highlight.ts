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

  // Fold per original character so every folded index maps back to one original index. A character
  // that folds to nothing (a diacritic) maps to no folded position and is carried by its neighbour.
  let folded = '';
  const origin: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = foldArabic(ch);
    for (let k = 0; k < f.length; k++) origin.push(i);
    folded += f;
    i += ch.length;
  }

  const hit = new Array<boolean>(text.length).fill(false);
  for (const token of tokens) {
    let from = 0;
    for (;;) {
      const at = folded.indexOf(token, from);
      if (at === -1) break;
      const start = origin[at] ?? 0;
      const end = (origin[at + token.length - 1] ?? 0) + 1;
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
