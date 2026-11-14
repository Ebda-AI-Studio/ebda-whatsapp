/**
 * Telling the OWNER that a customer needs a person (audit D3). Until now a handoff only lit a badge in the inbox while the customer was promised a reply.
 *
 * Channel, in this order (the repo has no web push or e-mail path to the merchant, so those are not offered):
 *  1. free WhatsApp text to `notifyPhone` while that number's own 24 h window is open (the owner wrote to the business number in the last day);
 *  2. the approved UTILITY template `handoff_alert` (in the starter template set; Meta approves it, we never assume it);
 *  3. neither possible: the alert `handoff_owner_unreachable` is raised for the operator and the conversation stays tagged `needs_human`
 *     (the badge) and is listed by the daily digest.
 * One notice per handoff (the handoff's start time is the marker). Customer lines are masked like any text leaving for a model or a log: no phone,
 * card or e-mail. Never throws into the handoff: the customer's acknowledgement does not depend on this.
 */
import { alert, errClass } from '../observability';
import { BACKUP_TIME_ZONE, nextLocalHour } from '../backup';
import { addTask } from '../scheduler';
import { cleanParam, queueFreeText, queueTemplate } from '../store-link/outbound';
import type { LinkHost } from '../store-link/host';
import { maskForModel } from './mask';
import { NEEDS_HUMAN_TAG } from './handoff';
import { getAgentState, putAgentState, readAgentSettings } from './settings';

export const HANDOFF_TEMPLATE = 'handoff_alert';
/** The owner's digest goes out at 10:00 Africa/Cairo (a shop owner's morning, not the middle of the night). */
export const DIGEST_HOUR_LOCAL = 10;
const LINES = 3;
const LINE_CHARS = 140;

type Outcome = 'off' | 'self' | 'duplicate' | 'text' | 'template' | 'unreachable';

/** The customer's last few messages, oldest first, one line each, masked. */
function lastLines(host: LinkHost, waId: string): string[] {
  return host.sql.exec<{ t: string | null }>(
    `SELECT coalesce(m.body, m.preview) AS t FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
     WHERE ct.wa_id = ? AND m.direction = 'in' AND coalesce(m.body, m.preview) IS NOT NULL ORDER BY m.id DESC LIMIT ?`,
    waId, LINES,
  ).toArray().reverse().map((r) => maskForModel((r.t ?? '').replace(/\s+/g, ' ').trim().slice(0, LINE_CHARS))).filter(Boolean);
}

function send(host: LinkHost, owner: string, phoneNumberId: string, key: string, name: string, summary: string, now: number): Outcome {
  const text = `${summary}`;
  const free = queueFreeText(host, { waId: owner, phoneNumberId, text, idempotencyKey: `${key}:text`, now });
  if (typeof free === 'object') return 'text';
  if (free === 'duplicate') return 'duplicate';
  const oneLine = cleanParam(summary.replace(/\n+/g, ' | '), '-', 600);
  const t = queueTemplate(host, { waId: owner, phoneNumberId, name: HANDOFF_TEMPLATE, language: 'ar', fallbackLanguage: 'en', params: [cleanParam(name, 'عميل'), oneLine], idempotencyKey: `${key}:tpl`, requireCategory: 'UTILITY', now });
  if (t.ok) return t.duplicate ? 'duplicate' : 'template';
  alert('handoff_owner_unreachable', { workspace: host.workspaceId, reason: t.reason === 'template_not_approved' ? (free === 'plan_required' ? 'plan_required' : 'no_window_no_template') : t.reason });
  return 'unreachable';
}

/** Await before the handoff transaction: a template send decides on the wallet, which needs fresh price inputs (cheap when they are fresh). A no-op without a notify number. */
export async function prepareOwnerNotice(host: LinkHost): Promise<void> {
  if (readAgentSettings(host.sql).notifyPhone) await host.ensurePricing();
}

/** Call inside the handoff transaction, right after `markHandoff`. */
export function notifyOwnerOfHandoff(host: LinkHost, a: { waId: string; phoneNumberId: string; profileName: string | null; now: number }): Outcome {
  try {
    const owner = readAgentSettings(host.sql).notifyPhone?.slice(1);
    if (!owner) return 'off';
    if (owner === a.waId) return 'self';
    const started = host.sql.exec<{ started_at: number }>('SELECT started_at FROM agent_handoffs WHERE wa_id = ?', a.waId).toArray()[0]?.started_at;
    if (started === undefined) return 'off';
    const marker = `handoff_notice:${a.waId}`;
    if (getAgentState(host.sql, marker) === String(started)) return 'duplicate';
    putAgentState(host.sql, marker, String(started));
    ensureDigestTask(host, a.now);
    const lines = lastLines(host, a.waId);
    const who = cleanParam(a.profileName, 'عميل', 40);
    const summary = `🔔 ${who} محتاج حد من الفريق يرد عليه.${lines.length ? `\nآخر رسايله:\n${lines.map((l) => `- ${l}`).join('\n')}` : ''}`;
    return send(host, owner, a.phoneNumberId, `handoff:${a.waId}:${started}`, who, summary, a.now);
  } catch (err) {
    alert('handoff_owner_notice_failed', { workspace: host.workspaceId, error: errClass(err) });
    return 'unreachable';
  }
}

/** Conversations still waiting for a person (tag `needs_human`, which a staff reply or an assignment clears): name only, never a phone. */
export function waitingForPerson(host: LinkHost): { names: string[]; count: number } {
  const r = host.sql.exec<{ n: string | null }>(
    `SELECT ct.profile_name AS n FROM conversation_tags t JOIN conversations c ON c.id = t.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE t.tag = ? ORDER BY c.last_message_at DESC`,
    NEEDS_HUMAN_TAG,
  ).toArray();
  return { count: r.length, names: r.slice(0, 5).map((x) => cleanParam(x.n, 'عميل', 30)) };
}

/** The daily digest (task `handoff_digest`): how many conversations still wait, once per day, to the owner. Silent when none wait or no number is set. */
export function runHandoffDigest(host: LinkHost, phoneNumberId: string | null, now: number): Outcome {
  try {
    const owner = readAgentSettings(host.sql).notifyPhone?.slice(1);
    if (!owner || !phoneNumberId) return 'off';
    const w = waitingForPerson(host);
    if (!w.count) return 'off';
    const day = new Date(now).toISOString().slice(0, 10);
    const summary = `📋 عندك ${w.count} محادثة لسه مستنية رد من حد من الفريق: ${w.names.join('، ')}${w.count > w.names.length ? ' وغيرهم' : ''}.`;
    return host.storage.transactionSync(() => send(host, owner, phoneNumberId, `handoff_digest:${day}`, `${w.count}`, summary, now));
  } catch (err) {
    alert('handoff_digest_failed', { workspace: host.workspaceId, error: errClass(err) });
    return 'unreachable';
  }
}

/** Arms the next digest if none is pending (idempotent). Called when an owner number is saved and on every handoff; the task re-arms itself while a number is set. */
export const ensureDigestTask = (host: Pick<LinkHost, 'sql'>, now: number): void => {
  if (host.sql.exec("SELECT 1 FROM scheduled_tasks WHERE kind = 'handoff_digest'").toArray().length) return;
  addTask(host.sql, 'handoff_digest', nextLocalHour(now, DIGEST_HOUR_LOCAL, BACKUP_TIME_ZONE));
};
