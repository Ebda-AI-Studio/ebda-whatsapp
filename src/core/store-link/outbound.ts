import type { TemplateComponent } from '../meta/client';
import { WINDOW_MS } from '../dto';
import { addTask } from '../scheduler';
import type { SendJob } from '../send-queue';
import { componentsSchema, renderTemplate } from '../templates';
import type { LinkHost } from './host';

const previewOf = (s: string) => Array.from(s).slice(0, 280).join('');

/** A template parameter that is safe for Meta: one line, no runs of spaces, bounded, never empty. */
export function cleanParam(value: string | null | undefined, fallback: string, max = 60): string {
  const t = (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return t || fallback;
}

export type QueueResult =
  | { ok: true; duplicate: false; messageId: number; job: SendJob }
  | { ok: true; duplicate: true }
  | { ok: false; reason: 'template_not_approved' | 'wrong_category' | 'opted_out' | 'no_consent' | 'invalid_request'; message?: string };

export type TemplateSend = {
  waId: string;
  phoneNumberId: string;
  name: string;
  /** Tried first; falls back to `fallbackLanguage` when the template is not approved in it. */
  language: string;
  fallbackLanguage?: string;
  params: string[];
  idempotencyKey: string;
  /** Appended after the rendered components (e.g. quick-reply payloads). */
  extraComponents?: TemplateComponent[];
  /** Marketing sends need a recorded opt-in, not just the absence of an opt-out. */
  requireConsent?: boolean;
  profileName?: string | null;
  /** Refuse unless the approved template has exactly this Meta category. */
  requireCategory?: string;
  /** Store only a mask as the message text (a code must not reach the inbox, search or events whatever the template). */
  maskText?: string;
  /** False when the caller sends the job itself (one-time codes): then no scheduler row holds the code. Default true. */
  scheduleRelease?: boolean;
  now?: number;
};

/**
 * Stores a 'queued' template message and schedules its hand-over to the send queue in the SAME transaction as the
 * caller's other writes, so a crash can neither lose the message nor leave an orphan 'queued' row. The send itself
 * goes through the Phase 2 pipeline (claim, window, tier, throughput). Call inside `storage.transactionSync`.
 */
export function queueTemplate(host: LinkHost, a: TemplateSend): QueueResult {
  const now = a.now ?? Date.now();
  if (host.sql.exec('SELECT 1 FROM messages WHERE idempotency_key = ?', a.idempotencyKey).toArray().length) return { ok: true, duplicate: true };
  const languages = [a.language, ...(a.fallbackLanguage && a.fallbackLanguage !== a.language ? [a.fallbackLanguage] : [])];
  let t: { category: string; components: string; language: string } | undefined;
  for (const language of languages) {
    t = host.sql.exec<{ category: string; components: string; language: string }>("SELECT category, components, language FROM templates WHERE name = ? AND language = ? AND status = 'APPROVED'", a.name, language).toArray()[0];
    if (t) break;
  }
  if (!t) return { ok: false, reason: 'template_not_approved' };
  if (a.requireCategory && t.category !== a.requireCategory) return { ok: false, reason: 'wrong_category' };
  const contact = host.sql.exec<{ opted_out_at: number | null; consent_at: number | null }>('SELECT opted_out_at, consent_at FROM contacts WHERE wa_id = ?', a.waId).toArray()[0];
  if (t.category === 'MARKETING') {
    if (contact?.opted_out_at != null) return { ok: false, reason: 'opted_out' };
    if (a.requireConsent && contact?.consent_at == null) return { ok: false, reason: 'no_consent' };
  }
  const stored = componentsSchema.safeParse(JSON.parse(t.components));
  if (!stored.success) return { ok: false, reason: 'invalid_request', message: 'stored template is malformed' };
  const rendered = renderTemplate(stored.data, a.params, t.category);
  if (!rendered.ok) return { ok: false, reason: 'invalid_request', message: rendered.message };
  const shown = a.maskText ?? rendered.text;
  const { conversationId } = host.ensureConversation(a.waId, now, a.profileName);
  const messageId = host.insertOutbound(conversationId, { type: 'template', preview: shown, body: shown.length ? shown : null, key: a.idempotencyKey, templateName: a.name, templateLang: t.language }, now);
  const job: SendJob = {
    workspaceId: host.workspaceId, phoneNumberId: a.phoneNumberId, to: a.waId, idempotencyKey: a.idempotencyKey, kind: 'template',
    template: { name: a.name, language: t.language, components: [...rendered.components, ...(a.extraComponents ?? [])] },
  };
  if (a.scheduleRelease !== false) addTask(host.sql, 'send_release', now, { job, reason: 'event' });
  return { ok: true, duplicate: false, messageId, job };
}

/** Free text to a contact whose 24 h window is open; null when it is closed (templates only then). Call inside a transaction. */
export function queueFreeText(host: LinkHost, a: { waId: string; phoneNumberId: string; text: string; idempotencyKey: string; now?: number }): { messageId: number; job: SendJob } | 'duplicate' | 'window_closed' {
  const now = a.now ?? Date.now();
  if (host.sql.exec('SELECT 1 FROM messages WHERE idempotency_key = ?', a.idempotencyKey).toArray().length) return 'duplicate';
  const contact = host.sql.exec<{ last_inbound_at: number | null }>('SELECT last_inbound_at FROM contacts WHERE wa_id = ?', a.waId).toArray()[0];
  if (!contact?.last_inbound_at || contact.last_inbound_at * 1000 + WINDOW_MS <= now) return 'window_closed';
  const { conversationId } = host.ensureConversation(a.waId, now);
  const messageId = host.insertOutbound(conversationId, { type: 'text', preview: previewOf(a.text), body: a.text, key: a.idempotencyKey }, now);
  const job: SendJob = { workspaceId: host.workspaceId, phoneNumberId: a.phoneNumberId, to: a.waId, idempotencyKey: a.idempotencyKey, kind: 'text', text: a.text };
  addTask(host.sql, 'send_release', now, { job, reason: 'event' });
  return { messageId, job };
}

/** Adds or removes a tag on the contact's conversation and tells open inboxes. Call inside a transaction. */
export function setTag(host: LinkHost, waId: string, tag: string, on: boolean): void {
  const conv = host.sql.exec<{ id: number }>('SELECT c.id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id WHERE ct.wa_id = ?', waId).toArray()[0];
  if (!conv) return;
  const changed = on
    ? host.sql.exec('INSERT OR IGNORE INTO conversation_tags (conversation_id, tag) VALUES (?, ?)', conv.id, tag).rowsWritten > 0
    : host.sql.exec('DELETE FROM conversation_tags WHERE conversation_id = ? AND tag = ?', conv.id, tag).rowsWritten > 0;
  if (changed) host.emitConversationUpdated(conv.id);
}
