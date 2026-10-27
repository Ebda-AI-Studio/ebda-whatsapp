import type { Env } from '../../env';
import { alert } from '../observability';

/**
 * Ruling MONEY-FACT-1 - never reject an external money fact. A provider refund or chargeback is recorded in full and acted on (the wallet is debited, the package revoked) from the
 * EVENT's amount; the `refunded_minor` bookkeeping column is clamped to what was charged (`MIN(amount_minor, refunded_minor + ?)`, test/d1-indexes-bounds.test.ts scans every
 * writer), and whatever lies beyond the charge is recorded here and alerted for reconciliation (`refund_exceeds_charge`, P1).
 */
export async function noteRefundExcess(env: Env, a: { kind: 'topup' | 'package'; workspaceId: string; orderId: string; eventRef: string; eventMinor: number; overMinor: number }, now = Date.now()): Promise<void> {
  if (a.overMinor <= 0) return;
  await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, reason) SELECT ?, 'provider', 'refund_exceeds_charge', ?, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM billing_audit WHERE action = 'refund_exceeds_charge' AND reason = ?)")
    .bind(now, a.workspaceId, JSON.stringify({ kind: a.kind, orderId: a.orderId, eventMinor: a.eventMinor, overMinor: a.overMinor }), a.eventRef, a.eventRef).run()
    .catch(() => undefined);
  alert('refund_exceeds_charge', { severity: 'P1', workspace: a.workspaceId, orderId: a.orderId, kind: a.kind, eventMinor: a.eventMinor, overMinor: a.overMinor });
}

/** Daily: no order should ever have refunded > charged (every writer clamps). Any that does is reported. */
export async function reconcileRefundBounds(env: Env): Promise<{ over: number }> {
  const t = await env.DB.prepare('SELECT order_id, workspace_id, refunded_minor - amount_minor AS over FROM topups WHERE refunded_minor > amount_minor LIMIT 50').all<{ order_id: string; workspace_id: string; over: number }>();
  const p = await env.DB.prepare('SELECT order_id, workspace_id, refunded_minor - amount_minor AS over FROM package_orders WHERE refunded_minor > amount_minor LIMIT 50').all<{ order_id: string; workspace_id: string; over: number }>();
  for (const r of t.results) alert('refund_exceeds_charge', { severity: 'P1', workspace: r.workspace_id, orderId: r.order_id, kind: 'topup', overMinor: r.over, unclamped: true });
  for (const r of p.results) alert('refund_exceeds_charge', { severity: 'P1', workspace: r.workspace_id, orderId: r.order_id, kind: 'package', overMinor: r.over, unclamped: true });
  return { over: t.results.length + p.results.length };
}
