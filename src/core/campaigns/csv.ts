import { normaliseE164 } from '../phone';

/**
 * CSV for contact imports, on bytes. Quote, comma, semicolon, tab, CR and LF never occur inside a multi-byte UTF-8
 * sequence, so tokenising bytes (and decoding each field) cannot split an Arabic letter, whatever the chunk boundary.
 */
export type CsvRecord = { line: number; cells: string[]; /** An unterminated quote ran to the end of the file. */ bad?: true };
export type CsvChunk = { records: CsvRecord[]; /** Bytes fully consumed (a resume point on a record boundary). */ consumed: number; /** Physical newlines consumed. */ lines: number };

const QUOTE = 0x22, LF = 0x0a, CR = 0x0d;
const decoder = new TextDecoder();

export function parseCsvChunk(bytes: Uint8Array, opts: { delimiter: number; startLine: number; maxRecords: number; final: boolean; stripBom?: boolean }): CsvChunk {
  const n = bytes.length;
  const records: CsvRecord[] = [];
  let i = opts.stripBom && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  let consumed = i;
  let line = opts.startLine;
  let lines = 0;
  while (i < n && records.length < opts.maxRecords) {
    const cells: string[] = [];
    let field: number[] = [];
    let inQuotes = false;
    let quoted = false;
    let terminated = false;
    let incomplete = false;
    let physical = 0;
    const endField = () => {
      cells.push(decoder.decode(Uint8Array.from(field)));
      field = [];
      quoted = false;
    };
    while (i < n) {
      const b = bytes[i]!;
      if (inQuotes) {
        if (b === QUOTE) {
          if (i + 1 >= n && !opts.final) { incomplete = true; break; } // could be half of an escaped quote
          if (bytes[i + 1] === QUOTE) { field.push(QUOTE); i += 2; continue; }
          inQuotes = false;
          i++;
          continue;
        }
        if (b === LF) physical++;
        field.push(b);
        i++;
        continue;
      }
      if (b === QUOTE && field.length === 0 && !quoted) { inQuotes = true; quoted = true; i++; continue; }
      if (b === opts.delimiter) { endField(); i++; continue; }
      if (b === LF || b === CR) {
        endField();
        i += b === CR && bytes[i + 1] === LF ? 2 : 1;
        physical++;
        terminated = true;
        break;
      }
      field.push(b);
      i++;
    }
    if (incomplete) break;
    if (!terminated) {
      if (!opts.final) break; // a record still being read: resume from its start in the next chunk
      if (inQuotes) {
        records.push({ line, cells: [], bad: true });
        consumed = n;
        lines += physical;
        i = n;
        break;
      }
      endField();
    }
    const blank = cells.length === 1 && cells[0] === '' && !quoted;
    if (!blank) records.push({ line, cells });
    line += physical;
    lines += physical;
    consumed = i;
  }
  return { records, consumed, lines };
}

/** First line of the file decides: the most frequent of comma, semicolon, tab (outside quotes); a single column means comma. */
export function detectDelimiter(head: Uint8Array): number {
  const counts = new Map<number, number>([[0x2c, 0], [0x3b, 0], [0x09, 0]]);
  let inQuotes = false;
  for (const b of head) {
    if (b === QUOTE) inQuotes = !inQuotes;
    else if (!inQuotes && (b === LF || b === CR)) break;
    else if (!inQuotes && counts.has(b)) counts.set(b, counts.get(b)! + 1);
  }
  let best = 0x2c;
  for (const [d, c] of counts) if (c > counts.get(best)!) best = d;
  return best;
}

export type ColumnMap = { phone: number; name: number; tags: number };
export type ColumnMapping = { phone?: string; name?: string; tags?: string };
const key = (h: string) => h.replace(/^﻿/, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const PHONE_HEADERS = ['phone', 'phonenumber', 'mobile', 'mobilenumber', 'whatsapp', 'whatsappnumber', 'contactnumber', 'number', 'tel', 'telephone', 'cell', 'cellphone', 'رقم', 'رقمالموبايل', 'رقمالهاتف', 'رقمالواتساب', 'موبايل', 'الموبايل', 'هاتف', 'الهاتف', 'تليفون', 'واتساب'];
const NAME_HEADERS = ['name', 'fullname', 'contactname', 'customername', 'firstname', 'clientname', 'displayname', 'الاسم', 'اسم', 'اسمالعميل'];
const TAG_HEADERS = ['tags', 'tag', 'labels', 'label', 'groups', 'group', 'الوسوم', 'وسوم', 'التصنيف', 'تصنيف'];

/** Maps the header row to the three columns we read. An explicit mapping wins; without one the common header names are matched. */
export function resolveColumns(headers: string[], mapping: ColumnMapping = {}): { ok: true; cols: ColumnMap } | { ok: false; reason: 'no_phone_column' | 'mapped_column_not_found' } {
  const keys = headers.map(key);
  const find = (explicit: string | undefined, aliases: string[]): number | 'missing' => {
    if (explicit !== undefined) {
      const at = keys.indexOf(key(explicit));
      return at === -1 ? 'missing' : at;
    }
    return keys.findIndex((k) => aliases.includes(k));
  };
  const phone = find(mapping.phone, PHONE_HEADERS);
  const name = find(mapping.name, NAME_HEADERS);
  const tags = find(mapping.tags, TAG_HEADERS);
  if (phone === 'missing' || name === 'missing' || tags === 'missing') return { ok: false, reason: 'mapped_column_not_found' };
  if (phone === -1) return { ok: false, reason: 'no_phone_column' };
  return { ok: true, cols: { phone, name, tags } };
}

const JUNK_NAMES = new Set(['null', 'undefined', 'nan', '#n/a', 'n/a']);
export const MAX_NAME_CHARS = 100;
export const MAX_TAG_CHARS = 32;
export const MAX_TAGS_PER_CONTACT = 10;

export type ImportRejectReason = 'empty_phone' | 'invalid_phone' | 'duplicate_in_file' | 'unreadable_row';
export type NormalisedRow = { ok: true; waId: string; name: string | null; tags: string[] } | { ok: false; reason: ImportRejectReason };

/** Cleans a display name; some exports write the literal text "null" for an empty cell and that must not become a name. */
/** Tabs and line breaks become spaces, other control characters vanish, runs of spaces collapse. */
const stripControls = (s: string) => s.replace(/[\t\n\r]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();

export function cleanName(raw: string | undefined): string | null {
  const t = stripControls(raw ?? '');
  if (!t || JUNK_NAMES.has(t.toLowerCase())) return null;
  return Array.from(t).slice(0, MAX_NAME_CHARS).join('');
}

export function cleanTags(raw: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (raw ?? '').split(/[;,|،]/)) {
    const t = Array.from(stripControls(part).toLowerCase()).slice(0, MAX_TAG_CHARS).join('');
    if (t && !out.includes(t)) out.push(t);
    if (out.length === MAX_TAGS_PER_CONTACT) break;
  }
  return out;
}

/** One data row to a contact. The phone is validated, never echoed into a reason. `waId` is digits only (no +). */
export function normaliseImportRow(cells: string[], cols: ColumnMap): NormalisedRow {
  const raw = (cells[cols.phone] ?? '').trim();
  if (!raw) return { ok: false, reason: 'empty_phone' };
  const e164 = normaliseE164(raw);
  if (!e164) return { ok: false, reason: 'invalid_phone' };
  return { ok: true, waId: e164.slice(1), name: cols.name >= 0 ? cleanName(cells[cols.name]) : null, tags: cols.tags >= 0 ? cleanTags(cells[cols.tags]) : [] };
}
