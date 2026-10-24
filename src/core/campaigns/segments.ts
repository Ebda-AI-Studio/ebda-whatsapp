import { segmentCriteria, type SegmentCriteria, type SegmentDto, type SegmentPreviewDto } from '../api/contract';
import type { LinkHost } from '../store-link/host';

/** An order that does not count as "has ordered". The Store's status is free text; these are the ones that mean nothing was bought. */
const NOT_AN_ORDER = ["'cancelled'", "'canceled'", "'refunded'", "'refused'", "'failed'"].join(', ');

type Where = { sql: string; params: SqlStorageValue[] };

/** One tag test over both tag sources. Contact tags are stored lower-cased; the inbox's conversation tags are compared lower-cased. */
function hasTag(tag: string): Where {
  const t = tag.toLowerCase();
  return {
    sql: '(EXISTS (SELECT 1 FROM contact_tags t WHERE t.contact_id = c.id AND t.tag = ?) OR EXISTS (SELECT 1 FROM conversation_tags t JOIN conversations cv ON cv.id = t.conversation_id WHERE cv.contact_id = c.id AND lower(t.tag) = ?))',
    params: [t, t],
  };
}

/** The filter part of a segment, without the opt-out / consent guard (the guard is added by `audienceWhere`, never by the caller). */
export function criteriaWhere(criteria: SegmentCriteria): Where {
  const parts: string[] = [];
  const params: SqlStorageValue[] = [];
  const add = (w: Where) => { parts.push(w.sql); params.push(...w.params); };
  const any = criteria.tags?.any ?? [];
  if (any.length) {
    const ws = any.map(hasTag);
    parts.push(`(${ws.map((w) => w.sql).join(' OR ')})`);
    for (const w of ws) params.push(...w.params);
  }
  for (const tag of criteria.tags?.all ?? []) add(hasTag(tag));
  if (criteria.lastInboundAfter !== undefined) { parts.push('c.last_inbound_at > ?'); params.push(Math.floor(criteria.lastInboundAfter / 1000)); }
  if (criteria.lastInboundBefore !== undefined) { parts.push('c.last_inbound_at < ?'); params.push(Math.floor(criteria.lastInboundBefore / 1000)); }
  if (criteria.hasOrdered !== undefined) {
    parts.push(`${criteria.hasOrdered ? '' : 'NOT '}EXISTS (SELECT 1 FROM store_orders o WHERE o.wa_id = c.wa_id AND lower(coalesce(o.status, '')) NOT IN (${NOT_AN_ORDER}))`);
  }
  return { sql: parts.length ? parts.join(' AND ') : '1 = 1', params };
}

/**
 * Who may receive a campaign: the segment's filter AND not opted out AND a consent on record. The two guards are not part of the criteria
 * and cannot be switched off. The latest STOP wins because `opted_out_at` is set by the newest STOP and only a START clears it.
 */
export function audienceWhere(criteria: SegmentCriteria): Where {
  const f = criteriaWhere(criteria);
  return { sql: `c.opted_out_at IS NULL AND c.consent_at IS NOT NULL AND ${f.sql}`, params: f.params };
}

export type AudienceRow = { id: number; waId: string; name: string | null };

/** The next `limit` people after contact id `afterId`, by id. Re-evaluated on every call, so an opt-out between pages takes effect. */
export function audiencePage(host: LinkHost, criteria: SegmentCriteria, afterId: number, limit: number): AudienceRow[] {
  const w = audienceWhere(criteria);
  return host.sql.exec<{ id: number; wa_id: string; profile_name: string | null }>(
    `SELECT c.id, c.wa_id, c.profile_name FROM contacts c WHERE c.id > ? AND ${w.sql} ORDER BY c.id LIMIT ?`, afterId, ...w.params, limit,
  ).toArray().map((r) => ({ id: r.id, waId: r.wa_id, name: r.profile_name }));
}

export function previewAudience(host: LinkHost, criteria: SegmentCriteria): SegmentPreviewDto {
  const f = criteriaWhere(criteria);
  const one = (extra: string) => host.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM contacts c WHERE ${extra} AND ${f.sql}`, ...f.params).one().n;
  return {
    count: one('c.opted_out_at IS NULL AND c.consent_at IS NOT NULL'),
    excluded: { optedOut: one('c.opted_out_at IS NOT NULL'), noConsent: one('c.opted_out_at IS NULL AND c.consent_at IS NULL') },
  };
}

type SegmentRow = { id: number; name: string; criteria: string; created_at: number; updated_at: number };
const dto = (r: SegmentRow): SegmentDto => ({ id: r.id, name: r.name, criteria: segmentCriteria.parse(JSON.parse(r.criteria)), createdAt: r.created_at, updatedAt: r.updated_at });
const COLS = 'id, name, criteria, created_at, updated_at';

export function listSegments(host: LinkHost): SegmentDto[] {
  return host.sql.exec<SegmentRow>(`SELECT ${COLS} FROM segments ORDER BY name`).toArray().map(dto);
}

export function getSegment(host: LinkHost, id: number): SegmentDto | null {
  const r = host.sql.exec<SegmentRow>(`SELECT ${COLS} FROM segments WHERE id = ?`, id).toArray()[0];
  return r ? dto(r) : null;
}

export function createSegment(host: LinkHost, a: { name: string; criteria: SegmentCriteria; actor: string; now: number }): { ok: true; segment: SegmentDto } | { ok: false; reason: 'name_taken' } {
  if (host.sql.exec('SELECT 1 FROM segments WHERE name = ?', a.name).toArray().length) return { ok: false, reason: 'name_taken' };
  const r = host.sql.exec<SegmentRow>(`INSERT INTO segments (name, criteria, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING ${COLS}`, a.name, JSON.stringify(a.criteria), a.actor, a.now, a.now).one();
  return { ok: true, segment: dto(r) };
}

export function updateSegment(host: LinkHost, id: number, patch: { name?: string; criteria?: SegmentCriteria }, now: number): { ok: true; segment: SegmentDto } | { ok: false; reason: 'not_found' | 'name_taken' } {
  const have = getSegment(host, id);
  if (!have) return { ok: false, reason: 'not_found' };
  if (patch.name !== undefined && host.sql.exec('SELECT 1 FROM segments WHERE name = ? AND id <> ?', patch.name, id).toArray().length) return { ok: false, reason: 'name_taken' };
  const r = host.sql.exec<SegmentRow>(`UPDATE segments SET name = ?, criteria = ?, updated_at = ? WHERE id = ? RETURNING ${COLS}`, patch.name ?? have.name, JSON.stringify(patch.criteria ?? have.criteria), now, id).one();
  return { ok: true, segment: dto(r) };
}

export function deleteSegment(host: LinkHost, id: number): boolean {
  return host.sql.exec('DELETE FROM segments WHERE id = ?', id).rowsWritten > 0;
}
