import type { Env } from '../env';
import { alert } from './observability';

/**
 * The erasure record (B3). `eraseContact` removes a person's rows; this remembers THAT they were erased, so a restore from an older backup
 * (which still holds them) drops them again. The subject is a keyed hash bound to the workspace, so the table is not a list of phone numbers.
 */
const HEX = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

/** 128-bit HMAC-SHA-256 under a key derived (HKDF) from TOKEN_ENC_KEY with its own label. Null = no key: the caller fails closed or alerts. */
export async function subjectHash(env: Pick<Env, 'TOKEN_ENC_KEY'>, workspaceId: string, waId: string): Promise<string | null> {
  const secret = env.TOKEN_ENC_KEY;
  if (!secret) return null;
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('erasure-subject/v1') }, base, 256);
  const key = await crypto.subtle.importKey('raw', bits, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return HEX(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${workspaceId}:${waId}`))).slice(0, 16));
}

/** Writes (or refreshes) the record. Returns the hash, or null when it could not be written (never throws: an erasure is a right and must go ahead). */
export async function recordErasure(env: Env, a: { workspaceId: string; waId: string; actor: string }, now = Date.now()): Promise<string | null> {
  try {
    const h = await subjectHash(env, a.workspaceId, a.waId);
    if (!h) throw new Error('no_key');
    await env.DB.prepare(
      'INSERT INTO erasure_records (workspace_id, subject_hash, erased_at, erased_by) VALUES (?, ?, ?, ?) ON CONFLICT(workspace_id, subject_hash) DO UPDATE SET erased_at = excluded.erased_at, erased_by = excluded.erased_by',
    ).bind(a.workspaceId, h, now, a.actor).run();
    return h;
  } catch {
    alert('erasure_record_failed', { workspace: a.workspaceId });
    return null;
  }
}

/** hash -> when it was erased, for one workspace. */
export async function erasedSubjects(env: Env, workspaceId: string): Promise<Map<string, number>> {
  const { results } = await env.DB.prepare('SELECT subject_hash, erased_at FROM erasure_records WHERE workspace_id = ?').bind(workspaceId).all<{ subject_hash: string; erased_at: number }>();
  return new Map(results.map((r) => [r.subject_hash, r.erased_at]));
}

type Rows = Record<string, unknown>[];
export type BackupFile = { t: string; rows: Rows };

/**
 * Removes from a verified backup everyone erased AFTER it was taken (erased_at >= takenAt): the contact, their conversation, messages, status events,
 * notes, tags, orders, campaign rows and the uploads of their messages. Someone erased BEFORE the backup who wrote again is in it as a new
 * relationship and stays. Returns how many people were dropped. Throws when records exist but cannot be applied (no key): a restore must not guess.
 */
export async function dropErased(env: Env, workspaceId: string, takenAt: number, files: BackupFile[]): Promise<number> {
  const erased = await erasedSubjects(env, workspaceId);
  if (!erased.size) return 0;
  const get = (t: string) => files.find((f) => f.t === t)!;
  const drop = new Set<string>();
  const contactIds = new Set<number>();
  for (const c of get('contacts').rows) {
    const h = await subjectHash(env, workspaceId, String(c.wa_id));
    if (!h) throw new Error('erasure records exist but cannot be applied (no key)');
    const at = erased.get(h);
    if (at !== undefined && at >= takenAt) { drop.add(String(c.wa_id)); contactIds.add(c.id as number); }
  }
  if (!drop.size) return 0;
  const convIds = new Set<number>();
  const wamids = new Set<string>();
  const r2Keys = new Set<string>();
  const keep = (t: string, pred: (r: Record<string, unknown>) => boolean) => { const f = get(t); f.rows = f.rows.filter((r) => !pred(r)); };
  for (const c of get('conversations').rows) if (contactIds.has(c.contact_id as number)) convIds.add(c.id as number);
  for (const m of get('messages').rows) {
    if (!convIds.has(m.conversation_id as number)) continue;
    if (m.wamid) wamids.add(String(m.wamid));
    for (const k of [m.body_r2_key, m.media_r2_key]) if (k) r2Keys.add(String(k));
  }
  keep('contacts', (r) => drop.has(String(r.wa_id)));
  keep('conversations', (r) => convIds.has(r.id as number));
  keep('messages', (r) => convIds.has(r.conversation_id as number));
  keep('message_status_events', (r) => wamids.has(String(r.wamid)));
  keep('notes', (r) => convIds.has(r.conversation_id as number));
  keep('conversation_tags', (r) => convIds.has(r.conversation_id as number));
  keep('contact_tags', (r) => contactIds.has(r.contact_id as number));
  keep('store_orders', (r) => drop.has(String(r.wa_id)));
  keep('campaign_recipients', (r) => contactIds.has(r.contact_id as number));
  keep('campaign_links', (r) => contactIds.has(r.contact_id as number));
  keep('uploads', (r) => r2Keys.has(String(r.r2_key)));
  return drop.size;
}
