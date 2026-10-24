import { describe, expect, it } from 'vitest';
import { detectDelimiter, normaliseImportRow, parseCsvChunk, resolveColumns } from '../src/core/campaigns/csv';

const enc = (s: string) => new TextEncoder().encode(s);
const COMMA = 0x2c;

describe('parseCsvChunk', () => {
  it('parses quoted fields, escaped quotes, CRLF, blank lines and a missing final newline', () => {
    const r = parseCsvChunk(enc('phone,name\r\n"0100 123 4567","Ali ""Abu"" Hassan"\r\n\r\n201001234568,Sara'), { delimiter: COMMA, startLine: 1, maxRecords: 100, final: true });
    expect(r.records).toEqual([
      { line: 1, cells: ['phone', 'name'] },
      { line: 2, cells: ['0100 123 4567', 'Ali "Abu" Hassan'] },
      { line: 4, cells: ['201001234568', 'Sara'] },
    ]);
    expect(r.consumed).toBe(enc('phone,name\r\n"0100 123 4567","Ali ""Abu"" Hassan"\r\n\r\n201001234568,Sara').byteLength);
  });

  it('keeps a quoted newline inside one record and counts its physical lines', () => {
    const r = parseCsvChunk(enc('a,b\n"x\ny",z\nlast,row\n'), { delimiter: COMMA, startLine: 1, maxRecords: 100, final: true });
    expect(r.records.map((x) => [x.line, x.cells])).toEqual([[1, ['a', 'b']], [2, ['x\ny', 'z']], [4, ['last', 'row']]]);
  });

  it('stops before an incomplete trailing record unless the chunk is final, and resumes exactly there', () => {
    const text = 'a,b\nc,d\ne,"f';
    const first = parseCsvChunk(enc(text), { delimiter: COMMA, startLine: 1, maxRecords: 100, final: false });
    expect(first.records).toHaveLength(2);
    expect(first.consumed).toBe(enc('a,b\nc,d\n').byteLength);
    expect(first.lines).toBe(2);
    const last = parseCsvChunk(enc('e,"f'), { delimiter: COMMA, startLine: 3, maxRecords: 100, final: true });
    expect(last.records).toEqual([{ line: 3, cells: [], bad: true }]); // unterminated quote at the end of the file
  });

  it('honours maxRecords and never splits a multi-byte character (Arabic names)', () => {
    const text = 'x,اسم\n1,علي\n2,سارة\n3,منى\n';
    const r = parseCsvChunk(enc(text), { delimiter: COMMA, startLine: 1, maxRecords: 2, final: true });
    expect(r.records.map((x) => x.cells)).toEqual([['x', 'اسم'], ['1', 'علي']]);
    const rest = parseCsvChunk(enc(text).slice(r.consumed), { delimiter: COMMA, startLine: 1 + r.lines, maxRecords: 10, final: true });
    expect(rest.records.map((x) => [x.line, x.cells[1]])).toEqual([[3, 'سارة'], [4, 'منى']]);
  });

  it('strips a UTF-8 BOM on the first record only when asked', () => {
    const r = parseCsvChunk(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('phone\n1\n')]), { delimiter: COMMA, startLine: 1, maxRecords: 10, final: true, stripBom: true });
    expect(r.records[0]!.cells).toEqual(['phone']);
  });
});

it('detects the delimiter from the header line (Excel in Arabic locales writes semicolons)', () => {
  expect(detectDelimiter(enc('phone,name,tags\n'))).toBe(0x2c);
  expect(detectDelimiter(enc('phone;name;tags\n'))).toBe(0x3b);
  expect(detectDelimiter(enc('phone\tname\n'))).toBe(0x09);
  expect(detectDelimiter(enc('phone\n'))).toBe(0x2c);
});

describe('resolveColumns', () => {
  it('matches common headers case- and punctuation-insensitively, including Arabic ones', () => {
    expect(resolveColumns(['Full Name', 'Mobile Number', 'Labels'])).toEqual({ ok: true, cols: { phone: 1, name: 0, tags: 2 } });
    expect(resolveColumns(['الاسم', 'رقم الموبايل'])).toEqual({ ok: true, cols: { phone: 1, name: 0, tags: -1 } });
  });
  it('an explicit mapping wins and a missing mapped column is an error', () => {
    expect(resolveColumns(['a', 'b', 'c'], { phone: 'C', name: 'a' })).toEqual({ ok: true, cols: { phone: 2, name: 0, tags: -1 } });
    expect(resolveColumns(['a', 'b'], { phone: 'zzz' })).toEqual({ ok: false, reason: 'mapped_column_not_found' });
  });
  it('no phone column at all fails the import', () => {
    expect(resolveColumns(['name', 'email'])).toEqual({ ok: false, reason: 'no_phone_column' });
  });
});

describe('normaliseImportRow', () => {
  const cols = { phone: 0, name: 1, tags: 2 };
  it('normalises the phone to digits-only E.164, the name, and the tags', () => {
    expect(normaliseImportRow(['0100 123 4567', '  Ali   Hassan ', 'VIP; eid ,vip'], cols)).toEqual({ ok: true, waId: '201001234567', name: 'Ali Hassan', tags: ['vip', 'eid'] });
    expect(normaliseImportRow(['+965 5000 1234', '', ''], cols)).toEqual({ ok: true, waId: '96550001234', name: null, tags: [] });
    expect(normaliseImportRow(['٠١٠٠١٢٣٤٥٦٧', 'سارة', ''], cols)).toMatchObject({ ok: true, waId: '201001234567', name: 'سارة' });
  });
  it('treats junk names as missing (null, N/A, #N/A, undefined, NaN)', () => {
    for (const junk of ['null', 'NULL', 'undefined', 'NaN', '#N/A', 'n/a']) expect(normaliseImportRow(['01001234567', junk, ''], cols)).toMatchObject({ ok: true, name: null });
  });
  it('rejects an empty or invalid phone with a reason and never echoes the value', () => {
    expect(normaliseImportRow(['', 'x', ''], cols)).toEqual({ ok: false, reason: 'empty_phone' });
    expect(normaliseImportRow(['12345', 'x', ''], cols)).toEqual({ ok: false, reason: 'invalid_phone' });
    expect(normaliseImportRow(['555-0100', 'x', ''], cols)).toEqual({ ok: false, reason: 'invalid_phone' });
    expect(JSON.stringify(normaliseImportRow(['12345', 'x', ''], cols))).not.toContain('12345');
  });
  it('bounds a name to 100 characters, drops control characters, and caps tags (32 chars, 10 per row)', () => {
    const r = normaliseImportRow(['01001234567', 'a\u0000b\u0007' + 'x'.repeat(200), Array.from({ length: 15 }, (_, i) => `t${i}`).join(',') + ',' + 'z'.repeat(50)], cols);
    expect(r.ok && r.name!.length).toBe(100);
    expect(r.ok && r.name!.startsWith('ab')).toBe(true);
    expect(r.ok && r.tags).toHaveLength(10);
  });
});
