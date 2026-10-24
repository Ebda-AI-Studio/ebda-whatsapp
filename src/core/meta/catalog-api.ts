import { z } from 'zod';

const TIMEOUT_MS = 20_000;
const MAX_PAGES = 200;
const GRAPH = 'https://graph.facebook.com/';

type Auth = { token: string; graphVersion: string; catalogId: string };
export type CatalogApiResult<T> = { ok: true; value: T } | { ok: false; message: string; retryable: boolean };

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
    res = await fetch(`${GRAPH}${a.graphVersion}/${a.catalogId}/items_batch`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({ item_type: 'PRODUCT_ITEM', allow_upsert: true, requests }),
    });
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
      res = await fetch(url, { headers: { authorization: `Bearer ${a.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
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
      res = await fetch(url, { headers: { authorization: `Bearer ${a.token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
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
