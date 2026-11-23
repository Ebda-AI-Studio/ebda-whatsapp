/**
 * PDPL 151/2020 erasure: the shared types and the completeness helper (F9). Each product keeps its own registry of tables; this owns
 * the vocabulary (subjects, surfaces, results) and the check that no table holding personal data is missing from the registry.
 */
export interface MerchantSubject {
  kind: 'merchant';
  requestId: string;
  storeId: string;
  /** The owner's identity user id. */
  ownerUserId: string;
  staffUserIds?: string[];
}

export interface CustomerSubject {
  kind: 'customer';
  requestId: string;
  /** HMAC-SHA256(buyer-key secret, E.164 phone): the key both products share (see `buyer`). */
  buyerKey: string;
  phoneE164?: string;
  email?: string;
  userId?: string;
  storeIds?: string[];
}

export type Subject = MerchantSubject | CustomerSubject;

export interface SurfaceResult {
  surface: string;
  erased: number;
  /** Records still matching the subject after the erase. Anything above 0 fails the job. */
  remaining: number;
  note?: string;
}

export interface ExportPart { surface: string; ndjson: string; records: number }

export interface ErasureSurface {
  readonly name: string;
  exportSubject(s: Subject): Promise<ExportPart>;
  eraseSubject(s: Subject): Promise<SurfaceResult>;
}

/** The job is complete only when every surface ran and none has records left. */
export function erasureOutcome(surfaces: readonly string[], results: readonly SurfaceResult[]): { complete: boolean; missing: string[]; failed: string[] } {
  const done = new Set(results.map((r) => r.surface));
  const missing = surfaces.filter((s) => !done.has(s));
  const failed = results.filter((r) => r.remaining > 0).map((r) => r.surface);
  return { complete: missing.length === 0 && failed.length === 0, missing, failed };
}

/** Column names that identify a person. A table with one of them must be classified (erased, scrubbed or exempt with a reason). */
export const PERSONAL_COLUMN = /^(?:phone|phone_e164|wa_id|buyer_key|customer_phone|customer_email|email|user_id|customer_id)$/i;

/** Tables of the live schema with no registry entry (a customer subject must refuse while any exists: fail closed). */
export const unclassifiedTables = (live: readonly string[], registry: Readonly<Record<string, unknown>>): string[] => live.filter((t) => !(t in registry));

/**
 * Tables that hold a personal column but are neither a target nor exempt WITH A REASON: the completeness test of the checklist.
 * `columns` = table -> its column names (from the live schema); `targets` = tables the erasure deletes or scrubs;
 * `exempt` = table -> why it stays (an empty reason does not count).
 */
export function unlistedPersonalTables(
  columns: Readonly<Record<string, readonly string[]>>,
  targets: readonly string[],
  exempt: Readonly<Record<string, string>>,
  isPersonal: (column: string) => boolean = (c) => PERSONAL_COLUMN.test(c),
): string[] {
  const listed = new Set(targets);
  return Object.entries(columns)
    .filter(([t, cols]) => cols.some(isPersonal) && !listed.has(t) && !(exempt[t] && exempt[t]!.trim()))
    .map(([t]) => t)
    .sort();
}

/** A scrub that keeps the row must overwrite every column the subject is matched on, else the row still identifies the person. */
export function scrubGaps(match: Readonly<Record<string, string | undefined>>, scrub: Readonly<Record<string, unknown>> | undefined): string[] {
  const cols = Object.values(match).filter((c): c is string => typeof c === 'string');
  return cols.filter((c) => !(scrub && c in scrub));
}
