import { z } from 'zod';
import { fetchWithTimeout } from '../net/fetch-with-timeout';

const TIMEOUT_MS = 20_000;
const MAX_PAGES = 200;
const GRAPH = 'https://graph.facebook.com/';

type Auth = { token: string; graphVersion: string; catalogId: string };
export type CatalogApiResult<T> = { ok: true; value: T } | { ok: false; message: string; retryable: boolean; code?: number };

export type CatalogRequest = { method: 'UPDATE' | 'DELETE'; data: Record<string, unknown> };

const batchAnswer = z.object({
  handles: z.array(z.string()).optional(),
  // Meta answers HTTP 200 and reports a rejected item here: inspecting only the status code would call it a success.
  validation_status: z.array(z.object({ errors: z.array(z.object({ message: z.string().optional() }).loose()).optional(), warnings: z.array(z.unknown()).optional() }).loose()).optional(),
}).loose();

/** Upserts or archives up to ~100 items. Any item-level validation error fails the batch (it would otherwise vanish silently). */
export async function itemsBatch(a: Auth, requests: CatalogRequest[]): Promise<CatalogApiResult<{ handle: string | null }>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${GRAPH}${a.graphVersion}/${a.catalogId}/items_batch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ item_type: 'PRODUCT_ITEM', allow_upsert: true, requests }),
    }, { label: 'meta.catalog.batch', timeoutMs: TIMEOUT_MS });
  } catch (err) {
    return { ok: false, message: `network: ${(err as Error).message}`, retryable: true };
  }
  const json = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) return { ok: false, message: json?.error?.message ?? `http ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
  const parsed = batchAnswer.safeParse(json);
  const errors = parsed.success ? (parsed.data.validation_status ?? []).flatMap((v) => v.errors ?? []) : [];
  if (errors.length) return { ok: false, message: `validation: ${errors[0]?.message ?? 'rejected'}`.slice(0, 200), retryable: false };
  return { ok: true, value: { handle: parsed.success ? (parsed.data.handles?.[0] ?? null) : null } };
}

/** Every retailer id currently in the catalog (follows paging, only ever to Graph itself). */
export async function listRetailerIds(a: Auth): Promise<CatalogApiResult<string[]>> {
  const out: string[] = [];
  let url: string | null = `${GRAPH}${a.graphVersion}/${a.catalogId}/products?fields=retailer_id&limit=100`;
  for (let page = 0; url && page < MAX_PAGES; page++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${a.token}` } }, { label: 'meta.catalog.get', timeoutMs: TIMEOUT_MS });
    } catch (err) {
      return { ok: false, message: `network: ${(err as Error).message}`, retryable: true };
    }
    const json = (await res.json().catch(() => null)) as { data?: { retailer_id?: string }[]; paging?: { next?: string }; error?: { message?: string } } | null;
    if (!res.ok || !json?.data) return { ok: false, message: json?.error?.message ?? `http ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
    for (const p of json.data) if (p.retailer_id) out.push(p.retailer_id);
    const next = json.paging?.next ?? null;
    // The bearer token goes wherever this URL points: never off Graph.
    url = next && next.startsWith(GRAPH) ? next : null;
  }
  if (url) return { ok: false, message: 'too many catalog pages', retryable: false };
  return { ok: true, value: out };
}

/** The catalogs connected to a WhatsApp Business Account. A catalog id is trusted only if it is in this list. */
export async function listWabaCatalogs(a: { token: string; graphVersion: string; wabaId: string }): Promise<CatalogApiResult<string[]>> {
  const out: string[] = [];
  let url: string | null = `${GRAPH}${a.graphVersion}/${a.wabaId}/product_catalogs?fields=id&limit=100`;
  for (let page = 0; url && page < 20; page++) {
    let res: Response;
    try {
      res = await fetchWithTimeout(url, { headers: { authorization: `Bearer ${a.token}` } }, { label: 'meta.catalog.get', timeoutMs: TIMEOUT_MS });
    } catch (err) {
      return { ok: false, message: `network: ${(err as Error).message}`, retryable: true };
    }
    const json = (await res.json().catch(() => null)) as { data?: { id?: string }[]; paging?: { next?: string }; error?: { message?: string } } | null;
    if (!res.ok || !json?.data) return { ok: false, message: json?.error?.message ?? `http ${res.status}`, retryable: res.status >= 500 || res.status === 429 };
    for (const c of json.data) if (c.id) out.push(c.id);
    const next = json.paging?.next ?? null;
    url = next && next.startsWith(GRAPH) ? next : null;
  }
  return { ok: true, value: out };
}

type Edge = { token: string; graphVersion: string };
const numericId = z.string().regex(/^\d{5,25}$/);

/** One Graph call that answers JSON; the error code Meta reports travels with the failure so callers can tell a missing permission from an outage. */
async function graph<T>(a: Edge, path: string, schema: z.ZodType<T>, init: { method: 'GET' } | { method: 'POST'; body: unknown } = { method: 'GET' }): Promise<CatalogApiResult<T>> {
  let res: Response;
  try {
    res = await fetchWithTimeout(`${GRAPH}${a.graphVersion}/${path}`, {
      method: init.method,
      headers: { authorization: `Bearer ${a.token}`, ...(init.method === 'POST' ? { 'content-type': 'application/json' } : {}) },
      ...(init.method === 'POST' ? { body: JSON.stringify(init.body) } : {}),
    }, { label: 'meta.catalog.graph', timeoutMs: TIMEOUT_MS });
  } catch (err) {
    return { ok: false, message: `network: ${(err as Error).message}`, retryable: true };
  }
  const json = (await res.json().catch(() => null)) as { error?: { code?: number; message?: string } } | null;
  if (!res.ok) return { ok: false, message: json?.error?.message ?? `http ${res.status}`, retryable: res.status >= 500 || res.status === 429, ...(json?.error?.code !== undefined ? { code: json.error.code } : {}) };
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message: 'unexpected answer', retryable: false };
}

/** Creates a commerce catalog owned by a business (`POST /{business_id}/owned_product_catalogs`, `name` required, `vertical` default commerce). */
export const createCatalog = (a: Edge & { businessId: string; name: string }): Promise<CatalogApiResult<{ id: string }>> =>
  graph(a, `${a.businessId}/owned_product_catalogs`, z.object({ id: numericId }).loose(), { method: 'POST', body: { name: a.name, vertical: 'commerce' } });

/** The catalogs a business owns, by id and name (used to find one whose create answer was lost). */
export async function listOwnedCatalogs(a: Edge & { businessId: string }): Promise<CatalogApiResult<{ id: string; name: string }[]>> {
  const out: { id: string; name: string }[] = [];
  let url: string | null = `${a.businessId}/owned_product_catalogs?fields=id,name&limit=100`;
  for (let page = 0; url && page < 20; page++) {
    const res: CatalogApiResult<{ data: { id: string; name?: string }[]; paging?: { next?: string } }> = await graph(a, url, z.object({ data: z.array(z.object({ id: z.string(), name: z.string().optional() }).loose()), paging: z.object({ next: z.string().optional() }).loose().optional() }).loose());
    if (!res.ok) return res;
    for (const c of res.value.data) out.push({ id: c.id, name: c.name ?? '' });
    const next: string | undefined = res.value.paging?.next;
    // the cursor URL is absolute; keep only the part after the version, and only if it points at Graph
    url = next && next.startsWith(GRAPH) ? next.slice(GRAPH.length).replace(/^v[\d.]+\//, '') : null;
  }
  return { ok: true, value: out };
}

/** Connects a catalog to a WhatsApp Business Account (`POST /{waba_id}/product_catalogs`, `catalog_id` required; answer `{ success }`). */
export async function connectCatalogToWaba(a: Edge & { wabaId: string; catalogId: string }): Promise<CatalogApiResult<true>> {
  const res = await graph(a, `${a.wabaId}/product_catalogs`, z.object({ success: z.boolean() }).loose(), { method: 'POST', body: { catalog_id: a.catalogId } });
  if (!res.ok) return res;
  return res.value.success ? { ok: true, value: true } : { ok: false, message: 'Meta did not confirm the connection', retryable: true };
}

/** The WhatsApp Business Accounts a business owns (`GET /{business_id}/owned_whatsapp_business_accounts`): proves which business a WABA belongs to. */
export async function listOwnedWabas(a: Edge & { businessId: string }): Promise<CatalogApiResult<string[]>> {
  const out: string[] = [];
  let url: string | null = `${a.businessId}/owned_whatsapp_business_accounts?fields=id&limit=100`;
  for (let page = 0; url && page < 20; page++) {
    const res: CatalogApiResult<{ data: { id: string }[]; paging?: { next?: string } }> = await graph(a, url, z.object({ data: z.array(z.object({ id: z.string() }).loose()), paging: z.object({ next: z.string().optional() }).loose().optional() }).loose());
    if (!res.ok) return res;
    for (const w of res.value.data) out.push(w.id);
    const next: string | undefined = res.value.paging?.next;
    url = next && next.startsWith(GRAPH) ? next.slice(GRAPH.length).replace(/^v[\d.]+\//, '') : null;
  }
  return { ok: true, value: out };
}
