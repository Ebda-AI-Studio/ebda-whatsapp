import type { Env } from '../../env';
import { alert } from '../observability';
import { DRAIN_PAGE, drainKeyset } from './drain';

/**
 * Ruling MONEY-FACT-1 - never reject an external money fact. A provider refund or chargeback is recorded in full and acted on (the wallet is debited, the package revoked) from the
 * EVENT's amount; the `refunded_minor` bookkeeping column is clamped to what was charged (`MIN(amount_minor, refunded_minor + ?)`, test/d1-indexes-bounds.test.ts scans every
 * writer), and whatever lies beyond the charge is recorded here and alerted for reconciliation (`refund_exceeds_charge`, P1).
 */
export async function noteRefundExcess(env: Env, a: { kind: 'topup' | 'package'; workspaceId: string; orderId: string; eventRef: string; eventMinor: number; overMinor: number }, now = Date.now()): Promise<void> {
  if (a.overMinor <= 0) return;
  await env.DB.prepare("INSERT INTO billing_audit (at, actor, action, workspace_id, before_json, after_json, ref) SELECT ?, 'provider', 'refund_exceeds_charge', ?, NULL, ?, ? WHERE NOT EXISTS (SELECT 1 FROM billing_audit WHERE action = 'refund_exceeds_charge' AND ref = ?)")
    .bind(now, a.workspaceId, JSON.stringify({ kind: a.kind, orderId: a.orderId, eventMinor: a.eventMinor, overMinor: a.overMinor }), a.eventRef, a.eventRef).run()
    .catch(() => undefined);
  alert('refund_exceeds_charge', { severity: 'P1', workspace: a.workspaceId, orderId: a.orderId, kind: a.kind, eventMinor: a.eventMinor, overMinor: a.overMinor });
}

/**
 * Daily: no order should ever have refunded > charged (every writer clamps). Any that does is reported. Paged by KEYSET through `drainKeyset` (M-178): a `LIMIT 50` read
 * and stop would report the first fifty and never see the rest, so a pass that finds many (the case that matters most) would hide most of them.
 */
export async function reconcileRefundBounds(env: Env): Promise<{ over: number }> {
  let over = 0;
  type R = { order_id: string; workspace_id: string; over: number };
  for (const [table, kind] of [['topups', 'topup'], ['package_orders', 'package']] as const) {
    await drainKeyset<R, string>({
      name: `refund_bounds_${kind}`, pageSize: DRAIN_PAGE,
      page: async (after) => (await env.DB.prepare(`SELECT order_id, workspace_id, refunded_minor - amount_minor AS over FROM ${table} WHERE refunded_minor > amount_minor AND (?1 IS NULL OR order_id > ?1) ORDER BY order_id LIMIT ?2`).bind(after, DRAIN_PAGE).all<R>()).results,
      cursorOf: (r) => r.order_id,
      handle: async (r) => { over++; alert('refund_exceeds_charge', { severity: 'P1', workspace: r.workspace_id, orderId: r.order_id, kind, overMinor: r.over, unclamped: true }); },
    });
  }
  return { over };
}
