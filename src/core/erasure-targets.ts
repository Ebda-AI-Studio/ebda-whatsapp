/**
 * THE list of what a customer is, in the Durable Object. `eraseContact` deletes through it and the restore (`dropErased`) filters a backup through
 * it, so the two can never drift apart; `test/erasure-record.test.ts` walks the DO schema and fails when a table that holds a customer is in neither
 * `ERASURE_TARGETS` nor `ERASURE_EXEMPT` (with the reason).
 *
 * `by` is how a row ties to the person: their WhatsApp id, their contact id, their conversation id, or one of their messages' wamid. `store_state_key`
 * is the key/value table: the customer's keys are `away:<wa_id>`. Order = deletion order (children before parents).
 */
export type TargetBy = 'wa_id' | 'contact_id' | 'conversation_id' | 'wamid' | 'message_id' | 'event_payload' | 'store_state_key';
/** `purge`: the retention purge deletes this table's rows together with each message it deletes (the same list drives both, so the schema-walk guard covers retention too). */
export type ErasureTarget = { table: string; by: TargetBy; purge?: true };

export const ERASURE_TARGETS: readonly ErasureTarget[] = [
  { table: 'message_status_events', by: 'wamid', purge: true },
  { table: 'agent_turns', by: 'message_id', purge: true },
  { table: 'events', by: 'event_payload', purge: true }, // realtime log: message events carry the message text; keyed by message id inside the JSON
  { table: 'tier_slots', by: 'contact_id' },
  { table: 'contact_tags', by: 'contact_id' },
  { table: 'consent_proofs', by: 'contact_id' }, // W2-CONSENT: the proof of a consent is the customer's data and goes with them
  { table: 'campaign_recipients', by: 'contact_id' },
  { table: 'campaign_links', by: 'contact_id' },
  { table: 'store_orders', by: 'wa_id' },
  { table: 'bot_sessions', by: 'wa_id' },
  { table: 'agent_handoffs', by: 'wa_id' },
  { table: 'store_state', by: 'store_state_key' },
  { table: 'notes', by: 'conversation_id' },
  { table: 'conversation_tags', by: 'conversation_id' },
  { table: 'messages', by: 'conversation_id', purge: true },
  { table: 'conversations', by: 'contact_id' },
  { table: 'contacts', by: 'wa_id' },
];

/** Tables that carry one of those columns but are NOT the customer's data, or are cleaned by dedicated code. The reason is the documentation. */
export const ERASURE_EXEMPT: Readonly<Record<string, string>> = {
  billable_sends: 'the billing record of a send (wamid, category, price): money records stay when a contact is erased (WA-REFUND-1); it holds no phone number',
  wallet_ledger: 'the wallet ledger (refs, amounts): money records stay; a ref can name a wamid but never a person',
  store_orders_after_erase: 'order ids and buyer keys of orders that arrived AFTER an erasure, to tell the Store; no phone number',
};

/** The store_state keys of one customer. */
export const stateKeysFor = (waId: string): string[] => [`away:${waId}`];

/** Deletes one customer through the list. `convId` is null when they have no conversation. Messages, their R2 keys and the search/event rows are the caller's (they need the rows first). */
export function deleteTargets(sql: SqlStorage, p: { waId: string; contactId: number; convId: number | null }): void {
  for (const t of ERASURE_TARGETS) {
    switch (t.by) {
      case 'wa_id': sql.exec(`DELETE FROM ${t.table} WHERE wa_id = ?`, p.waId); break;
      case 'contact_id': sql.exec(`DELETE FROM ${t.table} WHERE contact_id = ?`, p.contactId); break;
      case 'conversation_id': if (p.convId !== null) sql.exec(`DELETE FROM ${t.table} WHERE conversation_id = ?`, p.convId); break;
      case 'message_id': if (p.convId !== null) sql.exec(`DELETE FROM ${t.table} WHERE message_id IN (SELECT id FROM messages WHERE conversation_id = ?)`, p.convId); break;
      case 'event_payload': if (p.convId !== null) sql.exec(`DELETE FROM ${t.table} WHERE json_extract(payload, '$.conversationId') = ? OR json_extract(payload, '$.conversation.id') = ?`, p.convId, p.convId); break;
      case 'wamid': if (p.convId !== null) sql.exec(`DELETE FROM ${t.table} WHERE wamid IN (SELECT wamid FROM messages WHERE conversation_id = ? AND wamid IS NOT NULL)`, p.convId); break;
      case 'store_state_key': for (const k of stateKeysFor(p.waId)) sql.exec(`DELETE FROM ${t.table} WHERE key = ?`, k); break;
    }
  }
}
