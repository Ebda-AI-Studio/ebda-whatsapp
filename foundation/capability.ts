import { z } from 'zod';

export const POLICIES = ['free', 'preview', 'confirm', 'forbidden'] as const;
export const STATUSES = ['live', 'in-pr', 'planned'] as const;
export const UNDO_CLASSES = ['reversible', 'compensating', 'irreversible', 'none', 'unclassified'] as const;
export const ROLES = ['public', 'customer', 'owner', 'staff', 'super_admin', 'operator'] as const;
export const OPERATOR_REASONS = ['abuse', 'legal', 'money-dispute', 'platform-config', 'critical'] as const;

export type Policy = (typeof POLICIES)[number];
export type Role = (typeof ROLES)[number];

export const capabilitySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/),
  status: z.enum(STATUSES),
  pr: z.string().optional(),
  plan: z.string().optional(),
  area: z.string().min(1),
  version: z.number().int().min(1),
  versionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => {
      const t = Date.parse(`${d}T00:00:00Z`);
      return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d);
    }, 'not a real calendar date'),
  titleAr: z.string(),
  titleEn: z.string(),
  screens: z.array(z.string()),
  screenGap: z.string().optional(),
  api: z.array(z.string()),
  /** POST routes of this entry that only read (e.g. a sync that pulls remote state into local state). Names each excused route and a reason; every other write in the entry still counts. */
  readOnlyPost: z.object({ routes: z.array(z.string().min(1)).min(1), reason: z.string().min(1) }).optional(),
  mcpTool: z.string().nullable(),
  planGate: z.string().nullable(),
  roles: z.array(z.enum(ROLES)).min(1),
  policy: z.enum(POLICIES),
  undo: z.object({ class: z.enum(UNDO_CLASSES), note: z.string().optional() }),
  operatorReason: z.object({ code: z.enum(OPERATOR_REASONS).nullable(), text: z.string(), validUnderRule: z.boolean() }).optional(),
  helpArticle: z.string().nullable(),
  helpGap: z.string().optional(),
  questions: z.object({ ar: z.array(z.string()), en: z.array(z.string()) }),
  steps: z.array(z.string()),
  edgeCases: z.array(z.string()),
  gaps: z.array(z.string()),
  assistantNote: z.string().optional(),
});
export type Capability = z.infer<typeof capabilitySchema>;

export interface Violation {
  rule: string;
  key: string;
  message: string;
}

export const guardConfigSchema = z.object({
  product: z.string(),
  mustConfirm: z.array(z.object({ method: z.string().optional(), pattern: z.string() })),
  routeKinds: z.array(z.object({ match: z.string(), kind: z.enum(['public', 'internal', 'merchant', 'super_admin', 'operator']) })),
  helpExemptAreas: z.array(z.string()),
  smartLayerPaths: z.array(z.string()),
});
export type GuardConfig = z.infer<typeof guardConfigSchema>;

/** "get /stores/:storeId/orders/" -> "GET /stores/:_/orders": one spelling per claimed route. */
export function normalizeApi(s: string): string {
  const m = /^(\S+)\s+(.*)$/.exec(s.trim());
  const method = (m ? m[1]! : '').toUpperCase();
  let path = m ? m[2]! : s.trim();
  try {
    path = decodeURIComponent(path);
  } catch {
    /* undecodable: keep as is */
  }
  path = path.replace(/\/{2,}/g, '/');
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  path = path.split('/').map((seg) => (seg.startsWith(':') || /^\[.+\]$/.test(seg) || /^\{.+\}$/.test(seg) ? ':_' : seg)).join('/');
  return `${method} ${path}`.trim();
}

export function helpUrl(slug: string, lang: 'ar' | 'en'): string {
  return `https://help.ebda.app/${lang === 'en' ? 'en/' : ''}${slug}/`;
}
