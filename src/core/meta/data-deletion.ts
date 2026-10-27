/**
 * Meta's data-deletion callback (B9). Meta POSTs `signed_request=<signature>.<payload>` (base64url, the signature is HMAC-SHA256 of the payload STRING with the app
 * secret) when a person removes the app. We verify it, record the request, answer `{ url, confirmation_code }` (Meta's spec) and erase what that person connected.
 *
 * What "erase" covers: the connections (WhatsApp Business Accounts, their numbers, business tokens and registration PINs) that the person authorised, found through
 * `waba_credentials.fb_user_id` (the id the browser reported at Embedded Signup). A merchant's CUSTOMER data belongs to the merchant's workspace and has its own erasure
 * path (`DELETE /contacts/:waId`, workspace deletion). A request we cannot match is NOT reported as done: it waits for a person (state `nothing_found`, status
 * `needs_review`, P1 alert). NOT VERIFIED against Meta's live callback.
 */
import { z } from 'zod';
import type { Env } from '../../env';
import { alert, errClass } from '../observability';
import { disconnectNumber } from '../numbers/numbers';

const b64urlToBytes = (s: string): Uint8Array<ArrayBuffer> => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '='));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
};
const hex = (b: ArrayBuffer): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const hmacKey = (secret: string, usage: 'sign' | 'verify') => crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [usage]);

const payloadSchema = z.object({ algorithm: z.literal('HMAC-SHA256'), user_id: z.string().regex(/^[0-9]{1,40}$/), issued_at: z.number().int().nonnegative().optional() });

/** The payload of a genuine signed request, or null for anything else (wrong signature, algorithm, shape). */
export async function parseSignedRequest(raw: string, appSecret: string | undefined): Promise<{ userId: string; issuedAt: number } | null> {
  if (!appSecret) return null;
  const [sig, payload, extra] = raw.split('.');
  if (!sig || !payload || extra !== undefined) return null;
  try {
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(appSecret, 'verify'), b64urlToBytes(sig), new TextEncoder().encode(payload));
    if (!ok) return null;
    const p = payloadSchema.safeParse(JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))));
    return p.success ? { userId: p.data.user_id, issuedAt: p.data.issued_at ?? 0 } : null;
  } catch {
    return null;
  }
}

export type DeletionState = 'queued' | 'done' | 'nothing_found' | 'failed';
/** What the status page and the JSON say. Never a user id. */
export const statusOf = (s: DeletionState): 'received' | 'done' | 'needs_review' => (s === 'queued' ? 'received' : s === 'done' ? 'done' : 'needs_review');

/** Records a verified request (a retry finds its row) and returns its code and whether this call created it. */
export async function recordRequest(env: Env, r: { userId: string; issuedAt: number }, now: number): Promise<{ code: string; created: boolean }> {
  const sign = async (text: string) => hex(await crypto.subtle.sign('HMAC', await hmacKey(env.META_APP_SECRET!, 'sign'), new TextEncoder().encode(text)));
  const code = (await sign(`deletion-code:${r.userId}:${r.issuedAt}`)).slice(0, 32);
  const userHash = (await sign(`deletion-user:${r.userId}`)).slice(0, 32);
  const res = await env.DB.prepare("INSERT OR IGNORE INTO meta_deletion_requests (code, user_hash, received_at, state) VALUES (?, ?, ?, 'queued')").bind(code, userHash, now).run();
  return { code, created: res.meta.changes > 0 };
}

/** Removes the connections this person made. Marks the request done / nothing_found / failed; never throws. */
export async function processRequest(env: Env, code: string, userId: string, now = Date.now()): Promise<void> {
  try {
    const creds = (await env.DB.prepare('SELECT waba_id, workspace_id FROM waba_credentials WHERE fb_user_id = ?').bind(userId).all<{ waba_id: string; workspace_id: string }>()).results;
    let removed = 0;
    for (const c of creds) {
      const numbers = (await env.DB.prepare("SELECT phone_number_id FROM phone_numbers WHERE waba_id = ? AND workspace_id = ? AND kind = 'own' AND status != 'disconnected'").bind(c.waba_id, c.workspace_id).all<{ phone_number_id: string }>()).results;
      for (const n of numbers) await disconnectNumber(env, c.workspace_id, n.phone_number_id);
      await env.DB.prepare('DELETE FROM waba_credentials WHERE waba_id = ? AND workspace_id = ?').bind(c.waba_id, c.workspace_id).run(); // also when it had no active number left
      removed++;
    }
    const state: DeletionState = removed > 0 ? 'done' : 'nothing_found';
    await env.DB.prepare('UPDATE meta_deletion_requests SET state = ?, removed_connections = ?, finished_at = ? WHERE code = ?').bind(state, removed, now, code).run();
    console.log(JSON.stringify({ audit: 'meta_deletion', state, removed }));
    if (state === 'nothing_found') alert('meta_deletion_needs_review', { reason: 'no_matching_connection' });
  } catch (err) {
    await env.DB.prepare("UPDATE meta_deletion_requests SET state = 'failed', finished_at = ? WHERE code = ?").bind(now, code).run().catch(() => undefined);
    alert('meta_deletion_needs_review', { reason: 'failed', error: errClass(err) });
  }
}

export async function requestStatus(env: Env, code: string): Promise<{ code: string; status: 'received' | 'done' | 'needs_review'; removedConnections: number } | null> {
  if (!/^[0-9a-f]{32}$/.test(code)) return null;
  const r = await env.DB.prepare('SELECT state, removed_connections FROM meta_deletion_requests WHERE code = ?').bind(code).first<{ state: DeletionState; removed_connections: number }>();
  return r ? { code, status: statusOf(r.state), removedConnections: r.removed_connections } : null;
}

const T = {
  ar: {
    title: 'مسح بياناتك من واتساب',
    intro: 'لما بتشيل التطبيق من فيسبوك بنمسح الربط اللي عملته مع واتساب: الحسابات والأرقام والمفاتيح المتخزنة.',
    received: 'استلمنا الطلب وبنشتغل عليه.', done: 'خلص: اتمسح الربط اللي عملته.', needs_review: 'استلمنا الطلب، وحد من فريقنا هيراجعه ويكمله ويرد عليك.',
    code: 'كود التأكيد', contact: 'لو عايز تسأل عن أي حاجة، اكتب لنا على',
    none: 'لو معاك كود تأكيد افتح الرابط اللي جاك. ولو عايز تطلب المسح بنفسك، اكتب لنا على',
  },
  en: {
    title: 'Delete your data from WhatsApp',
    intro: 'When you remove the app from Facebook we delete the connection you made to WhatsApp: the accounts, numbers and stored keys.',
    received: 'We received the request and are working on it.', done: 'Done: the connection you made was deleted.', needs_review: 'We received the request; a person on our team will review and complete it, and reply to you.',
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
