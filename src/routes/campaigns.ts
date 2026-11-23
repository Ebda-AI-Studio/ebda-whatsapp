import { Hono } from 'hono';
import { campaignCreate, campaignReportQuery, listCampaignsQuery, sendCampaignRequest } from '../core/api/contract';
import { campaignReportCsv } from '../core/campaigns/report';
import { activeNumber, apiError, workspaceStub, type ApiContext, type ApiEnv, managesStore } from './shared';

export const campaignsRoutes = new Hono<ApiEnv>();

/** 403 plan_feature when the workspace's plan lacks campaigns (no entitlement = lacks). Read from the workspace's own copy on every call. */
async function campaignsDenied(c: ApiContext, ws: { planAllows(f: 'campaigns'): Promise<boolean> }): Promise<Response | null> {
  return (await ws.planAllows('campaigns')) ? null : c.json({ error: 'plan_feature', feature: 'campaigns' }, 403);
}

const owner = managesStore;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const idOf = (c: ApiContext): string | null => (UUID.test(c.req.param('campaignId') ?? '') ? c.req.param('campaignId')! : null);

type Refusal = 'not_found' | 'bad_state' | 'invalid_schedule' | 'template_not_approved' | 'empty_audience' | 'number_restricted';
function refuse(c: ApiContext, reason: Refusal): Response {
  if (reason === 'not_found') return apiError(c, 404, 'not_found');
  if (reason === 'template_not_approved') return apiError(c, 409, 'template_not_approved');
  return apiError(c, 409, 'invalid_request', reason);
}

campaignsRoutes.get('/stores/:storeId/campaigns', async (c) => {
  const q = listCampaignsQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  if (!q.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const { cursor, status, limit } = q.data;
  return c.json(await ws.listCampaigns({ limit, ...(status ? { status } : {}), ...(cursor !== undefined ? { cursor: Number(cursor) } : {}) }));
});

campaignsRoutes.post('/stores/:storeId/campaigns', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const body = campaignCreate.safeParse(await c.req.json().catch(() => null));
  if (!body.success) return apiError(c, 400, 'invalid_request', body.error.issues[0]?.message);
  const ws = await workspaceStub(c);
  const number = await activeNumber(c);
  if (!ws) return apiError(c, 404, 'not_found');
  if (!number) return apiError(c, 409, 'invalid_request', 'no_active_number');
  const denied = await campaignsDenied(c, ws);
  if (denied) return denied;
  const r = await ws.createCampaign({ ...body.data, phoneNumberId: number.phoneNumberId, actor: c.get('principal').userId });
  if (r.ok) return c.json(r.campaign, 201);
  if (r.reason === 'segment_not_found') return apiError(c, 404, 'not_found', r.reason);
  if (r.reason === 'template_not_approved') return apiError(c, 409, 'template_not_approved');
  return apiError(c, 400, 'invalid_request', r.message ?? r.reason);
});

campaignsRoutes.get('/stores/:storeId/campaigns/:campaignId', async (c) => {
  const id = idOf(c);
  const ws = await workspaceStub(c);
  const camp = id && ws && (await ws.getCampaign(id));
  return camp ? c.json(camp) : apiError(c, 404, 'not_found');
});

/** The campaign's compliance report (counts and skip reasons, no phone numbers), as JSON or a CSV file. Owner only: it is the proof for Meta, not a staff screen. */
campaignsRoutes.get('/stores/:storeId/campaigns/:campaignId/report', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const q = campaignReportQuery.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
  const id = idOf(c);
  if (!q.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  const report = id && ws && (await ws.getCampaignReport(id));
  if (!report) return apiError(c, 404, 'not_found');
  c.header('cache-control', 'no-store');
  if (q.data.format === 'csv') return new Response(campaignReportCsv(report), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="campaign-report-${report.campaign.id.slice(0, 8)}.csv"`, 'cache-control': 'no-store' } });
  return c.json(report);
});

campaignsRoutes.delete('/stores/:storeId/campaigns/:campaignId', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const id = idOf(c);
  const ws = await workspaceStub(c);
  if (!id || !ws) return apiError(c, 404, 'not_found');
  const r = await ws.deleteCampaignDraft(id);
  return r === 'deleted' ? c.body(null, 204) : refuse(c, r);
});

/** Starts the campaign now or at `scheduledAt`. Spending money: owner only. */
campaignsRoutes.post('/stores/:storeId/campaigns/:campaignId/send', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const id = idOf(c);
  const body = sendCampaignRequest.safeParse(await c.req.json().catch(() => ({})));
  if (!id || !body.success) return apiError(c, 400, 'invalid_request');
  const ws = await workspaceStub(c);
  if (!ws) return apiError(c, 404, 'not_found');
  const denied = await campaignsDenied(c, ws);
  if (denied) return denied;
  const r = await ws.sendCampaign(id, body.data.scheduledAt);
  return r.ok ? c.json(r.campaign, 202) : refuse(c, r.reason);
});

// Stopping is the safe direction, so staff may pause and cancel; resuming spends money again, so only the owner.
campaignsRoutes.post('/stores/:storeId/campaigns/:campaignId/pause', async (c) => {
  const id = idOf(c);
  const ws = await workspaceStub(c);
  if (!id || !ws) return apiError(c, 404, 'not_found');
  const r = await ws.pauseCampaign(id);
  return r.ok ? c.json(r.campaign) : refuse(c, r.reason);
});

campaignsRoutes.post('/stores/:storeId/campaigns/:campaignId/resume', async (c) => {
  if (!owner(c)) return apiError(c, 403, 'forbidden');
  const id = idOf(c);
  const ws = await workspaceStub(c);
  if (!id || !ws) return apiError(c, 404, 'not_found');
  const denied = await campaignsDenied(c, ws);
  if (denied) return denied;
  const r = await ws.resumeCampaign(id);
  return r.ok ? c.json(r.campaign) : refuse(c, r.reason);
});

campaignsRoutes.post('/stores/:storeId/campaigns/:campaignId/cancel', async (c) => {
  const id = idOf(c);
  const ws = await workspaceStub(c);
  if (!id || !ws) return apiError(c, 404, 'not_found');
  const r = await ws.cancelCampaign(id);
  return r.ok ? c.json(r.campaign) : refuse(c, r.reason);
});
