import { highlightSegments, type HighlightSegment } from '../../../foundation/web/search';

export type Segment = HighlightSegment;

/**
 * Splits `text` into segments, marking where `query` matches. Matching uses the foundation's shared fold (Ruling FDN-SEARCH-1), so
 * أ/ا, ة/ه, ى/ي, ئ/ي, ؤ/و, tashkeel and Arabic-Indic digits are insensitive; the returned segments keep the ORIGINAL characters.
 * Each query word is marked wherever it occurs (the server matches every word as a prefix of a name word).
 */
export const highlight = (text: string, query: string): Segment[] => highlightSegments(text, query);
