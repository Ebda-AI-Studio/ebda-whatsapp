import type { ContactDto } from '../../../src/core/api/contract';

/** A cell that could be read as a formula by a spreadsheet (starts with = + - @ tab or CR) is prefixed with an apostrophe, so a customer's name can never run as one. */
const cell = (v: string, guard = true): string => {
  const safe = guard && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const iso = (ms: number | null | undefined): string => (typeof ms === 'number' && ms > 0 ? new Date(ms).toISOString() : '');

/** The owner's contacts export: one row per contact, UTF-8 with a BOM so Excel reads Arabic names correctly. */
export function contactsCsv(items: ContactDto[]): string {
  const head = ['phone', 'name', 'opted_out', 'consent_source', 'consent_at', 'tags', 'last_message_from_customer_at'];
  // The phone is digits by construction (`+` and 8-15 digits from the server's own id), so it is the one cell that needs no formula guard.
  const rows = items.map((c) => [cell(`+${c.waId}`, false), ...[c.name ?? '', c.optedOut ? 'yes' : 'no', c.consent?.source ?? '', iso(c.consent?.at), (c.tags ?? []).join(';'), iso((c as { lastInboundAt?: number | null }).lastInboundAt)].map((v) => cell(v))].join(','));
  return `﻿${[head.join(','), ...rows].join('\r\n')}\r\n`;
}
