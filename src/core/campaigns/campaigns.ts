import { segmentCriteria, type CampaignDto, type CampaignParam, type SegmentCriteria } from '../api/contract';
import { errClass } from '../observability';
import { addTask } from '../scheduler';
import { cleanParam, queueTemplate } from '../store-link/outbound';
import type { LinkHost } from '../store-link/host';
import { componentsSchema, renderTemplate } from '../templates';
import { DEFAULT_TIER, TIER_WINDOW_MS } from '../throttle';
import { audiencePage, getSegment, previewAudience } from './segments';
import { campaignWallet } from './wallet';

/** Recipients queued per workflow step. */
export const PAGE_SIZE = 500;
/** How often the safety sweep checks that every active campaign still has a live workflow. */
export const SWEEP_MS = 10 * 60_000;
/** A manual pause parks unsent messages this far ahead; resume brings them back. */
export const PARK_MS = 30 * 86_400_000;
/** A campaign whose workflow keeps dying is paused instead of being restarted forever. */
export const MAX_ATTEMPTS = 30;
export const MAX_SCHEDULE_AHEAD_MS = 365 * 86_400_000;

export type CampaignStatus = CampaignDto['status'];
export type PauseReason = NonNullable<CampaignDto['pauseReason']>;
type Row = {
  id: string; name: string; template_name: string; template_language: string; category: string; params: string; criteria: string; segment_id: number | null;
  phone_number_id: string; status: CampaignStatus; pause_reason: PauseReason | null; scheduled_at: number | null; daily_send_limit: number | null;
  attempt: number; next_page: number; cursor: number; created_by: string | null; created_at: number; updated_at: number; started_at: number | null; finished_at: number | null;
};
const COLS = 'id, name, template_name, template_language, category, params, criteria, segment_id, phone_number_id, status, pause_reason, scheduled_at, daily_send_limit, attempt, next_page, cursor, created_by, created_at, updated_at, started_at, finished_at';

const read = (host: LinkHost, id: string): Row | null => host.sql.exec<Row>(`SELECT ${COLS} FROM campaigns WHERE id = ?`, id).toArray()[0] ?? null;

/** The key of one recipient's message: stable per campaign and contact, so a redelivered or replayed step can never send twice. */
export const recipientKey = (campaignId: string, contactId: number): string => `camp:${campaignId}:${contactId}`;
export const pageRef = (campaignId: string, page: number): string => `camp:${campaignId}:p${page}`;

/**
 * The parent reservation a message belongs to (Phase 7: a per-message hold draws from its page's reservation instead of reserving
 * again), or null when the message is not a campaign message.
 */
export function parentHoldRef(host: LinkHost, idempotencyKey: string): string | null {
  if (!idempotencyKey.startsWith('camp:')) return null;
  const r = host.sql.exec<{ campaign_id: string; page: number }>('SELECT campaign_id, page FROM campaign_recipients WHERE idem = ?', idempotencyKey).toArray()[0];
  return r ? pageRef(r.campaign_id, r.page) : null;
}

/** The template parameters for one contact. */
export function resolveParams(specs: CampaignParam[], name: string | null): string[] {
  return specs.map((s) => (s.kind === 'text' ? s.value : cleanParam(name, s.fallback)));
}

const ZERO_COUNTS = { queued: 0, claimed: 0, retry: 0, accepted: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0 };

function counts(host: LinkHost, id: string): CampaignDto['counts'] {
  const out = { ...ZERO_COUNTS };
  for (const r of host.sql.exec<{ s: string | null; n: number }>(
    'SELECT coalesce(m.status, r.state) AS s, count(*) AS n FROM campaign_recipients r LEFT JOIN messages m ON m.idempotency_key = r.idem WHERE r.campaign_id = ? GROUP BY s', id,
  ).toArray()) {
    if (r.s && r.s in out) out[r.s as keyof typeof out] += r.n;
  }
  return out;
}

export function totalsOf(c: CampaignDto['counts']): CampaignDto['totals'] {
  const sent = c.accepted + c.sent + c.delivered + c.read;
  return {
    recipients: Object.values(c).reduce((a, b) => a + b, 0), pending: c.queued + c.claimed + c.retry, sent, delivered: c.delivered + c.read, read: c.read, failed: c.failed, skipped: c.skipped,
  };
}

async function view(host: LinkHost, r: Row, withEstimate: boolean): Promise<CampaignDto> {
  const c = counts(host, r.id);
  const criteria = segmentCriteria.parse(JSON.parse(r.criteria));
  const dto: CampaignDto = {
    id: r.id, name: r.name, status: r.status, pauseReason: r.pause_reason, template: { name: r.template_name, language: r.template_language }, category: r.category,
    params: JSON.parse(r.params) as CampaignParam[], audience: { segmentId: r.segment_id, criteria }, scheduledAt: r.scheduled_at, dailySendLimit: r.daily_send_limit,
    createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at, counts: c, totals: totalsOf(c),
  };
  if (withEstimate && (r.status === 'draft' || r.status === 'scheduled')) {
    const audience = previewAudience(host, criteria).count;
    const perMessageMinor = await campaignWallet().walletEstimate(host.workspaceId, r.category);
    dto.estimate = { audience, perMessageMinor, totalMinor: perMessageMinor * audience };
  }
  return dto;
}

export async function getCampaign(host: LinkHost, id: string): Promise<CampaignDto | null> {
  const r = read(host, id);
  return r ? view(host, r, true) : null;
}

export async function listCampaigns(host: LinkHost, q: { status?: CampaignStatus; cursor?: number; limit: number }): Promise<{ items: CampaignDto[]; nextCursor: string | null }> {
  const where: string[] = [];
  const params: SqlStorageValue[] = [];
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.cursor !== undefined) { where.push('rowid < ?'); params.push(q.cursor); }
  const rows = host.sql.exec<Row & { rid: number }>(`SELECT rowid AS rid, ${COLS} FROM campaigns ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY rowid DESC LIMIT ?`, ...params, q.limit + 1).toArray();
  const page = rows.slice(0, q.limit);
  return { items: await Promise.all(page.map((r) => view(host, r, true))), nextCursor: rows.length > q.limit ? String(page[page.length - 1]!.rid) : null };
}

type TemplateRow = { category: string; status: string; components: string };
const templateOf = (host: LinkHost, name: string, language: string): TemplateRow | undefined =>
  host.sql.exec<TemplateRow>('SELECT category, status, components FROM templates WHERE name = ? AND language = ?', name, language).toArray()[0];

export type CreateArgs = {
  name: string; template: { name: string; language: string }; params: CampaignParam[]; audience: { segmentId: number } | { criteria: SegmentCriteria };
  dailySendLimit?: number | undefined; phoneNumberId: string; actor: string; now: number;
};
export type CreateResult = { ok: true; campaign: CampaignDto } | { ok: false; reason: 'segment_not_found' | 'template_not_approved' | 'wrong_category' | 'invalid_params' | 'empty_audience'; message?: string };

/** Saves a draft after checking, now, everything that can be checked: the audience exists and is not empty, the template is approved and the parameters fit it. */
export async function createCampaign(host: LinkHost, a: CreateArgs): Promise<CreateResult> {
  let criteria: SegmentCriteria;
  let segmentId: number | null = null;
  if ('segmentId' in a.audience) {
    const seg = getSegment(host, a.audience.segmentId);
    if (!seg) return { ok: false, reason: 'segment_not_found' };
    criteria = seg.criteria;
    segmentId = seg.id;
  } else {
    criteria = a.audience.criteria;
  }
  const t = templateOf(host, a.template.name, a.template.language);
  if (!t || t.status !== 'APPROVED') return { ok: false, reason: 'template_not_approved' };
  if (t.category === 'AUTHENTICATION') return { ok: false, reason: 'wrong_category' };
  const stored = componentsSchema.safeParse(JSON.parse(t.components));
  if (!stored.success) return { ok: false, reason: 'invalid_params', message: 'stored template is malformed' };
  const dry = renderTemplate(stored.data, resolveParams(a.params, 'Sample'), t.category);
  if (!dry.ok) return { ok: false, reason: 'invalid_params', message: dry.message };
  if (previewAudience(host, criteria).count === 0) return { ok: false, reason: 'empty_audience' };
  const id = crypto.randomUUID();
  host.sql.exec(
    `INSERT INTO campaigns (id, name, template_name, template_language, category, params, criteria, segment_id, phone_number_id, status, daily_send_limit, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)`,
    id, a.name, a.template.name, a.template.language, t.category, JSON.stringify(a.params), JSON.stringify(criteria), segmentId, a.phoneNumberId, a.dailySendLimit ?? null, a.actor, a.now, a.now,
  );
  return { ok: true, campaign: await view(host, read(host, id)!, true) };
}

export type Transition = { ok: true; campaign: CampaignDto; launch: boolean } | { ok: false; reason: 'not_found' | 'bad_state' | 'invalid_schedule' | 'template_not_approved' | 'empty_audience' };

/** draft -> running (now) or scheduled (a future `scheduledAt`). The caller launches the workflow when `launch` is set. */
export async function sendCampaign(host: LinkHost, id: string, scheduledAt: number | undefined, now: number): Promise<Transition> {
  const c = read(host, id);
  if (!c) return { ok: false, reason: 'not_found' };
  if (c.status !== 'draft') return { ok: false, reason: 'bad_state' };
  if (scheduledAt !== undefined && scheduledAt > now + MAX_SCHEDULE_AHEAD_MS) return { ok: false, reason: 'invalid_schedule' };
  const t = templateOf(host, c.template_name, c.template_language);
  if (!t || t.status !== 'APPROVED') return { ok: false, reason: 'template_not_approved' };
  if (previewAudience(host, segmentCriteria.parse(JSON.parse(c.criteria))).count === 0) return { ok: false, reason: 'empty_audience' };
  const later = scheduledAt !== undefined && scheduledAt > now + 5_000;
  host.sql.exec('UPDATE campaigns SET status = ?, scheduled_at = ?, started_at = ?, updated_at = ? WHERE id = ?', later ? 'scheduled' : 'running', later ? scheduledAt! : null, later ? null : now, now, id);
  return { ok: true, campaign: await view(host, read(host, id)!, false), launch: true };
}

const PARKED = 'campaign_paused';

/** Messages of this campaign still waiting in the scheduler are moved far ahead (reason `campaign_paused`) so a pause stops sending now. */
function parkUnsent(host: LinkHost, id: string, now: number): void {
  host.sql.exec(
    "UPDATE scheduled_tasks SET due_at = ?, payload = json_set(payload, '$.reason', ?) WHERE kind = 'send_release' AND lease_until IS NULL AND json_extract(payload, '$.job.idempotencyKey') LIKE ?",
    now + PARK_MS, PARKED, `camp:${id}:%`,
  );
}
function unparkUnsent(host: LinkHost, id: string, now: number): void {
  host.sql.exec(
    "UPDATE scheduled_tasks SET due_at = ?, payload = json_set(payload, '$.reason', 'event') WHERE kind = 'send_release' AND lease_until IS NULL AND json_extract(payload, '$.reason') = ? AND json_extract(payload, '$.job.idempotencyKey') LIKE ?",
    now, PARKED, `camp:${id}:%`,
  );
}

/**
 * running|scheduled -> paused. A manual pause also holds the messages already queued for the scheduler; a pause for a reason that is
 * not the merchant's (empty wallet, template withdrawn) lets the already-reserved pages go out and only stops new pages.
 */
export async function pauseCampaign(host: LinkHost, id: string, reason: PauseReason, now: number): Promise<Transition> {
  const c = read(host, id);
  if (!c) return { ok: false, reason: 'not_found' };
  if (c.status !== 'running' && c.status !== 'scheduled') return { ok: false, reason: 'bad_state' };
  host.sql.exec("UPDATE campaigns SET status = 'paused', pause_reason = ?, updated_at = ? WHERE id = ?", reason, now, id);
  if (reason === 'manual') parkUnsent(host, id, now);
  return { ok: true, campaign: await view(host, read(host, id)!, false), launch: false };
}

export async function resumeCampaign(host: LinkHost, id: string, now: number): Promise<Transition> {
  const c = read(host, id);
  if (!c) return { ok: false, reason: 'not_found' };
  if (c.status !== 'paused') return { ok: false, reason: 'bad_state' };
  const stillScheduled = c.started_at === null && c.scheduled_at !== null && c.scheduled_at > now + 5_000;
  host.sql.exec('UPDATE campaigns SET status = ?, pause_reason = NULL, started_at = coalesce(started_at, ?), updated_at = ? WHERE id = ?', stillScheduled ? 'scheduled' : 'running', stillScheduled ? null : now, now, id);
  unparkUnsent(host, id, now);
  return { ok: true, campaign: await view(host, read(host, id)!, false), launch: true };
}

/** Any unfinished campaign -> cancelled. Messages not yet with Meta are failed (`campaign_cancelled`) and their scheduled sends removed. */
export async function cancelCampaign(host: LinkHost, id: string, now: number, emitStatus: (messageId: number) => void): Promise<Transition> {
  const c = read(host, id);
  if (!c) return { ok: false, reason: 'not_found' };
  if (c.status === 'completed' || c.status === 'cancelled') return { ok: false, reason: 'bad_state' };
  host.sql.exec("UPDATE campaigns SET status = 'cancelled', pause_reason = NULL, finished_at = ?, updated_at = ? WHERE id = ?", now, now, id);
  host.sql.exec("DELETE FROM scheduled_tasks WHERE kind = 'send_release' AND lease_until IS NULL AND json_extract(payload, '$.job.idempotencyKey') LIKE ?", `camp:${id}:%`);
  const failed = host.sql.exec<{ id: number }>(
    `UPDATE messages SET status = 'failed', error_reason = 'campaign_cancelled', updated_at = ? WHERE status IN ('queued', 'retry') AND direction = 'out'
       AND idempotency_key IN (SELECT idem FROM campaign_recipients WHERE campaign_id = ?) RETURNING id`, now, id,
  ).toArray();
  for (const m of failed) emitStatus(m.id);
  return { ok: true, campaign: await view(host, read(host, id)!, false), launch: false };
}

export function deleteDraft(host: LinkHost, id: string): 'deleted' | 'not_found' | 'bad_state' {
  const c = read(host, id);
  if (!c) return 'not_found';
  if (c.status !== 'draft') return 'bad_state';
  host.sql.exec('DELETE FROM campaigns WHERE id = ?', id);
  return 'deleted';
}

/** What a send_release or queued job of a campaign message must do right now, from the campaign's state. */
export function gateFor(host: LinkHost, idempotencyKey: string): 'go' | 'paused' | 'cancelled' {
  const id = idempotencyKey.split(':')[1];
  const st = id ? host.sql.exec<{ status: CampaignStatus }>('SELECT status FROM campaigns WHERE id = ?', id).toArray()[0]?.status : undefined;
  if (st === 'cancelled') return 'cancelled';
  return st === 'paused' ? 'paused' : 'go';
}

// ---- Pacing -------------------------------------------------------------------------------------------------------

export type Capacity = { room: number; until: number };

/**
 * How many more recipients may be queued now without outrunning the number's Meta tier (unique recipients per rolling 24 h): the tier
 * minus slots in use, minus sends waiting for a slot, minus this workspace's campaign messages still on their way to Meta. A campaign's
 * `daily_send_limit` narrows it further. `until` is when to look again when `room` is 0.
 */
export function capacity(host: LinkHost, c: Pick<Row, 'id' | 'phone_number_id' | 'daily_send_limit'>, now: number): Capacity {
  const since = now - TIER_WINDOW_MS;
  const tier = host.sql.exec<{ tier: number }>('SELECT tier FROM number_limits WHERE phone_number_id = ?', c.phone_number_id).toArray()[0]?.tier ?? DEFAULT_TIER;
  const slots = host.sql.exec<{ n: number; first: number | null }>('SELECT count(*) AS n, min(started_at) AS first FROM tier_slots WHERE phone_number_id = ? AND started_at > ?', c.phone_number_id, since).one();
  const waiting = host.sql.exec<{ n: number }>("SELECT count(*) AS n FROM scheduled_tasks WHERE kind = 'send_release' AND json_extract(payload, '$.reason') = 'tier' AND json_extract(payload, '$.job.phoneNumberId') = ?", c.phone_number_id).one().n;
  const pending = host.sql.exec<{ n: number }>("SELECT count(*) AS n FROM messages WHERE status IN ('queued', 'claimed', 'retry') AND direction = 'out' AND idempotency_key LIKE 'camp:%'").one().n;
  // Messages of a manually paused campaign are parked, not on their way: they must not shrink another campaign's room.
  const parked = host.sql.exec<{ n: number }>("SELECT count(*) AS n FROM scheduled_tasks WHERE kind = 'send_release' AND json_extract(payload, '$.reason') = ?", PARKED).one().n;
  let room = tier - slots.n - waiting - Math.max(0, pending - parked);
  let until = slots.n >= tier && slots.first !== null ? slots.first + TIER_WINDOW_MS + 1000 : now + 30_000;
  if (c.daily_send_limit !== null) {
    const today = host.sql.exec<{ n: number; first: number | null }>('SELECT count(*) AS n, min(at) AS first FROM campaign_recipients WHERE campaign_id = ? AND at > ?', c.id, since).one();
    const left = c.daily_send_limit - today.n;
    if (left < room) {
      room = left;
      if (left <= 0 && today.first !== null) until = today.first + TIER_WINDOW_MS + 1000;
    }
  }
  return { room: Math.max(0, room), until: Math.max(until, now + 1000) };
}

// ---- The workflow's steps -------------------------------------------------------------------------------------------

export type StartResult = { state: 'go'; scheduledAt: number | null; nextPage: number } | { state: 'stop'; reason: string };
/** `retry`: something outside our control (the wallet) did not answer; nothing was changed and asking again is safe. */
export type PageResult = { state: 'next'; count: number } | { state: 'done'; count: number } | { state: 'wait'; until: number } | { state: 'stop'; reason: string } | { state: 'retry'; reason: string };
const stop = (reason: string): { state: 'stop'; reason: string } => ({ state: 'stop', reason });

/** First step of a workflow instance: is it still the live one, and is the campaign in a state worth running? */
export function campaignStart(host: LinkHost, id: string, attempt: number): StartResult {
  const c = read(host, id);
  if (!c) return stop('not_found');
  if (c.attempt !== attempt) return stop('superseded');
  if (c.status === 'running' || c.status === 'scheduled') return { state: 'go', scheduledAt: c.status === 'scheduled' ? c.scheduled_at : null, nextPage: c.next_page };
  return stop(c.status);
}

/** After the scheduled time: scheduled -> running (once). Anything but a live scheduled or running campaign stops the instance. */
export function campaignActivate(host: LinkHost, id: string, attempt: number, now: number): { state: 'go' } | { state: 'stop'; reason: string } {
  const c = read(host, id);
  if (!c) return stop('not_found');
  if (c.attempt !== attempt) return stop('superseded');
  if (c.status === 'scheduled') host.sql.exec("UPDATE campaigns SET status = 'running', started_at = coalesce(started_at, ?), updated_at = ? WHERE id = ?", now, now, id);
  else if (c.status !== 'running') return stop(c.status);
  return { state: 'go' };
}

const storedPage = (host: LinkHost, id: string, page: number): PageResult | null => {
  const r = host.sql.exec<{ count: number; done: number }>('SELECT count, done FROM campaign_pages WHERE campaign_id = ? AND page = ?', id, page).toArray()[0];
  return r ? { state: r.done ? 'done' : 'next', count: r.count } : null;
};

/**
 * Queues the next page of the audience, once. A step that runs again after it succeeded (or died half way) finds its page already
 * stored and returns the same answer; the reservation ref and every message key are derived from (campaign, page, contact), so
 * nothing is reserved or enqueued twice. Pages are strictly in order: `page` must be the campaign's next one.
 */
export async function campaignPage(host: LinkHost, id: string, attempt: number, page: number, now: number, pageSize = PAGE_SIZE): Promise<PageResult> {
  const stored = storedPage(host, id, page);
  if (stored) return stored;
  const c = read(host, id);
  if (!c) return stop('not_found');
  if (c.attempt !== attempt) return stop('superseded');
  if (c.status !== 'running') return stop(c.status);
  if (c.next_page !== page) return stop('out_of_order');
  const t = templateOf(host, c.template_name, c.template_language);
  if (!t || t.status !== 'APPROVED') {
    host.sql.exec("UPDATE campaigns SET status = 'paused', pause_reason = 'template_unavailable', updated_at = ? WHERE id = ?", now, id);
    return stop('template_unavailable');
  }
  const cap = capacity(host, c, now);
  if (cap.room <= 0) return { state: 'wait', until: cap.until };
  const limit = Math.min(pageSize, cap.room);
  const criteria = segmentCriteria.parse(JSON.parse(c.criteria));
  const rows = audiencePage(host, criteria, c.cursor, limit);
  const ref = pageRef(id, page);
  const wallet = campaignWallet();
  let reservedMinor = 0;
  if (rows.length) {
    let res: Awaited<ReturnType<typeof wallet.walletReserve>>;
    try {
      reservedMinor = (await wallet.walletEstimate(host.workspaceId, c.category)) * rows.length;
      res = await wallet.walletReserve(host.workspaceId, ref, reservedMinor);
    } catch (err) {
      console.error(JSON.stringify({ alert: 'campaign_wallet_unavailable', workspace: host.workspaceId, error: errClass(err) }));
      return { state: 'retry', reason: 'wallet_unavailable' };
    }
    if (!res.ok) {
      host.sql.exec("UPDATE campaigns SET status = 'paused', pause_reason = 'wallet_empty', updated_at = ? WHERE id = ? AND status = 'running' AND attempt = ?", now, id, attempt);
      return stop('wallet_empty');
    }
    // The reservation was an await: another call for this very page may have queued it meanwhile (then its answer is ours, and the
    // reservation, which has the same ref, is theirs to keep), or the merchant may have paused or cancelled (then give it back).
    const raced = storedPage(host, id, page);
    if (raced) return raced;
    const after = read(host, id);
    if (!after || after.attempt !== attempt || after.status !== 'running' || after.next_page !== page) {
      await wallet.walletSettle(host.workspaceId, ref, { recipients: 0, ended: 'abandoned' });
      return stop(after && after.attempt === attempt ? after.status : 'superseded');
    }
  }
  const specs = JSON.parse(c.params) as CampaignParam[];
  const exhausted = rows.length < limit;
  const result = host.storage.transactionSync((): PageResult => {
    let queued = 0;
    for (const r of rows) {
      const idem = recipientKey(id, r.id);
      const q = queueTemplate(host, {
        waId: r.waId, phoneNumberId: c.phone_number_id, name: c.template_name, language: c.template_language, params: resolveParams(specs, r.name),
        idempotencyKey: idem, requireConsent: true, profileName: r.name, now,
      });
      const skipped = !q.ok;
      host.sql.exec(
        'INSERT OR IGNORE INTO campaign_recipients (campaign_id, contact_id, page, idem, state, skip_reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        id, r.id, page, idem, skipped ? 'skipped' : 'queued', skipped ? (q.reason === 'invalid_request' ? 'invalid_params' : q.reason) : null, now,
      );
      if (!skipped) queued++;
    }
    const last = rows.length ? rows[rows.length - 1]!.id : c.cursor;
    host.sql.exec('INSERT INTO campaign_pages (campaign_id, page, from_id, to_id, count, done, reserve_ref, reserved_minor, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, page, c.cursor, last, queued, exhausted ? 1 : 0, ref, reservedMinor, now);
    host.sql.exec(
      `UPDATE campaigns SET cursor = ?, next_page = ?, updated_at = ?${exhausted ? ", status = 'completed', finished_at = ?" : ''} WHERE id = ?`,
      ...(exhausted ? [last, page + 1, now, now, id] : [last, page + 1, now, id]),
    );
    return exhausted ? { state: 'done', count: queued } : { state: 'next', count: queued };
  });
  await host.arm();
  if (result.state === 'done') {
    // The page is queued and final; a wallet that cannot be told now is told by the sweep. Failing here would only make the step ask again.
    await settleWallet(host, id).catch((err) => console.error(JSON.stringify({ alert: 'campaign_wallet_settle_failed', workspace: host.workspaceId, error: errClass(err) })));
  }
  return result;
}

/** Tells the wallet which page reservations are finished with. Idempotent per page; a failure is retried by the sweep. */
export async function settleWallet(host: LinkHost, id: string): Promise<void> {
  const c = read(host, id);
  if (!c || (c.status !== 'completed' && c.status !== 'cancelled')) return;
  const ended = c.status === 'completed' ? 'completed' : 'cancelled';
  const pages = host.sql.exec<{ page: number; count: number; reserve_ref: string }>('SELECT page, count, reserve_ref FROM campaign_pages WHERE campaign_id = ? AND settled = 0 ORDER BY page', id).toArray();
  for (const p of pages) {
    await campaignWallet().walletSettle(host.workspaceId, p.reserve_ref, { recipients: p.count, ended });
    host.sql.exec('UPDATE campaign_pages SET settled = 1 WHERE campaign_id = ? AND page = ?', id, p.page);
  }
}

// ---- Starting workflows and the safety sweep -----------------------------------------------------------------------

/** Starts a fresh workflow instance for the campaign (a new generation, which retires any older one). Never throws: the sweep retries a failed start. */
export async function launchCampaign(host: LinkHost, id: string, now: number): Promise<void> {
  const row = host.sql.exec<{ attempt: number }>("UPDATE campaigns SET attempt = attempt + 1 WHERE id = ? AND status IN ('scheduled', 'running') RETURNING attempt", id).toArray()[0];
  if (!row) return;
  addTask(host.sql, 'campaign_step', now + SWEEP_MS);
  await host.arm();
  try {
    await host.env.CAMPAIGN_WORKFLOW.create({ id: `${id}-${row.attempt}`, params: { workspaceId: host.workspaceId, campaignId: id, attempt: row.attempt } });
  } catch (err) {
    console.error(JSON.stringify({ alert: 'campaign_launch_failed', workspace: host.workspaceId, attempt: row.attempt, error: errClass(err) }));
  }
}

/** Best effort: frees the instance of a campaign that was paused or cancelled (it would also stop itself at its next step). */
export async function endInstance(host: LinkHost, id: string, attempt: number): Promise<void> {
  try {
    await (await host.env.CAMPAIGN_WORKFLOW.get(`${id}-${attempt}`)).terminate();
  } catch {
    // already finished, never created, or the binding is absent: nothing to stop
  }
}

/**
 * Every SWEEP_MS while a campaign is active: restart a campaign whose workflow is gone, errored or finished early (a deploy, a lost
 * create call, the step budget), pause one that keeps dying, and finish wallet settlements that failed. Replaces the old product's
 * polling stuck-campaign reconcile; it only runs while there is something to watch.
 */
export async function sweepCampaigns(host: LinkHost, now: number): Promise<number | undefined> {
  const active = host.sql.exec<{ id: string; attempt: number }>("SELECT id, attempt FROM campaigns WHERE status IN ('scheduled', 'running')").toArray();
  for (const c of active) {
    let alive = false;
    if (c.attempt > 0) {
      try {
        const st = await (await host.env.CAMPAIGN_WORKFLOW.get(`${c.id}-${c.attempt}`)).status();
        alive = !['errored', 'terminated', 'complete'].includes(st.status);
      } catch {
        alive = false;
      }
    }
    if (alive) continue;
    if (c.attempt >= MAX_ATTEMPTS) {
      host.sql.exec("UPDATE campaigns SET status = 'paused', pause_reason = 'internal_error', updated_at = ? WHERE id = ? AND status IN ('scheduled', 'running')", now, c.id);
      console.error(JSON.stringify({ alert: 'campaign_paused_internal_error', workspace: host.workspaceId, campaign: c.id }));
    } else {
      await launchCampaign(host, c.id, now);
    }
  }
  for (const c of host.sql.exec<{ id: string }>("SELECT DISTINCT campaign_id AS id FROM campaign_pages p JOIN campaigns c ON c.id = p.campaign_id WHERE p.settled = 0 AND c.status IN ('completed', 'cancelled')").toArray()) {
    try {
      await settleWallet(host, c.id);
    } catch (err) {
      console.error(JSON.stringify({ alert: 'campaign_wallet_settle_failed', workspace: host.workspaceId, error: errClass(err) }));
    }
  }
  const stillActive = host.sql.exec<{ n: number }>("SELECT count(*) AS n FROM campaigns WHERE status IN ('scheduled', 'running')").one().n;
  const unsettled = host.sql.exec<{ n: number }>("SELECT count(*) AS n FROM campaign_pages p JOIN campaigns c ON c.id = p.campaign_id WHERE p.settled = 0 AND c.status IN ('completed', 'cancelled')").one().n;
  return stillActive || unsettled ? now + SWEEP_MS : undefined;
}
