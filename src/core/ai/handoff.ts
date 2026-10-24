/**
 * Handing a conversation to a person. The conversation gets the tag `needs_human` (the inbox lights up through the usual
 * conversation.updated event) and the bot stays silent for the workspace's handoff window.
 */
import { setTag } from '../store-link/outbound';
import type { LinkHost } from '../store-link/host';
import { readAgentSettings } from './settings';

export const NEEDS_HUMAN_TAG = 'needs_human';
/** Why a conversation was handed over; stored as a code, never as free text from the customer or the model. */
export type HandoffReason = 'asked' | 'model' | 'no_credits' | 'misconfigured' | 'provider_error' | 'bad_output' | 'no_answer';

/** True while the bot must stay silent for this customer. An elapsed window is cleared on the way (row and tag). */
export function handoffActive(host: LinkHost, waId: string, now: number): boolean {
  const row = host.sql.exec<{ until_at: number }>('SELECT until_at FROM agent_handoffs WHERE wa_id = ?', waId).toArray()[0];
  if (!row) return false;
  if (row.until_at > now) return true;
  host.storage.transactionSync(() => {
    host.sql.exec('DELETE FROM agent_handoffs WHERE wa_id = ? AND until_at <= ?', waId, now);
    setTag(host, waId, NEEDS_HUMAN_TAG, false);
  });
  return false;
}

/** Marks the handoff. Call inside a transaction. A second handoff while one is open keeps the earlier start and extends nothing. */
export function markHandoff(host: LinkHost, waId: string, reason: HandoffReason, now: number): void {
  const minutes = readAgentSettings(host.sql).handoffMinutes;
  host.sql.exec(
    'INSERT INTO agent_handoffs (wa_id, started_at, until_at, reason) VALUES (?, ?, ?, ?) ON CONFLICT(wa_id) DO UPDATE SET until_at = max(until_at, excluded.until_at)',
    waId, now, now + minutes * 60_000, reason,
  );
  setTag(host, waId, NEEDS_HUMAN_TAG, true);
}
