import { z } from 'zod';

/**
 * Merchant-written bot settings (service menu, business hours, store location). Limits are Meta's: a list row title is at most
 * 24 characters, a description 72, a text message 1024 here (4096 is Meta's own cap; answers stay short on purpose).
 */
const chars = (max: number) => z.string().trim().min(1).refine((s) => Array.from(s).length <= max, `at most ${max} characters`);
const localised = (max: number) => z.object({ ar: chars(max), en: chars(max) }).strict();

export const MENU_MAX_ITEMS = 8;
export const MENU_TITLE_MAX = 24;
export const MENU_ANSWER_MAX = 1024;

export const menuItemSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,31}$/, 'slug'),
  title: localised(MENU_TITLE_MAX),
  answer: localised(MENU_ANSWER_MAX),
}).strict();
export const menuSchema = z.object({
  enabled: z.boolean(),
  items: z.array(menuItemSchema).max(MENU_MAX_ITEMS).refine((items) => new Set(items.map((i) => i.id)).size === items.length, 'duplicate id'),
}).strict();
export type MenuSettings = z.infer<typeof menuSchema>;
export const DEFAULT_MENU: MenuSettings = { enabled: false, items: [] };

// ---- business hours ----------------------------------------------------------------------------------------------------

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM');
export const hoursRangeSchema = z.object({ open: hhmm, close: hhmm }).strict().refine((r) => r.open !== r.close, 'empty range');
const day = z.array(hoursRangeSchema).max(2);
export const HOURS_AWAY_MAX = 1024;
/** Weekday keys follow JavaScript's Date: 0 = Sunday ... 6 = Saturday. A range whose close is earlier than its open runs past midnight. */
export const hoursSchema = z.object({
  enabled: z.boolean(),
  timezone: z.literal('Africa/Cairo'),
  week: z.object({ 0: day, 1: day, 2: day, 3: day, 4: day, 5: day, 6: day }).strict(),
  awayMessage: localised(HOURS_AWAY_MAX),
  /** The ordering bot (and the AI agent) keep answering while closed; off = the away message replaces them. */
  ordersWhileClosed: z.boolean(),
}).strict();
export type HoursSettings = z.infer<typeof hoursSchema>;
const NO_RANGES = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
export const DEFAULT_HOURS: HoursSettings = { enabled: false, timezone: 'Africa/Cairo', week: NO_RANGES, awayMessage: { ar: 'مقفولين دلوقتي', en: 'We are closed right now' }, ordersWhileClosed: true };
