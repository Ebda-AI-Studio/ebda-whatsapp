/**
 * Operator (super admin) actions on billing. Every change is a NEW immutable version or an audited row; nothing is edited in place.
 * Lead times (so a workspace's copy always has a version before it takes effect): rate cards and FX >= 24 h, settings and overrides >= 1 h.
 */
import type { Env } from '../../env';
import { RATE_LEAD_MS, SETTINGS_LEAD_MS } from './pricing';
import { monthRange } from './statement';

const alert = (what: string, extra: Record<string, unknown> = {}) => console.error(JSON.stringify({ alert: what, ...extra }));
const SKEW_MS = 5_000;

export async function audit(env: Env, a: { actor: string; action: string; workspaceId?: string | null; before?: unknown; after?: unknown; reason?: string | null }, now = Date.now()): Promise<void> {
  await env.DB.prepare('INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(now, a.actor, a.action, a.workspaceId ?? null, a.before === undefined ? null : JSON.stringify(a.before), a.after === undefined ? null : JSON.stringify(a.after), a.reason ?? null).run();
}

type Settings = { ver: number; effective_from: number; margin_bps: number; credit_limit_minor: number; fx_buffer_bps: number; vat_bps: number; actor: string; reason: string };
const settingsDto = (r: Settings) => ({ ver: r.ver, effectiveFrom: r.effective_from, marginBps: r.margin_bps, creditLimitMinor: r.credit_limit_minor, fxBufferBps: r.fx_buffer_bps, vatBps: r.vat_bps, actor: r.actor, reason: r.reason });

export async function listSettings(env: Env) {
  const { results } = await env.DB.prepare('SELECT ver, effective_from, margin_bps, credit_limit_minor, fx_buffer_bps, vat_bps, actor, reason FROM pricing_settings ORDER BY ver DESC LIMIT 100').all<Settings>();
  return results.map(settingsDto);
}

const inEffect = async (env: Env, now: number) => env.DB.prepare('SELECT ver, effective_from, margin_bps, credit_limit_minor, fx_buffer_bps, vat_bps, actor, reason FROM pricing_settings WHERE effective_from <= ? ORDER BY effective_from DESC, ver DESC LIMIT 1').bind(now).first<Settings>();

export type Publish<T> = { ok: true; value: T } | { ok: false; reason: 'too_soon' };

export async function publishSettings(env: Env, a: { actor: string; effectiveFrom?: number; marginBps: number; creditLimitMinor: number; fxBufferBps: number; vatBps: number; reason: string }, now = Date.now()): Promise<Publish<ReturnType<typeof settingsDto>>> {
  const effective = a.effectiveFrom ?? now + SETTINGS_LEAD_MS + SKEW_MS;
  if (effective < now + SETTINGS_LEAD_MS - SKEW_MS) return { ok: false, reason: 'too_soon' };
  const before = await inEffect(env, now);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await env.DB.prepare('INSERT INTO pricing_settings (ver, effective_from, margin_bps, credit_limit_minor, fx_buffer_bps, vat_bps, actor, reason, created_at) VALUES ((SELECT coalesce(max(ver), 0) + 1 FROM pricing_settings), ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(effective, a.marginBps, a.creditLimitMinor, a.fxBufferBps, a.vatBps, a.actor, a.reason, now).run();
      break;
    } catch (err) {
      if (attempt === 2) throw err; // two publishers took the same version number: retry takes the next one
    }
  }
  const row = (await env.DB.prepare('SELECT ver, effective_from, margin_bps, credit_limit_minor, fx_buffer_bps, vat_bps, actor, reason FROM pricing_settings WHERE actor = ? AND created_at = ? ORDER BY ver DESC LIMIT 1').bind(a.actor, now).first<Settings>())!;
  await audit(env, { actor: a.actor, action: 'pricing_settings_published', before: before ? settingsDto(before) : null, after: settingsDto(row), reason: a.reason }, now);
  return { ok: true, value: settingsDto(row) };
}

export async function publishOverride(env: Env, a: { actor: string; workspaceId: string; effectiveFrom?: number; marginBps: number; reason: string }, now = Date.now()): Promise<Publish<{ ver: number; effectiveFrom: number; marginBps: number }>> {
  const effective = a.effectiveFrom ?? now + SETTINGS_LEAD_MS + SKEW_MS;
  if (effective < now + SETTINGS_LEAD_MS - SKEW_MS) return { ok: false, reason: 'too_soon' };
  const before = await env.DB.prepare('SELECT ver, effective_from, margin_bps FROM workspace_pricing_overrides WHERE workspace_id = ? AND effective_from <= ? ORDER BY effective_from DESC, ver DESC LIMIT 1').bind(a.workspaceId, now).first<{ ver: number; effective_from: number; margin_bps: number }>();
  await env.DB.prepare('INSERT INTO workspace_pricing_overrides (workspace_id, ver, effective_from, margin_bps, actor, reason, created_at) VALUES (?, (SELECT coalesce(max(ver), 0) + 1 FROM workspace_pricing_overrides WHERE workspace_id = ?), ?, ?, ?, ?, ?)')
    .bind(a.workspaceId, a.workspaceId, effective, a.marginBps, a.actor, a.reason, now).run();
  const row = (await env.DB.prepare('SELECT ver, effective_from, margin_bps FROM workspace_pricing_overrides WHERE workspace_id = ? ORDER BY ver DESC LIMIT 1').bind(a.workspaceId).first<{ ver: number; effective_from: number; margin_bps: number }>())!;
  const dto = { ver: row.ver, effectiveFrom: row.effective_from, marginBps: row.margin_bps };
  await audit(env, { actor: a.actor, action: 'pricing_override_published', workspaceId: a.workspaceId, before: before ? { ver: before.ver, marginBps: before.margin_bps } : null, after: dto, reason: a.reason }, now);
  return { ok: true, value: dto };
}

export async function listOverrides(env: Env, workspaceId: string) {
  const { results } = await env.DB.prepare('SELECT ver, effective_from, margin_bps, actor, reason FROM workspace_pricing_overrides WHERE workspace_id = ? ORDER BY ver DESC LIMIT 50').bind(workspaceId).all<{ ver: number; effective_from: number; margin_bps: number; actor: string; reason: string }>();
  return results.map((r) => ({ ver: r.ver, effectiveFrom: r.effective_from, marginBps: r.margin_bps, actor: r.actor, reason: r.reason }));
}

export async function publishRateCard(env: Env, a: { actor: string; effectiveFrom: number; rates: { country: string; category: string; usdMicros: number }[]; reason: string }, now = Date.now()): Promise<Publish<{ ver: number; rows: number }>> {
  if (a.effectiveFrom < now + RATE_LEAD_MS - SKEW_MS) return { ok: false, reason: 'too_soon' };
  const ver = ((await env.DB.prepare('SELECT coalesce(max(ver), 0) AS v FROM rate_cards').first<{ v: number }>())?.v ?? 0) + 1;
  const seen = new Set<string>();
  const stmts = a.rates.filter((r) => !seen.has(`${r.country}/${r.category}`) && seen.add(`${r.country}/${r.category}`)).map((r) =>
    env.DB.prepare('INSERT INTO rate_cards (ver, effective_from, country, category, usd_micros, published_at, actor) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(ver, a.effectiveFrom, r.country, r.category, r.usdMicros, now, a.actor));
  await env.DB.batch(stmts);
  await audit(env, { actor: a.actor, action: 'rate_card_published', after: { ver, effectiveFrom: a.effectiveFrom, rows: stmts.length }, reason: a.reason }, now);
  return { ok: true, value: { ver, rows: stmts.length } };
}

export async function listRateCards(env: Env) {
  const { results } = await env.DB.prepare('SELECT ver, min(effective_from) AS effective_from, count(*) AS rows, max(published_at) AS published_at, max(actor) AS actor FROM rate_cards GROUP BY ver ORDER BY ver DESC LIMIT 50').all<{ ver: number; effective_from: number; rows: number; published_at: number; actor: string }>();
  return results.map((r) => ({ ver: r.ver, effectiveFrom: r.effective_from, rows: r.rows, publishedAt: r.published_at, actor: r.actor }));
}

export async function publishFx(env: Env, a: { actor: string; effectiveFrom: number; egpPerUsdMicros: number; bufferBps: number; reason: string }, now = Date.now()): Promise<Publish<{ ver: number }>> {
  if (a.effectiveFrom < now + RATE_LEAD_MS - SKEW_MS) return { ok: false, reason: 'too_soon' };
  const ver = ((await env.DB.prepare('SELECT coalesce(max(ver), 0) AS v FROM fx_rates').first<{ v: number }>())?.v ?? 0) + 1;
  await env.DB.prepare('INSERT INTO fx_rates (ver, effective_from, egp_per_usd_micros, buffer_bps, published_at, actor) VALUES (?, ?, ?, ?, ?, ?)').bind(ver, a.effectiveFrom, a.egpPerUsdMicros, a.bufferBps, now, a.actor).run();
  await audit(env, { actor: a.actor, action: 'fx_published', after: { ver, effectiveFrom: a.effectiveFrom, egpPerUsdMicros: a.egpPerUsdMicros, bufferBps: a.bufferBps }, reason: a.reason }, now);
  return { ok: true, value: { ver } };
}

export async function listFx(env: Env) {
  const { results } = await env.DB.prepare('SELECT ver, effective_from, egp_per_usd_micros, buffer_bps, published_at, actor FROM fx_rates ORDER BY ver DESC LIMIT 50').all<{ ver: number; effective_from: number; egp_per_usd_micros: number; buffer_bps: number; published_at: number; actor: string }>();
  return results.map((r) => ({ ver: r.ver, effectiveFrom: r.effective_from, egpPerUsdMicros: r.egp_per_usd_micros, bufferBps: r.buffer_bps, publishedAt: r.published_at, actor: r.actor }));
}

/** Who pays Meta for a number. The brand-neutral name is platform_line; the operator UI may still send the legacy alias. */
export async function setFunding(env: Env, a: { actor: string; phoneNumberId: string; funding: 'merchant_card' | 'platform_line'; reason: string }, now = Date.now()): Promise<'ok' | 'not_found'> {
  const number = await env.DB.prepare('SELECT workspace_id FROM phone_numbers WHERE phone_number_id = ?').bind(a.phoneNumberId).first<{ workspace_id: string }>();
  if (!number) return 'not_found';
  const before = await env.DB.prepare('SELECT funding FROM number_funding WHERE phone_number_id = ?').bind(a.phoneNumberId).first<{ funding: string }>();
  await env.DB.prepare('INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, ?, ?)').bind(a.phoneNumberId, a.funding, now).run();
  await audit(env, { actor: a.actor, action: 'number_funding_set', workspaceId: number.workspace_id, before: before ?? null, after: { phoneNumberId: a.phoneNumberId, funding: a.funding }, reason: a.reason }, now);
  return 'ok';
}

// ---- adjustments: actor + reason always; above the threshold a SECOND super admin approves ------------------------------------

/** Self-approved adjustments per actor per rolling day: their absolute amounts together may not pass the threshold, nor their number the cap. */
export const SELF_APPROVE_WINDOW_MS = 24 * 3_600_000;
export const adjustmentDailyCap = (env: Env): number => {
  const n = Number(env.ADJUSTMENT_DAILY_CAP ?? 20);
  return Number.isSafeInteger(n) && n >= 0 ? n : 20;
};
export const adjustmentThreshold = (env: Env): number => {
  const n = Number(env.ADJUSTMENT_APPROVAL_MINOR ?? 100_000);
  return Number.isSafeInteger(n) && n >= 0 ? n : 100_000;
};
type Adj = { id: string; workspace_id: string; amount_minor: number; reason: string; requested_by: string; state: 'pending' | 'approved' | 'rejected'; approved_by: string | null; created_at: number; decided_at: number | null };
const adjDto = (r: Adj) => ({ id: r.id, workspaceId: r.workspace_id, amountMinor: r.amount_minor, reason: r.reason, requestedBy: r.requested_by, state: r.state, approvedBy: r.approved_by, createdAt: r.created_at, decidedAt: r.decided_at });
const ADJ_COLS = 'id, workspace_id, amount_minor, reason, requested_by, state, approved_by, created_at, decided_at';
const stubOf = (env: Env, ws: string) => env.WORKSPACE_DO.get(env.WORKSPACE_DO.idFromName(ws));

async function applyAdjustment(env: Env, r: Adj, now: number): Promise<void> {
  const res = await stubOf(env, r.workspace_id).postWallet({ kind: 'adjustment', netMinor: r.amount_minor, ref: `adj:${r.id}`, actor: r.requested_by, note: r.reason }, now);
  if (!res.ok && res.reason !== 'duplicate') throw new Error(`adjustment refused: ${res.reason}`);
}

export async function requestAdjustment(env: Env, a: { actor: string; workspaceId: string; amountMinor: number; reason: string }, now = Date.now()) {
  const known = await env.DB.prepare('SELECT 1 FROM workspaces WHERE id = ?').bind(a.workspaceId).first();
  if (!known) return { ok: false as const, reason: 'not_found' as const };
  const id = crypto.randomUUID();
  // Every adjustment starts PENDING. The promotion to self-approved is ONE conditional UPDATE that recomputes, inside the same statement, what
  // this actor already approved for themselves in the last 24 h (absolute values, all workspaces, this request included) and how many: D1 runs a
  // statement atomically, so N parallel requests cannot all read the old total. Only a promotion that changed exactly one row is applied.
  await env.DB.prepare('INSERT INTO wallet_adjustments (id, workspace_id, amount_minor, reason, requested_by, state, approved_by, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)')
    .bind(id, a.workspaceId, a.amountMinor, a.reason, a.actor, 'pending', now).run();
  const promoted = await env.DB.prepare(
    `UPDATE wallet_adjustments SET state = 'approved', approved_by = requested_by, decided_at = ?1
      WHERE id = ?2 AND state = 'pending'
        AND (SELECT coalesce(sum(abs(w.amount_minor)), 0) FROM wallet_adjustments w WHERE w.requested_by = ?3 AND w.approved_by = w.requested_by AND w.state = 'approved' AND w.created_at > ?4) + abs(?5) <= ?6
        AND (SELECT count(*) FROM wallet_adjustments w WHERE w.requested_by = ?3 AND w.approved_by = w.requested_by AND w.state = 'approved' AND w.created_at > ?4) < ?7`,
  ).bind(now, id, a.actor, now - SELF_APPROVE_WINDOW_MS, a.amountMinor, adjustmentThreshold(env), adjustmentDailyCap(env)).run();
  const small = promoted.meta.changes === 1;
  const row = (await env.DB.prepare(`SELECT ${ADJ_COLS} FROM wallet_adjustments WHERE id = ?`).bind(id).first<Adj>())!;
  await audit(env, { actor: a.actor, action: small ? 'adjustment_applied' : 'adjustment_requested', workspaceId: a.workspaceId, after: adjDto(row), reason: a.reason }, now);
  if (small) await applyAdjustment(env, row, now);
  return { ok: true as const, adjustment: adjDto(row) };
}

export async function decideAdjustment(env: Env, a: { actor: string; id: string; decision: 'approve' | 'reject' }, now = Date.now()) {
  const row = await env.DB.prepare(`SELECT ${ADJ_COLS} FROM wallet_adjustments WHERE id = ?`).bind(a.id).first<Adj>();
  if (!row) return { ok: false as const, reason: 'not_found' as const };
  if (row.state !== 'pending') return { ok: false as const, reason: 'not_pending' as const };
  if (row.requested_by === a.actor) return { ok: false as const, reason: 'second_approver_required' as const };
  const claimed = await env.DB.prepare("UPDATE wallet_adjustments SET state = ?, approved_by = ?, decided_at = ? WHERE id = ? AND state = 'pending'").bind(a.decision === 'approve' ? 'approved' : 'rejected', a.actor, now, a.id).run();
  if (!claimed.meta.changes) return { ok: false as const, reason: 'not_pending' as const };
  const after = { ...row, state: a.decision === 'approve' ? ('approved' as const) : ('rejected' as const), approved_by: a.actor, decided_at: now };
  await audit(env, { actor: a.actor, action: a.decision === 'approve' ? 'adjustment_approved' : 'adjustment_rejected', workspaceId: row.workspace_id, before: adjDto(row), after: adjDto(after) }, now);
  if (a.decision === 'approve') await applyAdjustment(env, after, now);
  return { ok: true as const, adjustment: adjDto(after) };
}

export async function listAdjustments(env: Env, state?: string) {
  const { results } = await env.DB.prepare(`SELECT ${ADJ_COLS} FROM wallet_adjustments ${state ? 'WHERE state = ?' : ''} ORDER BY created_at DESC LIMIT 200`).bind(...(state ? [state] : [])).all<Adj>();
  return results.map(adjDto);
}

// ---- true-up (WA-SHARED-FREE-1) ------------------------------------------------------------------------------------------------

/** Publishes the month's true-up for a number: what Meta billed vs what every workspace reported being charged. Once per (month, number). */
export async function publishTrueup(env: Env, a: { actor: string; month: string; phoneNumberId: string; actualMinor: number }, now = Date.now()) {
  const r = monthRange(a.month);
  if (!r || r.to > now) return { ok: false as const, reason: 'month_not_closed' as const };
  const usage = await env.DB.prepare('SELECT coalesce(sum(charged_minor), 0) AS charged, coalesce(sum(service_count), 0) AS n, count(*) AS workspaces FROM shared_number_usage WHERE month = ? AND phone_number_id = ?').bind(a.month, a.phoneNumberId).first<{ charged: number; n: number; workspaces: number }>();
  if (!usage || usage.workspaces === 0) return { ok: false as const, reason: 'no_usage_reported' as const };
  const rebate = Math.max(0, usage.charged - a.actualMinor);
  try {
    await env.DB.prepare('INSERT INTO shared_trueups (month, phone_number_id, actual_minor, total_charged_minor, total_count, rebate_minor, actor, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(a.month, a.phoneNumberId, a.actualMinor, usage.charged, usage.n, rebate, a.actor, now).run();
  } catch {
    return { ok: false as const, reason: 'already_published' as const };
  }
  await audit(env, { actor: a.actor, action: 'shared_trueup_published', after: { month: a.month, phoneNumberId: a.phoneNumberId, actualMinor: a.actualMinor, totalChargedMinor: usage.charged, rebateMinor: rebate, workspaces: usage.workspaces } }, now);
  if (rebate === 0) alert('shared_trueup_no_rebate', { month: a.month });
  return { ok: true as const, trueup: { month: a.month, phoneNumberId: a.phoneNumberId, actualMinor: a.actualMinor, totalChargedMinor: usage.charged, totalCount: usage.n, rebateMinor: rebate } };
}

export async function changeLog(env: Env, f: { before?: number; limit: number; workspaceId?: string }) {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (f.before) { where.push('id < ?'); params.push(f.before); }
  if (f.workspaceId) { where.push('workspace_id = ?'); params.push(f.workspaceId); }
  const { results } = await env.DB.prepare(`SELECT id, at, actor, action, workspace_id, before_json, after_json, reason FROM billing_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`).bind(...params, f.limit)
    .all<{ id: number; at: number; actor: string; action: string; workspace_id: string | null; before_json: string | null; after_json: string | null; reason: string | null }>();
  return results.map((r) => ({ id: r.id, at: r.at, actor: r.actor, action: r.action, workspaceId: r.workspace_id, before: r.before_json ? JSON.parse(r.before_json) : null, after: r.after_json ? JSON.parse(r.after_json) : null, reason: r.reason }));
}
