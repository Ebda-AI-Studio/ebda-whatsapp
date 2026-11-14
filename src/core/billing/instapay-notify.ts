/**
 * InstaPay auto-confirm notices to the platform owner (C7), through the OS brain (the single consumer of the Telegram bot): one signed POST per daily digest and
 * one per "waiting for you" notice. Contract (foundation v0.3.0, `os/cloud/brain/src/instapay-bridge.ts`): headers X-Bridge-Product / X-Bridge-Ts / X-Bridge-Sig,
 * the signature is HMAC over `notify.<ts>.<raw body>`; success is HTTP 2xx WITH `{ sent: true }`. `digest_sent_at` is stamped ONLY then (INSTAPAY-CLEAN-1: a payment
 * is "clean" once it appeared in a digest that was really sent), so a failed or empty send leaves the rows for the next run.
 */
import { signBridge, type DigestItem } from '../../../foundation/instapay-digest';
import type { Env } from '../../env';
import { fetchWithTimeout } from '../net/fetch-with-timeout';
import { alert } from '../observability';
import type { InstapayRow } from './instapay';
import type { AutoRow } from './instapay-auto';

const PAGE = 200; // the brain accepts at most 200 items in one digest
export const STALE_DIGEST_MS = 26 * 3_600_000;

/** True only when the brain answered 2xx and said it sent the message. */
export async function notifyBrain(env: Env, kind: 'digest' | 'waiting', items: Array<DigestItem & { reasons?: string[] }>, now = Date.now()): Promise<boolean> {
  const secret = env.INSTAPAY_BRIDGE_SECRET;
  const url = env.BRAIN_BRIDGE_URL;
  if (!secret || secret.length < 16 || !url || !/^https:\/\/\S+$/.test(url)) return false;
  try {
    const body = JSON.stringify({ kind, items });
    const sig = await signBridge(secret, body, now, 'notify');
    const res = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json', 'X-Bridge-Product': 'chat', 'X-Bridge-Ts': String(now), 'X-Bridge-Sig': sig }, body }, { label: 'instapay.notify' });
    if (!res.ok) return false;
    const j = (await res.json().catch(() => null)) as { sent?: unknown } | null;
    return j?.sent === true;
  } catch {
    return false;
  }
}

type Joined = AutoRow & { kind: 'package' | 'topup'; workspace_name: string | null; req_amount: number };

const item = (a: Joined): DigestItem => ({ product: 'chat', id: a.request_id, ownerLabel: (a.workspace_name ?? a.workspace_id).slice(0, 40), amountMinor: a.req_amount, kind: a.kind, confirmedAt: a.confirmed_at ?? a.created_at });

/** One "waiting for you" notice for a request a person must look at. Stamps `waiting_notified_at` only on a real send; a failure is left for the daily digest of waiting items. */
export async function notifyWaiting(env: Env, row: AutoRow, r: InstapayRow, now = Date.now()): Promise<boolean> {
  const reasons = (() => { try { return JSON.parse(row.reasons_json) as string[]; } catch { return []; } })();
  const w = await env.DB.prepare('SELECT name FROM workspaces WHERE id = ?').bind(row.workspace_id).first<{ name: string }>();
  const ok = await notifyBrain(env, 'waiting', [{ ...item({ ...row, kind: r.kind, workspace_name: w?.name ?? null, req_amount: r.amount_minor }), reasons }], now);
  if (ok) await env.DB.prepare('UPDATE instapay_auto_confirmations SET waiting_notified_at = ? WHERE id = ? AND waiting_notified_at IS NULL').bind(now, row.id).run();
  return ok;
}

/**
 * The daily digest: every auto-confirmed payment not yet listed in a SENT digest (oldest first, 200 per message; the brain allows one digest a day, the rest go
 * tomorrow). Empty = nothing is sent. A payment reverted before the digest is not listed. The stamp is conditional, so a revert racing the send changes nothing.
 */
export async function runInstapayDigest(env: Env, now = Date.now()): Promise<{ sent: number; pending: number }> {
  const { results } = await env.DB.prepare(
    `SELECT ${['id', 'request_id', 'workspace_id', 'state', 'verdict', 'reasons_json', 'amount_minor', 'expected_amount_minor', 'is_first_payment', 'extracted_json', 'confirmed_at', 'digest_sent_at', 'reverted_at', 'reverted_by', 'grace_until', 'credits_removed_minor', 'credits_used_minor', 'ai_credits_removed', 'ai_credits_used', 'waiting_notified_at', 'created_at', 'updated_at'].map((c) => `a.${c}`).join(', ')},
            r.kind AS kind, r.amount_minor AS req_amount, w.name AS workspace_name
       FROM instapay_auto_confirmations a JOIN instapay_requests r ON r.id = a.request_id LEFT JOIN workspaces w ON w.id = a.workspace_id
      WHERE a.state = 'auto_confirmed' AND a.digest_sent_at IS NULL ORDER BY a.confirmed_at, a.id LIMIT ?`,
  ).bind(PAGE + 1).all<Joined>();
  if (results.length === 0) return { sent: 0, pending: 0 };
  const page = results.slice(0, PAGE);
  const oldest = page[0]!.confirmed_at ?? page[0]!.created_at;
  if (now - oldest > STALE_DIGEST_MS) alert('instapay_auto_digest_stale', { severity: 'P1', oldestAgeHours: Math.floor((now - oldest) / 3_600_000) });
  if (!(await notifyBrain(env, 'digest', page.map(item), now))) return { sent: 0, pending: results.length };
  const stamp = env.DB.prepare("UPDATE instapay_auto_confirmations SET digest_sent_at = ? WHERE id = ? AND state = 'auto_confirmed' AND digest_sent_at IS NULL");
  await env.DB.batch(page.map((a) => stamp.bind(now, a.id)));
  return { sent: page.length, pending: results.length - page.length };
}
