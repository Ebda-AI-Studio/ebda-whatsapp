/**
 * Verifier helpers for the Store <-> Chat contract (contracts/wa-v1.ts, which stays byte-identical to what both products carried
 * before F5: the sha below is the proof). Kept in a separate file so the contract file itself never changes by a helper.
 */
import { outboundStoreEventSchema, storeEnvelopeSchema, type OutboundStoreEvent } from './wa-v1';

/** sha256 of contracts/wa-v1.ts at contract v1.6 (Ruling WA-CONTRACT-1: both products carried these exact bytes). */
export const WA_V1_CONTRACT_SHA256 = '4fbfb22194b16b5d0becaff7e201251dc0d11ed754b2c626ae01b5f9bee9ee3d';

export type ParsedOutboundStoreEvent =
  | { ok: true; event: OutboundStoreEvent }
  | { ok: false; reason: 'invalid' | 'unknown_type' | 'unsupported_version' };

/** The mirror of `parseStoreEvent` for events Chat sends to the Store (the Store dedupes on `id`, drops an unknown type, never throws). */
export function parseOutboundStoreEvent(raw: unknown): ParsedOutboundStoreEvent {
  const env = storeEnvelopeSchema.safeParse(raw);
  if (!env.success) return { ok: false, reason: 'invalid' };
  if (env.data.v !== 1) return { ok: false, reason: 'unsupported_version' };
  if (!outboundStoreEventSchema.options.some((o) => o.shape.type.value === env.data.type)) return { ok: false, reason: 'unknown_type' };
  const full = outboundStoreEventSchema.safeParse(raw);
  return full.success ? { ok: true, event: full.data } : { ok: false, reason: 'invalid' };
}
