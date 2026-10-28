/**
 * Meta's data-deletion callback (B9, LEGAL-DELETE-1 second form). Meta POSTs `signed_request=<signature>.<payload>` (base64url, the signature is HMAC-SHA256 of the payload STRING with the
 * app secret) when a person removes the app. We verify it, record the request, answer `{ url, confirmation_code }` (Meta's spec) and erase THE PERSON'S OWN data.
 *
 * What "erase" covers: the mapping of that person to the WABAs they connected (`waba_signup_users`, a keyed hash recorded SERVER-side at Embedded Signup from the exchanged token, never
 * from the browser). It does NOT disconnect any number: an agency's staff member or an ex-employee removing the app must not take a merchant's live numbers offline. Each affected
 * workspace is FLAGGED instead (an owner-visible notice in `workspace_notices` and the P1 alert `meta_user_removed_app`); the owner, or an operator with a reason, confirms any
 * disconnect. A merchant's CUSTOMER data belongs to the merchant's workspace and has its own erasure path (`DELETE /contacts/:waId`, workspace deletion).
 *
 * The queue is durable: the request row is the task (`queued`, with `attempts`). The route runs it at once (`waitUntil`), and the daily sweep (`sweepDeletionRequests`) retries every row still
 * `queued`, up to MAX_ATTEMPTS, then marks it `failed` and raises `meta_deletion_needs_review`. A request must carry a fresh `issued_at` (at most 5 minutes old) and no login-only field, and is
 * deduplicated per (user id, issued_at): a replay gets the same code and runs nothing. A request we cannot match is NOT reported as done: it waits for a person (state `nothing_found`, status
 * `needs_review`, P1 alert). NOT VERIFIED against Meta's live callback.
 */
import { z } from 'zod';
import type { Env } from '../../env';
import { alert, errClass } from '../observability';
import { metaUserHash } from './signup-users';

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const hmacKey = (secret: string, usage: 'sign' | 'verify') => crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

const payloadSchema = z.object({ algorithm: z.literal('HMAC-SHA256'), user_id: z.string().regex(/^[0-9]{1,40}$/), issued_at: z.number().int().positive() });
/** Fields a LOGIN / OAuth signed_request carries and a deletion request never does: a blob that has one was not issued for deletion. */
const LOGIN_ONLY_FIELDS = ['code', 'oauth_token', 'access_token', 'expires', 'expires_in'];
/** A deletion request is acted on only if Meta issued it this recently (replay window); a small skew into the future is tolerated. */
export const MAX_AGE_S = 300;
export const MAX_FUTURE_S = 60;

/** The payload of a genuine signed request, or null for anything else (wrong signature, algorithm, shape). */
export async function parseSignedRequest(raw: string, appSecret: string | undefined, nowS = Math.floor(Date.now() / 1000)): Promise<{ userId: string; issuedAt: number } | null> {
  if (!appSecret) return null;
  const [sig, payload, extra] = raw.split('.');
  if (!sig || !payload || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(appSecret, 'verify'), b64urlToBytes(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const json = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as Record<string, unknown>;
    if (LOGIN_ONLY_FIELDS.some((f) => f in json)) return null;
    const p = payloadSchema.safeParse(json);
    if (!p.success || nowS - p.data.issued_at > MAX_AGE_S || p.data.issued_at - nowS > MAX_FUTURE_S) return null;
    return { userId: p.data.user_id, issuedAt: p.data.issued_at };
  } catch {
    return null;
  }
}

export type DeletionState = 'queued' | 'done' | 'nothing_found' | 'failed';
/** What the status page and the JSON say. Never a user id. */
export const statusOf = (s: DeletionState): 'received' | 'done' | 'needs_review' => (s === 'queued' ? 'received' : s === 'done' ? 'done' : 'needs_review');

/** A retry of the SAME signed request finds its row; `code` is derived from the payload with the app secret. Null when the hash key is not configured (the route answers 503 and Meta retries). */
export async function recordRequest(env: Env, r: { userId: string; issuedAt: number }, now: number): Promise<{ code: string; created: boolean } | null> {
  const userHash = await metaUserHash(env, r.userId);
  if (!userHash) return null;
  const code = hex(await crypto.subtle.sign('HMAC', await hmacKey(env.META_APP_SECRET!, 'sign'), new TextEncoder().encode(`deletion-code:${r.userId}:${r.issuedAt}`))).slice(0, 32);
  const res = await env.DB.prepare("INSERT OR IGNORE INTO meta_deletion_requests (code, user_hash, received_at, state) VALUES (?, ?, ?, 'queued')").bind(code, userHash, now).run();
  return { code, created: res.meta.changes > 0 };
}

/** Attempts a request gets (the inline one included) before it is `failed` and a person is asked. */
export const MAX_ATTEMPTS = 5;
/** A `queued` row younger than this is left to the run that just started it. */
const RETRY_AFTER_MS = 120_000;

/**
 * Runs one queued request: erases the person's mappings, flags every workspace they touched and records the outcome in ONE D1 batch (a crash leaves the row `queued`, and a re-run is
 * idempotent). A claim on the attempt counter keeps the inline run and the sweep from both running it. Never throws.
 */
export async function processRequest(env: Env, code: string, now = Date.now()): Promise<void> {
  try {
    const row = await env.DB.prepare('SELECT user_hash, state, attempts FROM meta_deletion_requests WHERE code = ?').bind(code).first<{ user_hash: string; state: DeletionState; attempts: number }>();
    if (!row || row.state !== 'queued') return;
    const claim = await env.DB.prepare("UPDATE meta_deletion_requests SET attempts = attempts + 1, last_attempt_at = ? WHERE code = ? AND state = 'queued' AND attempts = ?").bind(now, code, row.attempts).run();
    if (!claim.meta.changes) return; // another run took this attempt
    try {
      const maps = (await env.DB.prepare('SELECT workspace_id, waba_id FROM waba_signup_users WHERE user_hash = ?').bind(row.user_hash).all<{ workspace_id: string; waba_id: string }>()).results;
      const flagged: string[] = [];
      const stmts = [];
      for (const m of maps) {
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO workspace_notices (workspace_id, kind, ref, created_at) VALUES (?, 'meta_user_removed_app', ?, ?)").bind(m.workspace_id, m.waba_id, now));
        flagged.push(m.workspace_id);
      }
      stmts.push(env.DB.prepare('DELETE FROM waba_signup_users WHERE user_hash = ?').bind(row.user_hash));
      const state: DeletionState = maps.length > 0 ? 'done' : 'nothing_found';
      stmts.push(env.DB.prepare('UPDATE meta_deletion_requests SET state = ?, removed_connections = ?, finished_at = ? WHERE code = ?').bind(state, maps.length, now, code));
      const out = await env.DB.batch(stmts);
      console.log(JSON.stringify({ audit: 'meta_deletion', state, flagged: new Set(flagged).size }));
      // One P1 per notice that was actually new (a second request about the same WABA does not page again).
      maps.forEach((m, i) => { if ((out[i]?.meta.changes ?? 0) > 0) alert('meta_user_removed_app', { workspace: m.workspace_id, waba: m.waba_id }); });
      if (state === 'nothing_found') alert('meta_deletion_needs_review', { reason: 'no_matching_connection' });
    } catch (err) {
      const last = row.attempts + 1 >= MAX_ATTEMPTS;
      if (last) await env.DB.prepare("UPDATE meta_deletion_requests SET state = 'failed', finished_at = ? WHERE code = ?").bind(now, code).run().catch(() => undefined);
      if (last) alert('meta_deletion_needs_review', { reason: 'failed', error: errClass(err) });
    }
  } catch (err) {
    alert('meta_deletion_needs_review', { reason: 'failed', error: errClass(err) });
  }
}

/**
 * The daily sweep: rows still `queued` after the inline run are run again (up to MAX_ATTEMPTS); a row that used up its attempts without finishing becomes `failed` and raises
 * `meta_deletion_needs_review` ONCE (reason `stuck`). Bounded per pass.
 */
export async function sweepDeletionRequests(env: Env, now = Date.now()): Promise<{ retried: number; stuck: number }> {
  const stuck = (await env.DB.prepare("SELECT code FROM meta_deletion_requests WHERE state = 'queued' AND attempts >= ? AND coalesce(last_attempt_at, received_at) < ? LIMIT 50").bind(MAX_ATTEMPTS, now - RETRY_AFTER_MS).all<{ code: string }>()).results;
  for (const r of stuck) {
    const u = await env.DB.prepare("UPDATE meta_deletion_requests SET state = 'failed', finished_at = ? WHERE code = ? AND state = 'queued'").bind(now, r.code).run();
    if (u.meta.changes) alert('meta_deletion_needs_review', { reason: 'stuck' });
  }
  const due = (await env.DB.prepare("SELECT code FROM meta_deletion_requests WHERE state = 'queued' AND attempts < ? AND coalesce(last_attempt_at, received_at) < ? ORDER BY received_at LIMIT 20").bind(MAX_ATTEMPTS, now - RETRY_AFTER_MS).all<{ code: string }>()).results;
  for (const r of due) await processRequest(env, r.code, now);
  return { retried: due.length, stuck: stuck.length };
}

export async function requestStatus(env: Env, code: string): Promise<{ code: string; status: 'received' | 'done' | 'needs_review'; removedConnections: number } | null> {
  if (!/^[0-9a-f]{32}$/.test(code)) return null;
  const r = await env.DB.prepare('SELECT state, removed_connections FROM meta_deletion_requests WHERE code = ?').bind(code).first<{ state: DeletionState; removed_connections: number }>();
  return r ? { code, status: statusOf(r.state), removedConnections: r.removed_connections } : null;
}

const T = {
  ar: {
    title: 'مسح بياناتك من واتساب',
    intro: 'لما بتشيل التطبيق من فيسبوك بنمسح ربط حسابك بالحسابات اللي وصّلتها بواتساب. الأرقام نفسها بتفضل شغالة لحد ما صاحب الحساب يأكد فصلها، وبننبّهه.',
    received: 'استلمنا الطلب وبنشتغل عليه.', done: 'خلص: اتمسح ربط حسابك، واتنبّه أصحاب الحسابات المتأثرة.', needs_review: 'استلمنا الطلب، وحد من فريقنا هيراجعه ويكمله ويرد عليك.',
    code: 'كود التأكيد', contact: 'لو عايز تسأل عن أي حاجة، اكتب لنا على',
    none: 'لو معاك كود تأكيد افتح الرابط اللي جاك. ولو عايز تطلب المسح بنفسك، اكتب لنا على',
  },
  en: {
    title: 'Delete your data from WhatsApp',
    intro: 'When you remove the app from Facebook we erase the link between your account and the WhatsApp accounts you connected. The numbers themselves stay connected until the account owner confirms a disconnect, and we notify them.',
    received: 'We received the request and are working on it.', done: 'Done: the link to your account was erased and the affected account owners were notified.', needs_review: 'We received the request; a person on our team will review and complete it, and reply to you.',
    code: 'Confirmation code', contact: 'For any question write to us at',
    none: 'If you have a confirmation code, open the link you were given. To ask for deletion yourself, write to us at',
  },
} as const;

/** A small page with no scripts or styles (the Worker's default CSP forbids both). Arabic first, English below. */
export function statusPage(supportEmail: string, s: { code: string; status: 'received' | 'done' | 'needs_review' } | null): string {
  const esc = (x: string) => x.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const block = (l: 'ar' | 'en') => `<section lang="${l}" dir="${l === 'ar' ? 'rtl' : 'ltr'}"><h1>${T[l].title}</h1><p>${T[l].intro}</p>${s ? `<p>${T[l][s.status]}</p><p>${T[l].code}: <code>${esc(s.code)}</code></p><p>${T[l].contact} <a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a></p>` : `<p>${T[l].none} <a href="mailto:${esc(supportEmail)}">${esc(supportEmail)}</a></p>`}</section>`;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${T.ar.title} / ${T.en.title}</title></head><body>${block('ar')}<hr>${block('en')}</body></html>`;
}
