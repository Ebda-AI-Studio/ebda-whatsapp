import { z } from 'zod';
import { provisionCatalogRequest } from '../api/contract';
import { connectCatalogToWaba, createCatalog, listOwnedCatalogs, listOwnedWabas, type CatalogApiResult } from '../meta/catalog-api';
import { ownGraphTokenFor, TokenUnavailable } from '../numbers/token';
import { bridgeFor } from '../store-link';
import { catalogBelongsToWaba } from './catalog';
import type { LinkHost } from './host';
import { getState, putState, readSettings } from './settings';

export const CATALOG_NAME_MAX = 100;
export const provisionRequest = provisionCatalogRequest;

export type ProvisionFailure = 'missing_permission' | 'no_business' | 'meta_error' | 'business_mismatch' | 'already_set' | 'no_name';
export type ProvisionResult = { ok: true; catalogId: string } | { ok: false; code: ProvisionFailure; retryable: boolean };

/** Meta's "permissions error" (200), "permission denied" (10), an invalid/expired token (190): the merchant must reconnect and grant catalog access. */
const PERMISSION_CODES = new Set([10, 190, 200]);
const isPermission = (r: Extract<CatalogApiResult<unknown>, { ok: false }>): boolean => r.code !== undefined && PERMISSION_CODES.has(r.code);

/** The pending provision of this workspace: written before Meta is called, so a retry reuses it instead of creating a second catalog. */
const pendingSchema = z.object({ name: z.string(), businessId: z.string(), wabaId: z.string(), catalogId: z.string().optional() });
type Pending = z.infer<typeof pendingSchema>;
const PENDING_KEY = 'catalog.provision';
const readPending = (host: LinkHost): Pending | null => {
  const raw = getState(host, PENDING_KEY);
  if (!raw) return null;
  try {
    const p = pendingSchema.safeParse(JSON.parse(raw));
    return p.success ? p.data : null;
  } catch {
    return null;
  }
};
const clearPending = (host: LinkHost): void => {
  host.sql.exec('DELETE FROM store_state WHERE key = ?', PENDING_KEY);
};

/**
 * Creates a Meta product catalog for the business that owns the WABA, connects it to the WABA and saves it as the catalog
 * (through the same verification the settings PATCH uses). Idempotent: the pending record is stored first; a retry skips the
 * create when the id is known, and looks the catalog up by name when the create answer was lost.
 * `businessId` and `wabaId` come from the workspace's own Embedded Signup credential (the caller reads them from D1).
 */
export async function provisionCatalog(host: LinkHost, a: { name?: string; wabaId: string; businessId: string }, save: (catalogId: string, wabaId: string) => void): Promise<ProvisionResult> {
  if (readSettings(host).catalogId) return { ok: false, code: 'already_set', retryable: false };
  let name = a.name;
  if (!name) {
    const profile = await bridgeFor(host.env)?.getStoreProfile(host.workspaceId);
    name = profile?.ok ? profile.value.name.trim().slice(0, CATALOG_NAME_MAX) : undefined;
  }
  const pending0 = readPending(host);
  // A retry keeps the name it started with, so the lookup by name finds what the lost attempt created.
  name = pending0?.businessId === a.businessId && pending0.wabaId === a.wabaId ? pending0.name : name;
  if (!name) return { ok: false, code: 'no_name', retryable: false };

  let token: string;
  try {
    token = await ownGraphTokenFor(host.env, a.wabaId);
  } catch (err) {
    if (err instanceof TokenUnavailable) return { ok: false, code: 'missing_permission', retryable: false };
    throw err;
  }
  const auth = { token, graphVersion: host.env.META_GRAPH_VERSION };
  const fail = (r: Extract<CatalogApiResult<unknown>, { ok: false }>): ProvisionResult => {
    if (isPermission(r)) {
      clearPending(host);
      return { ok: false, code: 'missing_permission', retryable: false };
    }
    console.error(JSON.stringify({ alert: 'catalog_provision_failed', workspace: host.workspaceId, retryable: r.retryable, code: r.code ?? null }));
    return { ok: false, code: 'meta_error', retryable: r.retryable };
  };

  // The business id came from the browser at connect: only use it once Meta, asked with the merchant's own token, says that business owns this WABA.
  const owns = await listOwnedWabas({ ...auth, businessId: a.businessId });
  if (!owns.ok) return fail(owns);
  if (!owns.value.includes(a.wabaId)) {
    console.error(JSON.stringify({ alert: 'catalog_business_mismatch', workspace: host.workspaceId }));
    clearPending(host);
    return { ok: false, code: 'business_mismatch', retryable: false };
  }

  let pending: Pending = pending0 && pending0.name === name && pending0.businessId === a.businessId && pending0.wabaId === a.wabaId ? pending0 : { name, businessId: a.businessId, wabaId: a.wabaId };
  if (pending !== pending0) putState(host, PENDING_KEY, JSON.stringify(pending));

  if (!pending.catalogId) {
    // The create answer of an earlier attempt may have been lost: adopt the catalog it made rather than make a second one.
    const known = pending0 ? await listOwnedCatalogs({ ...auth, businessId: a.businessId }) : null;
    if (known && !known.ok) return fail(known);
    let id = known?.ok ? known.value.find((c) => c.name === pending.name)?.id : undefined;
    if (!id) {
      const made = await createCatalog({ ...auth, businessId: a.businessId, name: pending.name });
      if (!made.ok) return fail(made);
      id = made.value.id;
    }
    pending = { ...pending, catalogId: id };
    putState(host, PENDING_KEY, JSON.stringify(pending));
  }

  const catalogId = pending.catalogId!;
  const state = await catalogBelongsToWaba(host.env, a.wabaId, catalogId);
  if (state === 'unavailable') return { ok: false, code: 'meta_error', retryable: true };
  if (state === 'no') {
    const linked = await connectCatalogToWaba({ ...auth, wabaId: a.wabaId, catalogId });
    if (!linked.ok) return fail(linked);
    if ((await catalogBelongsToWaba(host.env, a.wabaId, catalogId)) !== 'yes') return { ok: false, code: 'meta_error', retryable: true };
  }
  save(catalogId, a.wabaId);
  clearPending(host);
  return { ok: true, catalogId };
}
