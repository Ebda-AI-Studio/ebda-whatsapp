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
