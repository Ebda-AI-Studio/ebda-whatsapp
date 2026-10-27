import { indexContactName } from './contact-index';

/**
 * One customer's data: export (B5, the data-subject right of access), edit and merge (M-175). Plain functions over the workspace's SQLite so the Durable Object stays
 * a thin shell. Nothing here logs: the routes audit (ids and the keyed hash, never the number).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>; // JSON-safe values only; `any` keeps the Durable Object RPC types simple
const contactRow = (sql: SqlStorage, waId: string) =>
  sql.exec<{ id: number; wa_id: string; profile_name: string | null; opted_out_at: number | null; consent_source: string | null; consent_at: number | null; last_inbound_at: number | null }>(
    'SELECT id, wa_id, profile_name, opted_out_at, consent_source, consent_at, last_inbound_at FROM contacts WHERE wa_id = ?', waId,
  ).toArray()[0];

export type ContactExport = {
  version: 1; generatedAt: number;
  subject: { waId: string; name: string | null; optedOut: boolean; optedOutAt: number | null; consent: { source: string; at: number | null } | null; lastInboundAt: number | null };
  messages: Row[]; nextAfter: number | null;
  conversation?: { id: number; assigneeUserId: string | null; unread: number; lastMessageAt: number | null } | null;
  notes?: Row[]; tags?: string[]; orders?: Row[]; campaigns?: Row[];
};

/** `after` = the last message id of the previous page (0 for the first); the other sections come with the first page only. Long bodies are read back from R2 in full. */
export async function exportContact(sql: SqlStorage, media: R2Bucket, waId: string, after: number, limit: number, now = Date.now()): Promise<ContactExport | null> {
  const c = contactRow(sql, waId);
  if (!c) return null;
  const conv = sql.exec<{ id: number; assignee_user_id: string | null; unread: number; last_message_at: number | null }>('SELECT id, assignee_user_id, unread, last_message_at FROM conversations WHERE contact_id = ?', c.id).toArray()[0];
  const raw = conv
    ? sql.exec<{ id: number; wamid: string | null; direction: string; type: string; body: string | null; body_r2_key: string | null; template_name: string | null; template_lang: string | null; media_mime: string | null; media_size: number | null; status: string | null; error_code: number | null; author: string | null; created_at: number }>(
      'SELECT id, wamid, direction, type, body, body_r2_key, template_name, template_lang, media_mime, media_size, status, error_code, author, created_at FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT ?', conv.id, after, limit + 1,
    ).toArray()
    : [];
  const page = raw.slice(0, limit);
  const messages: Row[] = [];
  for (const m of page) {
    const text = m.body ?? (m.body_r2_key ? await (await media.get(m.body_r2_key))?.text() ?? null : null);
    messages.push({
      id: m.id, wamid: m.wamid, direction: m.direction, type: m.type, text, mediaMime: m.media_mime, mediaSize: m.media_size,
      template: m.template_name ? { name: m.template_name, language: m.template_lang } : null, status: m.status, errorCode: m.error_code, author: m.author, at: m.created_at,
    });
  }
  const out: ContactExport = {
    version: 1, generatedAt: now,
    subject: {
      waId: c.wa_id, name: c.profile_name, optedOut: c.opted_out_at !== null, optedOutAt: c.opted_out_at,
      consent: c.consent_source || c.consent_at ? { source: c.consent_source ?? '', at: c.consent_at } : null, lastInboundAt: c.last_inbound_at,
    },
    messages, nextAfter: raw.length > limit ? page[page.length - 1]!.id : null,
  };
  if (after > 0) return out;
  out.conversation = conv ? { id: conv.id, assigneeUserId: conv.assignee_user_id, unread: conv.unread, lastMessageAt: conv.last_message_at } : null;
  out.notes = conv ? sql.exec<{ created_at: number; author_user_id: string; text: string }>('SELECT created_at, author_user_id, text FROM notes WHERE conversation_id = ? ORDER BY id', conv.id).toArray().map((n) => ({ at: n.created_at, authorUserId: n.author_user_id, text: n.text })) : [];
  const tags = new Set<string>(sql.exec<{ tag: string }>('SELECT tag FROM contact_tags WHERE contact_id = ?', c.id).toArray().map((t) => t.tag));
  if (conv) for (const t of sql.exec<{ tag: string }>('SELECT tag FROM conversation_tags WHERE conversation_id = ?', conv.id).toArray()) tags.add(t.tag);
  out.tags = [...tags];
  out.orders = sql.exec<{ order_id: string; order_number: string | null; payment_method: string | null; status: string | null; total_minor: number | null; currency: string | null; cod_state: string | null; outcome: string | null; updated_at: number }>(
    'SELECT order_id, order_number, payment_method, status, total_minor, currency, cod_state, outcome, updated_at FROM store_orders WHERE wa_id = ? ORDER BY updated_at', waId,
  ).toArray().map((o) => ({ orderId: o.order_id, orderNumber: o.order_number, paymentMethod: o.payment_method, status: o.status, totalMinor: o.total_minor, currency: o.currency, codState: o.cod_state, outcome: o.outcome, at: o.updated_at }));
  out.campaigns = sql.exec<{ campaign_id: string; state: string; skip_reason: string | null; at: number }>('SELECT campaign_id, state, skip_reason, at FROM campaign_recipients WHERE contact_id = ? ORDER BY at', c.id).toArray()
    .map((r) => ({ campaignId: r.campaign_id, state: r.state, skipReason: r.skip_reason, at: r.at }));
  return out;
}

export type ContactSummary = { waId: string; name: string | null; optedOut: boolean };

/** Sets (or, with null, releases) the name the merchant gave a contact. A set name is not overwritten by WhatsApp's profile name (`name_edited`). Call inside a transaction. */
export function renameContact(sql: SqlStorage, waId: string, name: string | null): ContactSummary | null {
  const c = contactRow(sql, waId);
  if (!c) return null;
  if (name === null) sql.exec('UPDATE contacts SET name_edited = 0 WHERE id = ?', c.id);
  else sql.exec('UPDATE contacts SET profile_name = ?, name_edited = 1 WHERE id = ?', name, c.id);
  indexContactName(sql, c.id);
  const now = contactRow(sql, waId)!;
  return { waId, name: now.profile_name, optedOut: now.opted_out_at !== null };
}

/**
 * Folds `from` into `into` (the same person on a new number): messages, notes, tags, orders and campaign rows move; unread adds up; the older of two opt-outs wins (a STOP is
 * never lost); `from` is deleted. Call inside a transaction; `emit` tells connected clients the surviving chat changed.
 */
export function mergeContacts(sql: SqlStorage, fromWaId: string, intoWaId: string, emit: (conversationId: number) => void): (ContactSummary & { messages: number; conversationId: number | null }) | null {
  const f = contactRow(sql, fromWaId);
  const t = contactRow(sql, intoWaId);
  if (!f || !t || f.id === t.id) return null;
  const conv = (contactId: number) => sql.exec<{ id: number; unread: number; last_message_at: number | null; assignee_user_id: string | null }>('SELECT id, unread, last_message_at, assignee_user_id FROM conversations WHERE contact_id = ?', contactId).toArray()[0];
  const fc = conv(f.id);
  const tc = conv(t.id);
  let convId: number | null = tc?.id ?? null;
  if (fc && tc) {
    sql.exec('UPDATE messages SET conversation_id = ? WHERE conversation_id = ?', tc.id, fc.id);
    sql.exec('UPDATE notes SET conversation_id = ? WHERE conversation_id = ?', tc.id, fc.id);
    sql.exec('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag) SELECT ?, tag FROM conversation_tags WHERE conversation_id = ?', tc.id, fc.id);
    sql.exec('DELETE FROM conversation_tags WHERE conversation_id = ?', fc.id);
    sql.exec('UPDATE conversations SET unread = unread + ?, last_message_at = max(coalesce(last_message_at, 0), ?), assignee_user_id = coalesce(assignee_user_id, ?) WHERE id = ?', fc.unread, fc.last_message_at ?? 0, fc.assignee_user_id, tc.id);
    sql.exec("DELETE FROM events WHERE json_extract(payload, '$.conversationId') = ? OR json_extract(payload, '$.conversation.id') = ?", fc.id, fc.id);
    sql.exec('DELETE FROM conversations WHERE id = ?', fc.id);
  } else if (fc) {
    sql.exec('UPDATE conversations SET contact_id = ? WHERE id = ?', t.id, fc.id);
    convId = fc.id;
  }
  const optedOut = [f.opted_out_at, t.opted_out_at].filter((x): x is number => x !== null).sort((a, b) => a - b)[0] ?? null;
  const keepConsent = t.consent_at !== null || t.consent_source !== null ? t : f;
  sql.exec(
    'UPDATE contacts SET opted_out_at = ?, consent_source = ?, consent_at = ?, profile_name = coalesce(profile_name, ?), last_inbound_at = max(coalesce(last_inbound_at, 0), ?) WHERE id = ?',
    optedOut, keepConsent.consent_source, keepConsent.consent_at, f.profile_name, f.last_inbound_at ?? 0, t.id,
  );
  sql.exec('INSERT OR IGNORE INTO contact_tags (contact_id, tag) SELECT ?, tag FROM contact_tags WHERE contact_id = ?', t.id, f.id);
  sql.exec('DELETE FROM contact_tags WHERE contact_id = ?', f.id);
  sql.exec('UPDATE OR IGNORE campaign_recipients SET contact_id = ? WHERE contact_id = ?', t.id, f.id);
  sql.exec('DELETE FROM campaign_recipients WHERE contact_id = ?', f.id);
  sql.exec('UPDATE campaign_links SET contact_id = ? WHERE contact_id = ?', t.id, f.id);
  sql.exec('DELETE FROM tier_slots WHERE contact_id = ?', f.id);
  sql.exec('UPDATE store_orders SET wa_id = ? WHERE wa_id = ?', intoWaId, fromWaId);
  sql.exec('DELETE FROM bot_sessions WHERE wa_id = ?', fromWaId);
  sql.exec('DELETE FROM agent_handoffs WHERE wa_id = ?', fromWaId);
  sql.exec("DELETE FROM store_state WHERE key = ?", `away:${fromWaId}`);
  sql.exec("DELETE FROM scheduled_tasks WHERE kind = 'bot_turn' AND json_extract(payload, '$.from') = ?", fromWaId);
  sql.exec('DELETE FROM contacts_fts WHERE rowid = ?', f.id);
  sql.exec('DELETE FROM contacts WHERE id = ?', f.id);
  indexContactName(sql, t.id);
  const after = contactRow(sql, intoWaId)!;
  const messages = convId === null ? 0 : sql.exec<{ n: number }>('SELECT count(*) AS n FROM messages WHERE conversation_id = ?', convId).one().n;
  if (convId !== null) emit(convId);
  return { waId: intoWaId, name: after.profile_name, optedOut: after.opted_out_at !== null, messages, conversationId: convId };
}
