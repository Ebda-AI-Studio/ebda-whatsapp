import { Hono } from 'hono';
import { listContactsQuery, setContactTagsRequest } from '../core/api/contract';
import { normaliseE164 } from '../core/phone';
import { apiError, workspaceStub, type ApiEnv } from './shared';

export const contactsRoutes = new Hono<ApiEnv>();

/** A customer's WhatsApp id from a route: digits (any country) or any form `normaliseE164` accepts. */
export function waIdParam(raw: string): string | null {
  if (/^[1-9]\d{7,14}$/.test(raw)) return raw;
  return normaliseE164(raw)?.slice(1) ?? null;
}

contactsRoutes.get('/stores/:storeId/contacts', async (c) => {
  const q = listContactsQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!q.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const { cursor, ...rest } = q.data;
  return c.json(await ws.listContacts({ ...rest, ...(cursor !== undefined ? { cursor: Number(cursor) } : {}) }));
});

contactsRoutes.put('/stores/:storeId/contacts/:waId/tags', async (c) => {
  const body = setContactTagsRequest.safeParse(await c.req.json().catch(() => null));
  const waId = waIdParam(c.req.param('waId'));
  if (!body.success || !waId) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const out = await ws.setContactTags(waId, [...new Set(body.data.tags.map((t) => t.toLowerCase()))]);
  return out ? c.json(out) : apiError(c, 404, 'not_found');
});
