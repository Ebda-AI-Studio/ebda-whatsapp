export type RateError = { line: number; code: 'empty' | 'too_many' | 'bad_line' | 'bad_country' | 'bad_category' | 'bad_price' | 'duplicate' };
export type ParsedRates = { ok: true; rates: { country: string; category: string; usdMicros: number }[] } | { ok: false; errors: RateError[] };

const MAX_RATES = 2000;
const MAX_ERRORS = 5;

/** "12.5" with scale 2 → 1250. Pure string arithmetic (Arabic-Indic digits accepted): money and rates never go through a float. */
export function parseScaled(text: string, scale: number): number | null {
  const ascii = text.trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))).replace('٫', '.');
  const m = new RegExp(`^(\\d{1,9})(?:\\.(\\d{1,${scale}}))?$`).exec(ascii);
  if (!m) return null;
  return Number(m[1]) * 10 ** scale + Number((m[2] ?? '').padEnd(scale, '0'));
}

/** "0.0529" → 52900. */
export const toMicros = (text: string): number | null => parseScaled(text, 6);

/** Parses the operator's `country,category,usd` textarea into the rate-card payload, with line-numbered errors. */
export function parseRates(text: string): ParsedRates {
  const rates: { country: string; category: string; usdMicros: number }[] = [];
  const errors: RateError[] = [];
  const seen = new Set<string>();
  let line = 0;
  for (const raw of text.split(/\r?\n/)) {
    line += 1;
    const row = raw.trim();
    if (!row || row.startsWith('#')) continue;
    const cells = row.split(',').map((c) => c.trim());
    if (rates.length === 0 && errors.length === 0 && /^country$/i.test(cells[0] ?? '')) continue; // optional header
    const fail = (code: RateError['code']) => { if (errors.length < MAX_ERRORS) errors.push({ line, code }); };
    if (cells.length !== 3) { fail('bad_line'); continue; }
    const [country, category, price] = cells as [string, string, string];
    if (!/^[A-Z]{2,3}$/.test(country)) { fail('bad_country'); continue; }
    if (!/^[a-z_]{3,32}$/.test(category)) { fail('bad_category'); continue; }
    const usdMicros = toMicros(price);
    if (usdMicros === null || usdMicros > 1_000_000_000) { fail('bad_price'); continue; }
    if (seen.has(`${country}|${category}`)) { fail('duplicate'); continue; }
    seen.add(`${country}|${category}`);
    rates.push({ country, category, usdMicros });
  }
  if (errors.length) return { ok: false, errors };
  if (rates.length === 0) return { ok: false, errors: [{ line: 0, code: 'empty' }] };
  if (rates.length > MAX_RATES) return { ok: false, errors: [{ line: 0, code: 'too_many' }] };
  return { ok: true, rates };
}
