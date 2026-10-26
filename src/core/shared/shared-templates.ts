/**
 * The platform WABA's message templates (item e). They are platform-owned: no store manages them. The catalog is kept in D1
 * (`shared_templates`, keyed by WABA because Meta templates belong to the WABA: definitions only, no message content, no phone numbers). Everything that talks to Meta here uses the PLATFORM token
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
import { alert } from '../observability';

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
  const { results } = await env.DB.prepare('SELECT name, language, category, status, components, rejected_reason FROM shared_templates WHERE waba_id = ? ORDER BY name, language').bind(number.waba_id).all<Row>();
  return results.map((t) => {
    const p = parts(t.components);
    return { name: t.name, language: t.language, category: t.category as TemplateDto['category'], status: t.status as TemplateDto['status'], bodyText: bodyTextOf(p), paramCount: paramCount(p, t.category), rejectedReason: t.rejected_reason };
  });
}

/**
 * The rule that keeps the catalog fail-closed (WA-SHARED-NOCAMP-1). Tightening always applies; loosening applies only if no tightening was
 * recorded after the read began. Both instants come from the DATABASE clock (`unixepoch('subsec')`), never from an isolate's Date.now().
 */
const TIGHT = "(excluded.status <> 'APPROVED' OR excluded.category NOT IN ('UTILITY', 'AUTHENTICATION'))";
const UPSERT_FROM_META = `INSERT INTO shared_templates (waba_id, name, language, category, status, components, rejected_reason, updated_at, tightened_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, CASE WHEN ?5 <> 'APPROVED' OR ?4 NOT IN ('UTILITY', 'AUTHENTICATION') THEN unixepoch('subsec') END)
  ON CONFLICT(waba_id, name, language) DO UPDATE SET
    status = CASE WHEN excluded.status <> 'APPROVED' OR shared_templates.tightened_at IS NULL OR shared_templates.tightened_at < ?9 THEN excluded.status ELSE shared_templates.status END,
    category = CASE WHEN excluded.category NOT IN ('UTILITY', 'AUTHENTICATION') OR shared_templates.tightened_at IS NULL OR shared_templates.tightened_at < ?9 THEN excluded.category ELSE shared_templates.category END,
    components = excluded.components, rejected_reason = excluded.rejected_reason, updated_at = excluded.updated_at,
    tightened_at = CASE WHEN ${TIGHT} THEN unixepoch('subsec') ELSE shared_templates.tightened_at END`;

/** The database's clock now (seconds, sub-second precision): taken BEFORE a read or submit begins. */
const dbNow = async (env: Db): Promise<number> => (await env.DB.prepare("SELECT unixepoch('subsec') AS t").first<{ t: number }>())!.t;

type FromMeta = { name: string; language: string; category: string; status: string; components: unknown[]; rejected_reason?: string | null | undefined };
/** One statement per template Meta described. `readStarted` = the database clock when the read (or submit) that produced it BEGAN. */
const upsertStatements = (env: Db, wabaId: string, items: FromMeta[], readStarted: number) =>
  items.map((t) => env.DB.prepare(UPSERT_FROM_META).bind(wabaId, t.name, t.language, t.category.toUpperCase(), t.status.toUpperCase(), JSON.stringify(t.components), t.rejected_reason ?? null, Date.now(), readStarted));
/** Templates Meta does not list any more: never sendable. Disabled in place (a tightening), not deleted. */
const disableStatement = (env: Db, wabaId: string, name: string, language: string) =>
  env.DB.prepare("UPDATE shared_templates SET status = 'DISABLED', tightened_at = unixepoch('subsec'), updated_at = ? WHERE waba_id = ? AND name = ? AND language = ?").bind(Date.now(), wabaId, name, language);

/** Syncs the catalog from Meta (every page, or nothing changes): upserts with the tighten/loosen rule; what Meta no longer lists is disabled. */
export async function syncSharedTemplates(env: Env): Promise<{ ok: true; upserted: number; removed: number } | SharedTemplateFailure> {
  const number = await currentSharedNumber(env);
  if (!number) return { ok: false, reason: 'no_number' };
  const token = platformToken(env);
  if (!token) return { ok: false, reason: 'token_unavailable' };
  const readStarted = await dbNow(env);
  const fetched = await fetchTemplates({ token, graphVersion: env.META_GRAPH_VERSION, wabaId: number.waba_id });
  if (!fetched.ok) return { ok: false, reason: 'meta_unavailable', message: fetched.message };
  const incoming = new Map(fetched.value.map((t) => [`${t.name}\u0000${t.language}`, t]));
  const have = (await env.DB.prepare("SELECT name, language FROM shared_templates WHERE waba_id = ? AND status <> 'DISABLED'").bind(number.waba_id).all<{ name: string; language: string }>()).results;
  const gone = have.filter((r) => !incoming.has(`${r.name}\u0000${r.language}`));
  await env.DB.batch([...upsertStatements(env, number.waba_id, [...incoming.values()], readStarted), ...gone.map((r) => disableStatement(env, number.waba_id, r.name, r.language))]);
  return { ok: true, upserted: incoming.size, removed: gone.length };
}

/** Submits a new template to the platform WABA. Marketing is not accepted: it could never be sent from the shared number. */
export async function submitSharedTemplate(env: Env, t: { name: string; language: string; category: 'UTILITY' | 'AUTHENTICATION'; components: unknown[] }): Promise<{ ok: true; status: string } | SharedTemplateFailure> {
  const number = await currentSharedNumber(env);
  if (!number) return { ok: false, reason: 'no_number' };
  const token = platformToken(env);
  if (!token) return { ok: false, reason: 'token_unavailable' };
  const submittedAt = await dbNow(env);
  const res = await submitTemplate({ token, graphVersion: env.META_GRAPH_VERSION, wabaId: number.waba_id }, t);
  if (!res.ok) return { ok: false, reason: res.retryable ? 'meta_unavailable' : 'meta_rejected', message: res.message };
  // Store what META answered, not what we asked for: Meta may recategorise (utility -> marketing). An answer that states no category is kept
  // as UNCONFIRMED, which is never sendable until a sync or a Graph read says what the template is.
  const category = res.value.categoryConfirmed ? res.value.category.toUpperCase() : 'UNCONFIRMED';
  const status = res.value.status.toUpperCase();
  await env.DB.batch(upsertStatements(env, number.waba_id, [{ name: t.name, language: t.language, category, status, components: t.components }], submittedAt));
  return { ok: true, status };
}

const isSendableCategory = (c: string) => SENDABLE_CATEGORIES.includes(c.toUpperCase());

/**
 * Asks Graph for the CURRENT state of one template (every language) and upserts it with the tighten/loosen rule: the only way a row loosens.
 * Graph unreachable: the row stays exactly as it is (never loosened) and an alert is logged.
 */
async function refreshSharedTemplate(env: Env, wabaId: string, name: string): Promise<void> {
  const token = platformToken(env);
  const readStarted = await dbNow(env);
  const fetched = token ? await fetchTemplates({ token, graphVersion: env.META_GRAPH_VERSION, wabaId }, { name }) : null;
  if (!fetched || !fetched.ok) {
    alert('shared_template_refresh_failed', { name, reason: fetched ? 'meta_unavailable' : 'token_unavailable' });
    return;
  }
  const mine = fetched.value.filter((t) => t.name === name);
  const have = (await env.DB.prepare("SELECT language FROM shared_templates WHERE waba_id = ? AND name = ? AND status <> 'DISABLED'").bind(wabaId, name).all<{ language: string }>()).results;
  await env.DB.batch([
    ...upsertStatements(env, wabaId, mine, readStarted),
    ...have.filter((h) => !mine.some((t) => t.language === h.language)).map((h) => disableStatement(env, wabaId, name, h.language)),
  ]);
}

/**
 * Meta's template events for the platform WABA. No ordering is trusted (webhooks arrive late, twice, out of order), so the rule does not depend on it:
 *  - TIGHTENING (status other than APPROVED, or a category other than UTILITY/AUTHENTICATION) applies at once, whatever the row holds, and records
 *    `tightened_at`. It can only make the template less sendable, so a replay or a Graph outage cannot hurt.
 *  - LOOSENING is never taken from a webhook: it triggers a fresh Graph read of that template, and the row loosens only from that answer, and only if
 *    no tightening was recorded after the read began (one clock: ours).
 * A template the catalog does not know is recorded as a tightened placeholder when the event tightens (so a Graph read already in flight cannot
 * resurrect it); otherwise ignored. Another WABA changes nothing.
 */
export async function applySharedTemplateEvent(
  env: Env, wabaId: string, name: string, language: string, change: { status: string; reason: string | null } | { category: string },
): Promise<'tightened' | 'refreshed' | 'ignored'> {
  // Only a WABA that carries a shared number has a platform catalog (any number on it: they all share the one catalog).
  if (!(await env.DB.prepare('SELECT 1 FROM shared_numbers WHERE waba_id = ? LIMIT 1').bind(wabaId).first())) return 'ignored';
  const now = Date.now();
  if ('category' in change) {
    const category = change.category.toUpperCase();
    if (isSendableCategory(category)) { await refreshSharedTemplate(env, wabaId, name); return 'refreshed'; }
    await env.DB.prepare(
      `INSERT INTO shared_templates (waba_id, name, language, category, status, components, rejected_reason, updated_at, tightened_at) VALUES (?, ?, ?, ?, 'PENDING', '[]', NULL, ?, unixepoch('subsec'))
       ON CONFLICT(waba_id, name, language) DO UPDATE SET category = excluded.category, tightened_at = excluded.tightened_at, updated_at = excluded.updated_at`,
    ).bind(wabaId, name, language, category, now).run();
    return 'tightened';
  }
  const status = change.status.toUpperCase();
  if (status === 'APPROVED') { await refreshSharedTemplate(env, wabaId, name); return 'refreshed'; }
  await env.DB.prepare(
    `INSERT INTO shared_templates (waba_id, name, language, category, status, components, rejected_reason, updated_at, tightened_at) VALUES (?, ?, ?, 'UNCONFIRMED', ?, '[]', ?, ?, unixepoch('subsec'))
     ON CONFLICT(waba_id, name, language) DO UPDATE SET status = excluded.status, rejected_reason = excluded.rejected_reason, tightened_at = excluded.tightened_at, updated_at = excluded.updated_at`,
  ).bind(wabaId, name, language, status, change.reason, now).run();
  return 'tightened';
}

/** May a store send this template from the shared number? Fail closed: anything not found, not approved or not UTILITY/AUTHENTICATION is no. */
export async function sharedTemplateSendable(env: Db, phoneNumberId: string, name: string, language: string): Promise<boolean> {
  // number -> its WABA -> the WABA's catalog row (indexed: shared_numbers_waba / the primary key).
  const t = await env.DB.prepare('SELECT t.category, t.status FROM shared_numbers n JOIN shared_templates t ON t.waba_id = n.waba_id WHERE n.phone_number_id = ? AND t.name = ? AND t.language = ?').bind(phoneNumberId, name, language).first<{ category: string; status: string }>();
  // Both values are Meta's latest (sync, event or submit answer), upper-cased on write; compared upper-cased again so a stray value never passes.
  return !!t && t.status.toUpperCase() === 'APPROVED' && SENDABLE_CATEGORIES.includes(t.category.toUpperCase());
}
