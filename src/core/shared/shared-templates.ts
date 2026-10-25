/**
 * The platform WABA's message templates (item e). They are platform-owned: no store manages them. The catalog is kept in D1
 * (`shared_templates`: definitions only, no message content, no phone numbers). Everything that talks to Meta here uses the PLATFORM token
 * (`META_SYSTEM_TOKEN`) on the shared number's WABA, never a merchant credential.
 *
 * Store-facing rule (Ruling WA-SHARED-NOCAMP-1): a send from the shared number may use only a template that is APPROVED and UTILITY or
 * AUTHENTICATION in this catalog. Marketing is never sendable from the shared number, whatever a store's own copy of a template says.
 */
import type { Env } from '../../env';
import type { TemplateDto } from '../api/contract';
import { fetchTemplates, submitTemplate } from '../meta/templates-api';
import { bodyTextOf, componentsSchema, paramCount, type StoredComponent } from '../templates';
import { currentSharedNumber, type SharedNumberRow } from './shared-number';

const SENDABLE_CATEGORIES = ['UTILITY', 'AUTHENTICATION'];
type Db = Pick<Env, 'DB'>;
type Row = { name: string; language: string; category: string; status: string; components: string; rejected_reason: string | null };
export type SharedTemplateFailure = { ok: false; reason: 'no_number' | 'token_unavailable' | 'meta_unavailable' | 'meta_rejected'; message?: string };

const parts = (json: string): StoredComponent[] => {
  try {
    const p = componentsSchema.safeParse(JSON.parse(json));
    return p.success ? p.data : [];
  } catch {
    return [];
  }
};

/** The platform token, or null when it is not configured (the caller answers 503, nothing is sent). */
const platformToken = (env: Pick<Env, 'META_SYSTEM_TOKEN'>): string | null => (env.META_SYSTEM_TOKEN ? env.META_SYSTEM_TOKEN : null);

export async function listSharedTemplates(env: Db, number: SharedNumberRow): Promise<TemplateDto[]> {
  const { results } = await env.DB.prepare('SELECT name, language, category, status, components, rejected_reason FROM shared_templates WHERE phone_number_id = ? ORDER BY name, language').bind(number.phone_number_id).all<Row>();
  return results.map((t) => {
    const p = parts(t.components);
    return { name: t.name, language: t.language, category: t.category as TemplateDto['category'], status: t.status as TemplateDto['status'], bodyText: bodyTextOf(p), paramCount: paramCount(p, t.category), rejectedReason: t.rejected_reason };
  });
}

/** Replaces the catalog with what Meta returned for the platform WABA (every page, or nothing changes). */
export async function syncSharedTemplates(env: Env): Promise<{ ok: true; upserted: number; removed: number } | SharedTemplateFailure> {
  const number = await currentSharedNumber(env);
  if (!number) return { ok: false, reason: 'no_number' };
  const token = platformToken(env);
  if (!token) return { ok: false, reason: 'token_unavailable' };
  const fetched = await fetchTemplates({ token, graphVersion: env.META_GRAPH_VERSION, wabaId: number.waba_id });
  if (!fetched.ok) return { ok: false, reason: 'meta_unavailable', message: fetched.message };
  const now = Date.now();
  const have = new Set((await env.DB.prepare('SELECT name, language FROM shared_templates WHERE phone_number_id = ?').bind(number.phone_number_id).all<{ name: string; language: string }>()).results.map((r) => `${r.name}\u0000${r.language}`));
  const incoming = new Map(fetched.value.map((t) => [`${t.name}\u0000${t.language}`, t]));
  const removed = [...have].filter((k) => !incoming.has(k)).length;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM shared_templates WHERE phone_number_id = ?').bind(number.phone_number_id),
    ...[...incoming.values()].map((t) =>
      env.DB.prepare('INSERT INTO shared_templates (phone_number_id, name, language, category, status, components, rejected_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(number.phone_number_id, t.name, t.language, t.category.toUpperCase(), t.status.toUpperCase(), JSON.stringify(t.components), t.rejected_reason ?? null, now)),
  ]);
  return { ok: true, upserted: incoming.size, removed };
}

/** Submits a new template to the platform WABA. Marketing is not accepted: it could never be sent from the shared number. */
export async function submitSharedTemplate(env: Env, t: { name: string; language: string; category: 'UTILITY' | 'AUTHENTICATION'; components: unknown[] }): Promise<{ ok: true; status: string } | SharedTemplateFailure> {
  const number = await currentSharedNumber(env);
  if (!number) return { ok: false, reason: 'no_number' };
  const token = platformToken(env);
  if (!token) return { ok: false, reason: 'token_unavailable' };
  const res = await submitTemplate({ token, graphVersion: env.META_GRAPH_VERSION, wabaId: number.waba_id }, t);
  if (!res.ok) return { ok: false, reason: res.retryable ? 'meta_unavailable' : 'meta_rejected', message: res.message };
  // Store what META answered, not what we asked for: Meta may recategorise (utility -> marketing). An answer that states no category is kept
  // as UNCONFIRMED, which is never sendable until a sync or a Meta event says what the template is.
  const category = res.value.categoryConfirmed ? res.value.category.toUpperCase() : 'UNCONFIRMED';
  const status = res.value.status.toUpperCase();
  await env.DB.prepare(
    `INSERT INTO shared_templates (phone_number_id, name, language, category, status, components, rejected_reason, updated_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(phone_number_id, name, language) DO UPDATE SET category = excluded.category, status = excluded.status, components = excluded.components, rejected_reason = NULL, updated_at = excluded.updated_at`,
  ).bind(number.phone_number_id, t.name, t.language, category, status, JSON.stringify(t.components), Date.now()).run();
  return { ok: true, status };
}

/**
 * Meta's template events for the platform WABA. The catalog row follows Meta's LATEST word; an unknown template or another WABA changes nothing
 * (the next sync brings it). Returns whether a row changed.
 */
export async function applySharedTemplateEvent(env: Db, wabaId: string, name: string, language: string, change: { status: string; reason: string | null } | { category: string }): Promise<boolean> {
  const number = await env.DB.prepare('SELECT phone_number_id FROM shared_numbers WHERE waba_id = ?').bind(wabaId).first<{ phone_number_id: string }>();
  if (!number) return false;
  const r = 'category' in change
    ? await env.DB.prepare('UPDATE shared_templates SET category = ?, updated_at = ? WHERE phone_number_id = ? AND name = ? AND language = ?').bind(change.category.toUpperCase(), Date.now(), number.phone_number_id, name, language).run()
    : await env.DB.prepare('UPDATE shared_templates SET status = ?, rejected_reason = ?, updated_at = ? WHERE phone_number_id = ? AND name = ? AND language = ?').bind(change.status.toUpperCase(), change.reason, Date.now(), number.phone_number_id, name, language).run();
  return (r.meta.changes ?? 0) > 0;
}

/** May a store send this template from the shared number? Fail closed: anything not found, not approved or not UTILITY/AUTHENTICATION is no. */
export async function sharedTemplateSendable(env: Db, phoneNumberId: string, name: string, language: string): Promise<boolean> {
  const t = await env.DB.prepare('SELECT category, status FROM shared_templates WHERE phone_number_id = ? AND name = ? AND language = ?').bind(phoneNumberId, name, language).first<{ category: string; status: string }>();
  // Both values are Meta's latest (sync, event or submit answer), upper-cased on write; compared upper-cased again so a stray value never passes.
  return !!t && t.status.toUpperCase() === 'APPROVED' && SENDABLE_CATEGORIES.includes(t.category.toUpperCase());
}
