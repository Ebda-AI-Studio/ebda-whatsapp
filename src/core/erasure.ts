import type { Env } from '../env';
import { ERASURE_TARGETS, stateKeysFor, type ErasureTarget } from './erasure-targets';
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

/**
 * Step 1 (BEFORE the Durable Object deletes): stamps the request. `completed_at` is cleared, so a backup taken from now until the erase finishes is dropped
 * for this person. Returns the hash, or null when it could not be written (never throws: an erasure is a right and must go ahead).
 */
export async function recordErasure(env: Env, a: { workspaceId: string; waId: string; actor: string }, now = Date.now()): Promise<string | null> {
  try {
    const h = await subjectHash(env, a.workspaceId, a.waId);
    if (!h) throw new Error('no_key');
    await env.DB.prepare(
      'INSERT INTO erasure_records (workspace_id, subject_hash, erased_at, completed_at, erased_by) VALUES (?, ?, ?, NULL, ?) ON CONFLICT(workspace_id, subject_hash) DO UPDATE SET erased_at = excluded.erased_at, completed_at = NULL, erased_by = excluded.erased_by',
    ).bind(a.workspaceId, h, now, a.actor).run();
    return h;
  } catch {
    alert('erasure_record_failed', { workspace: a.workspaceId });
    return null;
  }
}

/** Step 2 (AFTER `eraseContact` returned): `completedAt` is the Durable Object's own clock at the end of the delete. Never throws. */
export async function completeErasure(env: Env, a: { workspaceId: string; waId: string; completedAt: number }): Promise<void> {
  try {
    const h = await subjectHash(env, a.workspaceId, a.waId);
    if (!h) throw new Error('no_key');
    await env.DB.prepare('UPDATE erasure_records SET completed_at = ? WHERE workspace_id = ? AND subject_hash = ?').bind(a.completedAt, a.workspaceId, h).run();
  } catch {
    alert('erasure_record_failed', { workspace: a.workspaceId });
  }
}

/** hash -> the time the Durable Object finished erasing them (null = it never reported finishing). */
export async function erasedSubjects(env: Env, workspaceId: string): Promise<Map<string, number | null>> {
  const { results } = await env.DB.prepare('SELECT subject_hash, completed_at FROM erasure_records WHERE workspace_id = ?').bind(workspaceId).all<{ subject_hash: string; completed_at: number | null }>();
  return new Map(results.map((r) => [r.subject_hash, r.completed_at]));
}

type Rows = Record<string, unknown>[];
export type BackupFile = { t: string; rows: Rows };

/**
 * Removes from a verified backup everyone who has an erasure record, EXCEPT a person whose first message in the backup came AFTER the erase finished (a genuine new
 * relationship). No wall-clock comparison with the backup's own time: a backup taken between the stamp and the end of the erase holds old messages, so it drops them.
 * An erase that never reported finishing is dropped always. What counts as "the person" is the shared list (erasure-targets.ts), the same one `eraseContact` deletes by.
 * Returns how many people were dropped. Throws when records exist but cannot be applied (no key): a restore must not guess.
 */
export async function dropErased(env: Env, workspaceId: string, files: BackupFile[]): Promise<number> {
  const erased = await erasedSubjects(env, workspaceId);
  if (!erased.size) return 0;
  const get = (t: string) => files.find((f) => f.t === t);
  const rowsOf = (t: string): Rows => get(t)?.rows ?? [];
  const firstMessage = new Map<number, number>(); // conversation id -> its oldest message time
  for (const m of rowsOf('messages')) {
    const cid = m.conversation_id as number;
    const at = m.created_at as number;
    if (!firstMessage.has(cid) || at < firstMessage.get(cid)!) firstMessage.set(cid, at);
  }
  const convOfContact = new Map<number, number>();
  for (const c of rowsOf('conversations')) convOfContact.set(c.contact_id as number, c.id as number);

  const drop = new Set<string>();
  const contactIds = new Set<number>();
  for (const c of rowsOf('contacts')) {
    const h = await subjectHash(env, workspaceId, String(c.wa_id));
    if (!h) throw new Error('erasure records exist but cannot be applied (no key)');
    if (!erased.has(h)) continue;
    const completedAt = erased.get(h)!;
    const first = firstMessage.get(convOfContact.get(c.id as number) ?? -1);
    if (completedAt !== null && first !== undefined && first > completedAt) continue; // wrote again after the erase finished
    drop.add(String(c.wa_id));
    contactIds.add(c.id as number);
  }
  if (!drop.size) return 0;

  const convIds = new Set<number>();
  for (const c of rowsOf('conversations')) if (contactIds.has(c.contact_id as number)) convIds.add(c.id as number);
  const wamids = new Set<string>();
  const r2Keys = new Set<string>();
  for (const m of rowsOf('messages')) {
    if (!convIds.has(m.conversation_id as number)) continue;
    if (m.wamid) wamids.add(String(m.wamid));
    for (const k of [m.body_r2_key, m.media_r2_key]) if (k) r2Keys.add(String(k));
  }
  const stateKeys = new Set([...drop].flatMap(stateKeysFor));
  const matches = (by: ErasureTarget['by'], r: Record<string, unknown>): boolean => {
    switch (by) {
      case 'wa_id': return drop.has(String(r.wa_id));
      case 'contact_id': return contactIds.has(r.contact_id as number);
      case 'conversation_id': return convIds.has(r.conversation_id as number);
      case 'wamid': return wamids.has(String(r.wamid));
      case 'store_state_key': return stateKeys.has(String(r.key));
    }
  };
  for (const t of ERASURE_TARGETS) {
    const f = get(t.table);
    if (f) f.rows = f.rows.filter((r) => !matches(t.by, r));
  }
  const uploads = get('uploads');
  if (uploads) uploads.rows = uploads.rows.filter((r) => !r2Keys.has(String(r.r2_key)));
  return drop.size;
}
