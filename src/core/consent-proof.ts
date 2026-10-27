/**
 * The proof behind a consent (iceberg A4, M-089): who attested, the exact wording shown, when, and through which door. One row per grant,
 * append-only, erased with the contact. `contacts.consent_source/consent_at` stay the state that gates sending; this is the evidence.
 */
type Sql = Pick<DurableObjectStorage, 'sql'>['sql'];

export type ConsentProofSource = 'import' | 'opt_in' | 'link';
export type ConsentProof = { source: ConsentProofSource; attestedBy: string; wording: string; at: number; ref: string | null };

/** Recorded when a client ticks "consented" on an import without sending the wording its screen showed. */
export const DEFAULT_IMPORT_WORDING = 'The sender confirms that these customers agreed to receive marketing messages from them on WhatsApp, and that they can prove it.';
/** The Store sends the fact of a checkout opt-in, not the wording shown at checkout (contract gap, see docs/campaigns.md). */
export const STORE_CHECKOUT_WORDING = 'Marketing opt-in at the Store checkout (wording not provided by the Store).';
export const MAX_WORDING_CHARS = 500;

export function recordConsentProof(sql: Sql, p: { contactId: number; source: ConsentProofSource; attestedBy: string; wording: string; at: number; ref?: string | null }): void {
  sql.exec(
    'INSERT INTO consent_proofs (contact_id, source, attested_by, wording, at, ref) VALUES (?, ?, ?, ?, ?, ?)',
    p.contactId, p.source, p.attestedBy.slice(0, 120), p.wording.slice(0, MAX_WORDING_CHARS), p.at, p.ref ?? null,
  );
}

/** The newest proof of each contact, by contact id. */
export function latestProofs(sql: Sql, contactIds: number[]): Map<number, ConsentProof> {
  const out = new Map<number, ConsentProof>();
  if (!contactIds.length) return out;
  const rows = sql.exec<{ contact_id: number; source: ConsentProofSource; attested_by: string; wording: string; at: number; ref: string | null }>(
    `SELECT contact_id, source, attested_by, wording, at, ref FROM consent_proofs WHERE id IN (SELECT max(id) FROM consent_proofs WHERE contact_id IN (${contactIds.map(() => '?').join(',')}) GROUP BY contact_id)`,
    ...contactIds,
  ).toArray();
  for (const r of rows) out.set(r.contact_id, { source: r.source, attestedBy: r.attested_by, wording: r.wording, at: r.at, ref: r.ref });
  return out;
}
