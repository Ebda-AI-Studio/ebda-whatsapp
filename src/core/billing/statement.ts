/**
 * The monthly statement: the stored ledger rows of a calendar month (Africa/Cairo) with totals per kind and per category. Totals are
 * sums of STORED rows (net, VAT and amount as written when the row was made); nothing is recomputed from today's prices.
 */
import { egpString } from './money';

type Sql = DurableObjectStorage['sql'];
const TZ = 'Africa/Cairo';
const HOUR = 3_600_000;
export const STATEMENT_ROW_CAP = 5000;

const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });

/** [start, end) of a month in Cairo local time as epoch ms; null when `month` is not YYYY-MM. */
export function monthRange(month: string): { from: number; to: number } | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const startOf = (yy: number, mm: number): number => {
    const utc = Date.UTC(yy, mm - 1, 1);
    for (const off of [2, 3]) {
      const t = utc - off * HOUR;
      const p = Object.fromEntries(parts.formatToParts(t).map((x) => [x.type, x.value]));
      if (p.year === String(yy) && p.month === String(mm).padStart(2, '0') && p.day === '01' && p.hour === '00') return t;
    }
    return utc - 2 * HOUR;
  };
  return { from: startOf(y, mo), to: mo === 12 ? startOf(y + 1, 1) : startOf(y, mo + 1) };
}

export type Money = { count: number; netMinor: number; vatMinor: number; amountMinor: number };
export type StatementRow = {
  at: number; kind: string; netMinor: number; vatMinor: number; amountMinor: number; balanceAfterMinor: number; ref: string; wamid: string | null; category: string | null; note: string | null;
};
export type Statement = {
  month: string; from: number; to: number; openingMinor: number; closingMinor: number; rows: StatementRow[]; truncated: boolean;
  totalsByKind: Record<string, Money>; totalsByCategory: Record<string, Money>;
  /** What Meta billed the merchant's own card for numbers the wallet does not pay: shown, never debited. */
  cardCosts: { category: string; count: number; usdMicros: number }[];
};

type Agg = { k: string; n: number; net: number; vat: number; amt: number };
const toMap = (rows: Agg[]): Record<string, Money> => Object.fromEntries(rows.map((r) => [r.k, { count: r.n, netMinor: r.net, vatMinor: r.vat, amountMinor: r.amt }]));

export function buildStatement(sql: Sql, month: string, cap = STATEMENT_ROW_CAP): Statement | null {
  const range = monthRange(month);
  if (!range) return null;
  const { from, to } = range;
  const opening = sql.exec<{ b: number }>('SELECT coalesce((SELECT balance_after FROM wallet_ledger WHERE at < ? ORDER BY id DESC LIMIT 1), 0) AS b', from).one().b;
  const closing = sql.exec<{ b: number }>('SELECT coalesce((SELECT balance_after FROM wallet_ledger WHERE at < ? ORDER BY id DESC LIMIT 1), 0) AS b', to).one().b;
  const rows = sql.exec<{ at: number; kind: string; net_minor: number; vat_minor: number; amount_minor: number; balance_after: number; ref: string; wamid: string | null; category: string | null; note: string | null }>(
    'SELECT at, kind, net_minor, vat_minor, amount_minor, balance_after, ref, wamid, category, note FROM wallet_ledger WHERE at >= ? AND at < ? ORDER BY id LIMIT ?', from, to, cap + 1,
  ).toArray();
  const agg = (col: string, extra = '') => sql.exec<Agg>(
    `SELECT ${col} AS k, count(*) AS n, sum(net_minor) AS net, sum(vat_minor) AS vat, sum(amount_minor) AS amt FROM wallet_ledger WHERE at >= ? AND at < ? ${extra} GROUP BY ${col}`, from, to,
  ).toArray();
  const cardCosts = sql.exec<{ category: string; n: number; usd: number }>(
    "SELECT coalesce(charged_category, category_meta, category_est, 'service') AS category, count(*) AS n, sum(cost_usd_micros) AS usd FROM billable_sends WHERE funding = 'merchant_card' AND cost_usd_micros IS NOT NULL AND delivered_at >= ? AND delivered_at < ? GROUP BY 1", from, to,
  ).toArray().map((r) => ({ category: r.category, count: r.n, usdMicros: r.usd }));
  return {
    month, from, to, openingMinor: opening, closingMinor: closing, truncated: rows.length > cap,
    rows: rows.slice(0, cap).map((r) => ({ at: r.at, kind: r.kind, netMinor: r.net_minor, vatMinor: r.vat_minor, amountMinor: r.amount_minor, balanceAfterMinor: r.balance_after, ref: r.ref, wamid: r.wamid, category: r.category, note: r.note })),
    totalsByKind: toMap(agg('kind')), totalsByCategory: toMap(agg('category', 'AND category IS NOT NULL')), cardCosts,
  };
}

/** A cell that a spreadsheet would run as a formula is defused with a leading quote (CSV injection), then quoted when needed. */
const cell = (v: string | number | null): string => {
  let s = v === null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === 'string') s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function statementCsv(st: Statement): string {
  const head = ['date_utc', 'kind', 'category', 'net_egp', 'vat_egp', 'amount_egp', 'balance_after_egp', 'ref', 'wamid', 'note'];
  const lines = [head.join(',')];
  lines.push(['', 'opening_balance', '', '', '', '', egpString(st.openingMinor), '', '', ''].map(cell).join(','));
  for (const r of st.rows) {
    lines.push([new Date(r.at).toISOString(), r.kind, r.category, egpString(r.netMinor), egpString(r.vatMinor), egpString(r.amountMinor), egpString(r.balanceAfterMinor), r.ref, r.wamid, r.note].map(cell).join(','));
  }
  lines.push(['', 'closing_balance', '', '', '', '', egpString(st.closingMinor), '', '', ''].map(cell).join(','));
  return `${lines.join('\n')}\n`;
}
