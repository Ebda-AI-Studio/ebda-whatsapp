/**
 * The merchant's weekly usage digest (T13): what the last 7 days looked like, in counts and amounts only. It is shown in the app (Ruling GROWTH-DIGEST-1) and
 * the owner can switch it off (`store_state digest.enabled = '0'`). It never contains a phone number, a name or a message text: every figure is a COUNT or a SUM
 * over rows the workspace already holds.
 */
type Sql = DurableObjectStorage['sql'];
const WEEK_MS = 7 * 86_400_000;
const KEY = 'digest.enabled';

export const digestEnabled = (sql: Sql): boolean => sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', KEY).toArray()[0]?.value !== '0';
export function setDigestEnabled(sql: Sql, enabled: boolean): void {
  sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', KEY, enabled ? '1' : '0');
}

export type DigestCounts = {
  from: number; to: number; customersWrote: number; messagesIn: number; messagesOut: number; delivered: number; failed: number; aiReplies: number; aiCreditsUsed: number;
  handoffs: number; campaignRecipients: number; optOuts: number; spendMinor: number; topupsMinor: number;
};

export function digestCounts(sql: Sql, now: number): DigestCounts {
  const from = now - WEEK_MS;
  const one = (q: string, ...p: SqlStorageValue[]): number => sql.exec<{ n: number | null }>(q, ...p).one().n ?? 0;
  return {
    from, to: now,
    customersWrote: one("SELECT count(DISTINCT conversation_id) AS n FROM messages WHERE direction = 'in' AND created_at >= ? AND created_at < ?", from, now),
    messagesIn: one("SELECT count(*) AS n FROM messages WHERE direction = 'in' AND created_at >= ? AND created_at < ?", from, now),
    messagesOut: one("SELECT count(*) AS n FROM messages WHERE direction = 'out' AND created_at >= ? AND created_at < ?", from, now),
    delivered: one("SELECT count(*) AS n FROM messages WHERE direction = 'out' AND status IN ('delivered', 'read') AND created_at >= ? AND created_at < ?", from, now),
    failed: one("SELECT count(*) AS n FROM messages WHERE direction = 'out' AND status = 'failed' AND created_at >= ? AND created_at < ?", from, now),
    aiReplies: one("SELECT count(*) AS n FROM credit_ledger WHERE kind = 'ai_charge' AND at >= ? AND at < ?", from, now),
    aiCreditsUsed: one("SELECT -sum(amount) AS n FROM credit_ledger WHERE kind = 'ai_charge' AND at >= ? AND at < ?", from, now),
    handoffs: one('SELECT count(*) AS n FROM agent_handoffs WHERE started_at >= ? AND started_at < ?', from, now),
    campaignRecipients: one("SELECT count(*) AS n FROM campaign_recipients WHERE state = 'queued' AND at >= ? AND at < ?", from, now),
    optOuts: one('SELECT count(*) AS n FROM contacts WHERE opted_out_at >= ? AND opted_out_at < ?', from, now),
    spendMinor: one("SELECT -sum(amount_minor) AS n FROM wallet_ledger WHERE kind = 'meta_charge' AND amount_minor < 0 AND at >= ? AND at < ?", from, now),
    topupsMinor: one("SELECT sum(amount_minor) AS n FROM wallet_ledger WHERE kind = 'topup' AND amount_minor > 0 AND at >= ? AND at < ?", from, now),
  };
}
