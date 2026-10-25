import { z } from 'zod';
import { DEFAULT_HOURS, DEFAULT_MENU, hoursSchema, menuSchema } from './bot-settings';
import type { LinkHost } from './host';

/** Workspace settings of the Store link. Absent keys take the defaults below. */
export const storeLinkSettingsSchema = z.object({
  /** Utility confirmation when the Store creates an order (not COD, not from chat). */
  orderConfirmations: z.boolean(),
  /** The ordering bot answers customers in chat. */
  orderingBot: z.boolean(),
  /** One-time codes may be sent over WhatsApp (OTP-1: email stays the main channel). */
  otpViaWhatsApp: z.boolean(),
  /** The merchant's Meta commerce catalog id; empty = catalog sync is off. */
  catalogId: z.string().regex(/^\d{5,25}$/).nullable(),
  /** The customer-facing service menu (FAQ rows). */
  menu: menuSchema,
  /** Business hours and the out-of-hours reply. */
  hours: hoursSchema,
});
export type StoreLinkSettings = z.infer<typeof storeLinkSettingsSchema>;
export const storeLinkSettingsPatch = storeLinkSettingsSchema.partial();

export const DEFAULT_SETTINGS: StoreLinkSettings = { orderConfirmations: true, orderingBot: true, otpViaWhatsApp: false, catalogId: null, menu: DEFAULT_MENU, hours: DEFAULT_HOURS };

const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof StoreLinkSettings)[];
/** Settings kept as JSON text (the rest are flags or the catalog id). An unreadable stored value falls back to the default. */
const JSON_KEYS = { menu: menuSchema, hours: hoursSchema } as const;
type JsonKey = keyof typeof JSON_KEYS;
const isJsonKey = (k: string): k is JsonKey => k in JSON_KEYS;

export function readSettings(host: Pick<LinkHost, 'sql'>): StoreLinkSettings {
  const stored = new Map(host.sql.exec<{ key: string; value: string }>('SELECT key, value FROM store_state WHERE key LIKE ?', 'setting.%').toArray().map((r) => [r.key.slice(8), r.value]));
  const out: StoreLinkSettings = { ...DEFAULT_SETTINGS };
  for (const k of KEYS) {
    const v = stored.get(k);
    if (v === undefined) continue;
    if (isJsonKey(k)) {
      try {
        const parsed = JSON_KEYS[k].safeParse(JSON.parse(v));
        if (parsed.success) (out as Record<string, unknown>)[k] = parsed.data;
      } catch { /* keep the default */ }
    } else if (k === 'catalogId') out.catalogId = v === '' ? null : v;
    else (out as Record<string, unknown>)[k] = v === '1';
  }
  return out;
}

export function writeSettings(host: Pick<LinkHost, 'sql'>, patch: Partial<StoreLinkSettings>): StoreLinkSettings {
  for (const k of KEYS) {
    const v = patch[k];
    if (v === undefined) continue;
    const text = isJsonKey(k) ? JSON.stringify(v) : k === 'catalogId' ? (v === null ? '' : String(v)) : v ? '1' : '0';
    host.sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', `setting.${k}`, text);
  }
  return readSettings(host);
}

export const getState = (host: Pick<LinkHost, 'sql'>, key: string): string | null => host.sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', key).toArray()[0]?.value ?? null;
export const putState = (host: Pick<LinkHost, 'sql'>, key: string, value: string): void => {
  host.sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
};
/** Unset counts as linked: a workspace that predates the `store.linked` event must keep working. */
export const isLinked = (host: Pick<LinkHost, 'sql'>): boolean => getState(host, 'linked') !== '0';
