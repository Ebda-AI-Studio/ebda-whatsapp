import { z } from 'zod';
import { outboundStoreEventSchema } from '../api/store-events';
import { addTask } from '../scheduler';
import { storeLink } from '../store-link';
import type { LinkHost } from './host';
import type { StoreEventOutcome } from './events';
import { acceptVersion, rememberBuyerKey } from './order-store';
import { uuidFromKey } from './orders';
import { getState, putState } from './settings';

// Per-buyer state kept here (both removed by forgetBuyer on erasure): the newest Store consent change applied
// (entity_versions `consent:<buyerKey>`) and the last opt-out version we sent (store_state `optver:<buyerKey>`).
const consentEntity = (key: string) => `consent:${key}`;
const revokedKey = (key: string) => `revoked:${key}`;
const optVersionKey = (key: string) => `optver:${key}`;

/** Records marketing consent given at the Store, unless the contact opted out here (STOP always wins). Returns whether it was recorded. Call inside a transaction. */
function grantStoreConsent(host: LinkHost, waId: string, key: string, atMs: number): boolean {
  // A withdrawal wins ties: a grant must be STRICTLY newer than the last one recorded for this buyer (kept even when the buyer was unknown).
  const revoked = Number(getState(host, revokedKey(key)) ?? -1);
  if (atMs <= revoked) return false;
  return host.sql.exec(
    "UPDATE contacts SET consent_source = 'store_checkout', consent_at = ? WHERE wa_id = ? AND opted_out_at IS NULL AND (consent_at IS NULL OR consent_at <= ?)",
    atMs, waId, atMs,
  ).rowsWritten > 0;
}

/** A `cart.abandoned` attests the checkout opt-in (WA-CONSENT-1). Also remembers the buyer key so a later STOP can be reported. Call inside a transaction. */
export function recordCheckoutConsent(host: LinkHost, waId: string, key: string, atMs: number): void {
  host.sql.exec('INSERT OR IGNORE INTO contacts (wa_id) VALUES (?)', waId);
  rememberBuyerKey(host, waId, key);
  if (acceptVersion(host, consentEntity(key), atMs)) grantStoreConsent(host, waId, key, atMs);
}

/** A withdrawal is remembered per buyer even when no contact is known yet, so a later or out-of-order grant cannot undo it. Call inside a transaction. */
export function recordWithdrawal(host: LinkHost, key: string, atMs: number): void {
  const have = Number(getState(host, revokedKey(key)) ?? -1);
  if (atMs > have) putState(host, revokedKey(key), String(atMs));
}

/** `customer.consent_changed` for a contact we know. Newest wins per buyer; a WhatsApp STOP is never overridden. Call inside a transaction. */
export function applyConsentChanged(host: LinkHost, waId: string, key: string, optIn: boolean, atMs: number): StoreEventOutcome {
  if (!acceptVersion(host, consentEntity(key), atMs)) return { status: 'stale' };
  if (optIn) return grantStoreConsent(host, waId, key, atMs) ? { status: 'applied' } : { status: 'skipped', detail: 'opted_out' };
  host.sql.exec("UPDATE contacts SET consent_source = 'store_revoked', consent_at = NULL WHERE wa_id = ?", waId);
  return { status: 'applied' };
}

const optOutPayload = z.object({ buyerKey: z.string().min(1), optedOut: z.boolean(), at: z.number().int(), version: z.number().int().positive() });

/**
 * The opt-out state of a contact really changed (STOP / START on WhatsApp): schedule telling the Store, in the SAME transaction as the
 * change, so the event goes out only once the change is committed. Nothing when no buyer key is known for the contact. Call inside a transaction.
 */
export function noteOptOutChange(host: LinkHost, waId: string, optedOut: boolean, atMs: number, now: number): boolean {
  const key = host.sql.exec<{ buyer_key: string | null }>('SELECT buyer_key FROM contacts WHERE wa_id = ?', waId).toArray()[0]?.buyer_key;
  if (!key) return false;
  const version = Number(getState(host, optVersionKey(key)) ?? 0) + 1;
  putState(host, optVersionKey(key), String(version));
  addTask(host.sql, 'opt_out_push', now, { buyerKey: key, optedOut, at: atMs, version });
  return true;
}

/** Task runner: sends one `whatsapp.opt_out_changed`. The event id is derived from buyer + version, so a retry is idempotent. Throws when the queue is down. */
export async function pushOptOut(host: LinkHost, payload: string | null): Promise<void> {
  const p = optOutPayload.safeParse(JSON.parse(payload ?? 'null'));
  if (!p.success) {
    console.error(JSON.stringify({ alert: 'scheduled_task_invalid', kind: 'opt_out_push', workspace: host.workspaceId }));
    return;
  }
  const sink = storeLink().events(host.env);
  if (!sink) return; // the Store link is off
  const { buyerKey, optedOut, at, version } = p.data;
  await sink.send(outboundStoreEventSchema.parse({
    id: await uuidFromKey(`optout:${buyerKey}:${version}`), type: 'whatsapp.opt_out_changed', v: 1, storeId: host.workspaceId, occurredAt: new Date(at).toISOString(),
    data: { buyerKey, optedOut, at: new Date(at).toISOString(), version },
  }));
}

/** Erasure: drops everything kept per buyer (consent version, opt-out version, a pending opt-out push). Call inside a transaction. */
export function forgetBuyer(host: LinkHost, key: string | null | undefined): void {
  if (!key) return;
  host.sql.exec('DELETE FROM entity_versions WHERE entity = ?', consentEntity(key));
  host.sql.exec('DELETE FROM store_state WHERE key IN (?, ?)', optVersionKey(key), revokedKey(key));
  host.sql.exec("DELETE FROM scheduled_tasks WHERE kind = 'opt_out_push' AND json_extract(payload, '$.buyerKey') = ?", key);
}
