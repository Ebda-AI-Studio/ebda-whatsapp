import { Hono } from 'hono';
import { consentEvidenceQuery, exportContactQuery, exportContactsQuery, listContactsQuery, mergeContactsRequest, renameContactRequest, setContactTagsRequest } from '../core/api/contract';
import { recordAudit } from '../core/audit';
import { consentEvidenceCsv } from '../core/campaigns/report';
import { subjectHash } from '../core/erasure';
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

/**
 * Self-service export of ALL the store's own contacts (the merchant is the controller of that data): owner only, a page of at most 500 per call, no filters (it is the whole list).
 * Every page read is audited with its size and cursor, never a number or a name. An operator session is refused: an operator uses the operator route with a stated reason.
 */
contactsRoutes.get('/stores/:storeId/contacts/export', async (c) => {
  if (c.get('storeRole') !== 'owner') return apiError(c, 403, 'forbidden');
  const q = exportContactsQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!q.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const out = await ws.listContacts({ limit: q.data.limit, ...(q.data.cursor !== undefined ? { cursor: Number(q.data.cursor) } : {}) });
  await recordAudit(c.env, { workspaceId: c.req.param('storeId')!, actor: c.get('principal').userId, role: 'owner', action: 'contacts.export_all', targetType: 'workspace', targetId: c.req.param('storeId')!, detail: { count: out.items.length, cursor: q.data.cursor ?? null } });
  c.header('cache-control', 'no-store');
  return c.json(out);
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

const ownerOnly = (role: string) => role === 'owner' || role === 'super_admin';

/** Data-subject export (B5): one contact's data as JSON, a page of messages at a time. Owner only; every read is audited by the keyed hash, never the number. */
contactsRoutes.get('/stores/:storeId/contacts/:waId/export', async (c) => {
  // The owner alone. An operator uses the operator route, which needs a stated reason and audits it.
  if (c.get('storeRole') !== 'owner') return apiError(c, 403, 'forbidden');
  const waId = waIdParam(c.req.param('waId'));
  const q = exportContactQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!waId || !q.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const out = await ws.exportContact(waId, q.data.after, q.data.limit);
  if (!out) return apiError(c, 404, 'not_found');
  const storeId = c.req.param('storeId')!;
  await recordAudit(c.env, { workspaceId: storeId, actor: c.get('principal').userId, role: 'owner', action: 'contact.export', targetType: 'waId', targetId: await subjectHash(c.env, storeId, waId), detail: { messages: out.messages.length, after: q.data.after } });
  c.header('cache-control', 'no-store');
  return c.json(out);
});

/** The consent / opt-out record of every customer, for Meta or for the owner's own files (compliance.opt-out-evidence). Owner only, paged, audited by count (never by number). */
contactsRoutes.get('/stores/:storeId/contacts/consent-evidence', async (c) => {
  if (c.get('storeRole') !== 'owner') return apiError(c, 403, 'forbidden');
  const q = consentEvidenceQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!q.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const out = await ws.getConsentEvidence(q.data.after, q.data.limit);
  await recordAudit(c.env, { workspaceId: c.req.param('storeId')!, actor: c.get('principal').userId, role: 'owner', action: 'contacts.consent-evidence', detail: { rows: out.items.length, after: q.data.after } });
  if (q.data.format === 'csv') return new Response(consentEvidenceCsv(out), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="consent-evidence.csv"', 'cache-control': 'no-store', ...(out.nextAfter !== null ? { 'x-next-after': String(out.nextAfter) } : {}) } });
  c.header('cache-control', 'no-store');
  return c.json(out);
});

/** A name the merchant gives a contact (owner or staff). */
contactsRoutes.patch('/stores/:storeId/contacts/:waId', async (c) => {
  const body = renameContactRequest.safeParse(await c.req.json().catch(() => null));
  const waId = waIdParam(c.req.param('waId'));
  if (!body.success || !waId) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const out = await ws.renameContact(waId, body.data.name);
  return out ? c.json(out) : apiError(c, 404, 'not_found');
});

/** The same person on a new number: fold one contact into the other. Owner only (it cannot be undone). */
contactsRoutes.post('/stores/:storeId/contacts/merge', async (c) => {
  if (!ownerOnly(c.get('storeRole'))) return apiError(c, 403, 'forbidden');
  const body = mergeContactsRequest.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const out = await ws.mergeContacts(body.data.fromWaId, body.data.intoWaId);
  return out ? c.json(out) : apiError(c, 404, 'not_found');
});
