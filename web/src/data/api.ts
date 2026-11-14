import { z } from 'zod';
import {
  agentSettingsDto, apiError, assistantConversationResponse, assistantTurnResponse, digestDto, botFunnelDto, botSettingsDto, botSwitchesDto, settingsPreviewResponse, throttleReportDto, campaignDto, catalogStatusDto, catalogResyncResponse, catalogCommerceRequest, provisionCatalogResponse, customerOrdersResponse, eventsResponse, getMessagesResponse, importRejectsResponse, listCampaignsResponse,
  opsStatusDto, changeLogItemDto, costEstimateDto, listContactsResponse, listMembersResponse, seatResponse, listConversationsResponse, listNumbersResponse, numberDto, signupConfigDto, listImportsResponse, listSegmentsResponse, listTemplatesResponse, listSharedTemplatesResponse, listSharedRequestsResponse, sharedRequestDto, templateDto, checkTemplateResponse, createTemplateResponse, editTemplateResponse, messageDto, meResponse, offboardingDto, operatorOffboardingDto, auditLogItemDto, retentionDto, contactSummaryDto,
  instapayCreatedDto, sharedNumberDto, instapayRequestDto, instapayViewDto, operatorInstapayDto, operatorAutoListDto, packageDto, packageOrderDto, pricingSettingsDto, realtimeEvent, refundRequestDto, segmentPreviewDto, statementDto, topupDto, walletDto, type RealtimeEvent, type SendMessageRequest,
} from '../../../src/core/api/contract';
import type { RuleIssue } from '../../../src/core/meta/template-rules';
import { adjustmentDto, fxRateDto, marginOverrideDto, rateCardVersionDto } from './billing';
import type { InboxSource } from './source';

export class ApiError extends Error {
  /** `detail` = the server's machine reason for a 409 (e.g. `empty_audience`), when it sends one. */
  constructor(public readonly code: string, public readonly status: number, public readonly detail?: string, public readonly amountMinor?: number, public readonly extra?: { retryAt?: number; issues?: RuleIssue[] }) {
    super(code);
  }
}

type Opts = {
  baseUrl: string; storeId: string; getToken: () => Promise<string>;
  fetchImpl?: typeof fetch; userNames: Record<string, string>; currentUserId: string;
  /** T35: look at this workspace as an operator, read-only; `reason` is sent with every request and written to the audit log. */
  viewAs?: { reason: string };
};

/** The live inbox source: every response is validated against the shared contract. */
/** `noSeat` is set by loadCapabilities when the server refused this person for want of a seat (WA-SEATS-1): the app then shows the no-seat page instead of an inbox that cannot load. */
export type LiveSource = InboxSource & { noSeat?: 'none' | 'over_limit'; fetchEvents: (after: number) => Promise<z.infer<typeof eventsResponse>>; emit: (e: RealtimeEvent) => void; reload: () => void; loadCapabilities: () => Promise<void> };

export function createApiSource(o: Opts): LiveSource {
  const f = o.fetchImpl ?? fetch;
  const root = `${o.baseUrl}/api/v1/stores/${o.storeId}`;

  const operatorRoot = `${o.baseUrl}/api/v1/operator`;

  async function call<S extends z.ZodTypeAny>(path: string, schema: S, init: RequestInit = {}, base: string = root): Promise<z.infer<S>> {
    const headers = new Headers(init.headers);
    headers.set('authorization', `Bearer ${await o.getToken()}`);
    if (o.viewAs) { headers.set('x-view-as-merchant', '1'); headers.set('x-view-as-reason', o.viewAs.reason); }
    if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
    const res = await f(`${base}${path}`, { ...init, headers });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      const err = apiError.safeParse(json);
      throw new ApiError(err.success ? err.data.error : 'invalid_request', res.status, err.success ? err.data.message : undefined, err.success ? err.data.amountMinor : undefined, err.success && (err.data.retryAt !== undefined || err.data.issues) ? { ...(err.data.retryAt !== undefined ? { retryAt: err.data.retryAt } : {}), ...(err.data.issues ? { issues: err.data.issues as RuleIssue[] } : {}) } : undefined);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new Error(`response does not match the contract: ${path}`);
    return parsed.data;
  }

  const op = <S extends z.ZodTypeAny>(path: string, schema: S, init: RequestInit = {}) => call(path, schema, init, operatorRoot);
  const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
  const items = <S extends z.ZodTypeAny>(schema: S) => z.object({ items: z.array(schema) });
  const done = z.unknown();

  const listeners = new Set<(e: RealtimeEvent) => void>();
  const reloaders = new Set<() => void>();

  const source: LiveSource = {
    kind: 'live',
    ...(o.viewAs ? { viewAs: true } : {}),
    // Off until the server says the store link is bound (GET /me → capabilities): never offer an action that would 404.
    capabilities: { codOutcome: false },
    // Least privilege until GET /me answers: spending actions stay hidden.
    storeId: o.storeId,
    role: 'staff',
    currentUserId: o.currentUserId,
    userNames: o.userNames,
    async listConversations(filter, q, signal) {
      // One call: the server matches names, phone digits and message text, so the client never pages through the list to find hits.
      const query = q.trim();
      const params = new URLSearchParams({ filter, limit: '50' });
      if (query) params.set('q', query);
      return (await call(`/conversations?${params}`, listConversationsResponse, signal ? { signal } : {})).items;
    },
    async getMessages(id) {
      return (await call(`/conversations/${id}/messages?limit=50`, getMessagesResponse)).items.slice().sort((a, b) => a.at - b.at);
    },
    async send(id, req: SendMessageRequest) {
      return call(`/conversations/${id}/messages`, messageDto, { method: 'POST', body: JSON.stringify(req) });
    },
    async markRead(id) {
      await f(`${root}/conversations/${id}/read`, { method: 'POST', headers: { authorization: `Bearer ${await o.getToken()}` } });
    },
    async orders(waId) {
      return call(`/contacts/${encodeURIComponent(waId)}/orders`, customerOrdersResponse);
    },
    async templates() {
      // A store with no own number has no templates to pick from: that is an empty picker, not a failure (the Templates screen explains why).
      try { return (await call('/templates', listTemplatesResponse)).items; } catch (e) { if (e instanceof ApiError && e.status === 404 && e.detail === 'no_active_number') return []; throw e; }
    },
    templatesApi: {
      list: async () => { const r = await call('/templates', listTemplatesResponse); return { items: r.items, starterInstalled: r.starterInstalled === true }; },
      detail: (name, lang) => call(`/templates/${encodeURIComponent(name)}/${encodeURIComponent(lang)}`, templateDto),
      check: (d) => call('/templates/check', checkTemplateResponse, post(d)) as Promise<{ issues: RuleIssue[]; payloadHash: string }>,
      create: (d, expectedHash) => call('/templates', createTemplateResponse, post({ ...d, expectedHash })),
      edit: (name, lang, d, expectedHash) => call(`/templates/${encodeURIComponent(name)}/${encodeURIComponent(lang)}`, editTemplateResponse, { method: 'PUT', body: JSON.stringify({ ...d, expectedHash }) }),
      remove: async (name, lang) => {
        const res = await f(`${root}/templates/${encodeURIComponent(name)}/${encodeURIComponent(lang)}`, { method: 'DELETE', headers: { authorization: `Bearer ${await o.getToken()}` } });
        if (!res.ok) {
          const err = apiError.safeParse(await res.json().catch(() => null));
          throw new ApiError(err.success ? err.data.error : 'invalid_request', res.status, err.success ? err.data.message : undefined);
        }
      },
      sync: () => call('/templates/sync', z.object({ upserted: z.number(), removed: z.number() }), post({})),
      shared: {
        list: async () => (await call('/templates/shared', listSharedTemplatesResponse)).items,
        requests: async () => (await call('/templates/shared-requests', listSharedRequestsResponse)).items,
        request: (r) => call('/templates/shared-requests', sharedRequestDto, post(r)),
      },
      installDefaults: () => call('/templates/install-defaults', z.object({ submitted: z.array(z.string()), skipped: z.array(z.string()), failed: z.array(z.string()) }), post({})),
    },
    async recordCodOutcome(waId, orderNumber, outcome) {
      const headers = { authorization: `Bearer ${await o.getToken()}`, 'content-type': 'application/json' };
      const res = await f(`${root}/contacts/${encodeURIComponent(waId)}/orders/${encodeURIComponent(orderNumber)}/cod-outcome`, {
        method: 'POST', headers, keepalive: true, body: JSON.stringify({ outcome, idempotencyKey: crypto.randomUUID() }),
      });
      if (!res.ok) throw new ApiError('invalid_request', res.status);
    },
    async agentSettings() {
      try { return await call('/agent', agentSettingsDto); } catch (e) { if (e instanceof ApiError && (e.status === 403 || e.status === 404)) return null; throw e; }
    },
    async saveAgentSettings(update) {
      return call('/agent', agentSettingsDto, { method: 'PUT', body: JSON.stringify(update) });
    },
    async botSettings() {
      return call('/store-link/settings', botSettingsDto);
    },
    async saveBotSettings(update) {
      return call('/store-link/settings', botSettingsDto, { method: 'PATCH', body: JSON.stringify(update) });
    },
    switches: {
      get: () => call('/store-link/settings', botSwitchesDto),
      preview: (change) => call('/store-link/settings/preview', settingsPreviewResponse, post(change)),
      save: (change, confirmToken) => call('/store-link/settings', botSwitchesDto, { method: 'PATCH', body: JSON.stringify(confirmToken ? { ...change, confirmToken } : change) }),
      async throttle() {
        try { return await call('/throttle', throttleReportDto); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
      },
    },
    async botFunnel(days) {
      const day = (ms: number) => { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
      const now = Date.now();
      return call(`/bot/funnel?from=${day(now - (days - 1) * 86_400_000)}&to=${day(now)}`, botFunnelDto);
    },
    catalog: {
      status: () => call('/store-link/catalog', catalogStatusDto),
      provision: (name) => call('/store-link/catalog/provision', provisionCatalogResponse, post(name ? { name } : {})),
      resync: () => call('/store-link/catalog/resync', catalogResyncResponse, post({})),
      setCommerce: (v) => call('/store-link/catalog/commerce', catalogCommerceRequest, { method: 'PUT', body: JSON.stringify(v) }),
    },
    async assign(id, userId) {
      await call(`/conversations/${id}/assign`, z.unknown(), { method: 'POST', body: JSON.stringify({ userId }) });
    },
    campaigns: {
      list: async () => (await call('/campaigns?limit=50', listCampaignsResponse)).items,
      get: (id) => call(`/campaigns/${encodeURIComponent(id)}`, campaignDto),
      create: (req) => call('/campaigns', campaignDto, { method: 'POST', body: JSON.stringify(req) }),
      send: (id, scheduledAt) => call(`/campaigns/${encodeURIComponent(id)}/send`, campaignDto, { method: 'POST', body: JSON.stringify(scheduledAt ? { scheduledAt } : {}) }),
      pause: (id) => call(`/campaigns/${encodeURIComponent(id)}/pause`, campaignDto, { method: 'POST' }),
      resume: (id) => call(`/campaigns/${encodeURIComponent(id)}/resume`, campaignDto, { method: 'POST' }),
      cancel: (id) => call(`/campaigns/${encodeURIComponent(id)}/cancel`, campaignDto, { method: 'POST' }),
      async remove(id) {
        const res = await f(`${root}/campaigns/${encodeURIComponent(id)}`, { method: 'DELETE', headers: { authorization: `Bearer ${await o.getToken()}` } });
        if (!res.ok) throw new ApiError('invalid_request', res.status);
      },
      segments: async () => (await call('/segments', listSegmentsResponse)).items,
      preview: (criteria) => call('/segments/preview', segmentPreviewDto, { method: 'POST', body: JSON.stringify({ criteria }) }),
    },
    numbers: {
      list: async () => (await call('/numbers', listNumbersResponse)).items,
      notices: async () => (await call('/numbers', listNumbersResponse)).notices,
      dismissNotice: async (id) => { await call(`/numbers/notices/${id}/dismiss`, z.object({ ok: z.boolean() }).loose(), { method: 'POST' }); },
      async signupConfig() {
        try { return await call('/numbers/signup-config', signupConfigDto); } catch (e) { if (e instanceof ApiError && (e.status === 503 || e.status === 404 || e.status === 403)) return null; throw e; }
      },
      connect: async (req) => (await call('/numbers/connect', z.object({ number: numberDto }).loose(), { method: 'POST', body: JSON.stringify(req) })).number,
      refresh: async (id) => (await call(`/numbers/${encodeURIComponent(id)}/refresh`, z.object({ number: numberDto }).loose(), { method: 'POST' })).number,
      register: async (id) => (await call(`/numbers/${encodeURIComponent(id)}/register`, z.object({ number: numberDto }).loose(), { method: 'POST' })).number,
      disconnect: async (id) => (await call(`/numbers/${encodeURIComponent(id)}/disconnect`, z.object({ number: numberDto }).loose(), { method: 'POST' })).number,
      shared: {
        status: () => call('/shared-number', sharedNumberDto),
        join: (displayName) => call('/shared-number/join', sharedNumberDto, post(displayName ? { displayName } : {})),
        leave: () => call('/shared-number/leave', sharedNumberDto, post({})),
      },
    },
    assistant: {
      turn: (body) => call('/assistant/turn', assistantTurnResponse, post(body)),
      conversation: async (id) => (await call(`/assistant/conversations/${encodeURIComponent(id)}`, assistantConversationResponse)).items,
      feedback: async (turnId, thumb) => { await call('/assistant/feedback', z.object({ ok: z.boolean() }).loose(), post({ turnId, thumb })); },
    },
    team: {
      list: () => call('/members', listMembersResponse),
      assign: async (userId) => { await call(`/members/${encodeURIComponent(userId)}/seat`, seatResponse, { method: 'PUT' }); },
      unassign: async (userId) => {
        const res = await f(`${root}/members/${encodeURIComponent(userId)}/seat`, { method: 'DELETE', headers: { authorization: `Bearer ${await o.getToken()}` } });
        if (!res.ok) throw new ApiError('invalid_request', res.status);
      },
    },
    contacts: {
      async list(q, signal) {
        const p = new URLSearchParams({ limit: '50' });
        if (q.q?.trim()) p.set('q', q.q.trim());
        if (q.tag) p.set('tag', q.tag);
        if (q.optedOut !== undefined) p.set('optedOut', String(q.optedOut));
        if (q.cursor) p.set('cursor', q.cursor);
        return call(`/contacts?${p}`, listContactsResponse, signal ? { signal } : {});
      },
      async importCsv(file, consented, wording) {
        const form = new FormData();
        form.set('file', file);
        form.set('consented', consented ? 'true' : 'false');
        if (consented && wording) form.set('wording', wording); // the exact sentence the owner ticked (A4)
        return (await call('/imports', z.object({ id: z.string() }).loose(), { method: 'POST', body: form })).id;
      },
      imports: async () => (await call('/imports', listImportsResponse)).items,
      rejects: async (id) => (await call(`/imports/${encodeURIComponent(id)}/rejects`, importRejectsResponse)).items,
      renameContact: (waId, name) => call(`/contacts/${encodeURIComponent(waId)}`, contactSummaryDto, { method: 'PATCH', body: JSON.stringify({ name }) }),
      async exportContact(waId) {
        const page = z.object({ messages: z.array(z.unknown()), nextAfter: z.number().int().nullable() }).loose();
        let out = await call(`/contacts/${encodeURIComponent(waId)}/export?limit=500`, page);
        const messages = [...out.messages];
        while (out.nextAfter !== null) {
          out = await call(`/contacts/${encodeURIComponent(waId)}/export?limit=500&after=${out.nextAfter}`, page);
          messages.push(...out.messages);
        }
        return { ...out, messages, nextAfter: null };
      },
      mergeContacts: async (fromWaId, intoWaId) => { await call('/contacts/merge', z.unknown(), post({ fromWaId, intoWaId })); },
      retention: () => call('/retention', retentionDto),
      setRetention: (days) => call('/retention', retentionDto, { method: 'PUT', body: JSON.stringify({ days }) }),
    },
    wallet: {
      wallet: () => call('/wallet', walletDto),
      digest: () => call('/digest', digestDto),
      async setDigest(enabled) { await call('/digest', z.object({ enabled: z.boolean() }), { method: 'PUT', body: JSON.stringify({ enabled }) }); },
      statement: (month) => call(`/wallet/statement?month=${encodeURIComponent(month)}`, statementDto),
      async statementCsv(month) {
        const res = await f(`${root}/wallet/statement?month=${encodeURIComponent(month)}&format=csv`, { headers: { authorization: `Bearer ${await o.getToken()}` } });
        if (!res.ok) throw new ApiError('forbidden', res.status);
        return URL.createObjectURL(await res.blob());
      },
      estimate: (category, count) => call(`/wallet/estimate?category=${category}&count=${count}`, costEstimateDto),
      topup: (amountMinor) => call('/wallet/topups', topupDto, post({ amountMinor })),
      offboarding: () => call('/offboarding', offboardingDto),
      requestOffboarding: (opts) => call('/offboarding', offboardingDto, post({ confirm: true, ...opts })),
      cancelOffboarding: async () => { await call('/offboarding', done, { method: 'DELETE' }); },
      topupState: (orderId) => call(`/wallet/topups/${encodeURIComponent(orderId)}`, topupDto),
      packages: async () => (await call('/packages', items(packageDto))).items,
      buyPackage: (packageId) => call(`/packages/${encodeURIComponent(packageId)}/checkout`, packageOrderDto, post({})),
      packageOrderState: (orderId) => call(`/packages/orders/${encodeURIComponent(orderId)}`, packageOrderDto),
      instapay: () => call('/wallet/instapay', instapayViewDto),
      createInstapay: (input) => call('/wallet/instapay', instapayCreatedDto, post(input)),
      async uploadInstapayProof(requestId, file) {
        const res = await f(`${root}/wallet/instapay/${encodeURIComponent(requestId)}/proof`, { method: 'PUT', headers: { authorization: `Bearer ${await o.getToken()}`, 'content-type': file.type }, body: file });
        if (!res.ok) throw new ApiError('invalid_request', res.status);
        return instapayRequestDto.parse(await res.json());
      },
      refundRequests: async () => (await call('/wallet/refund-requests', items(refundRequestDto))).items,
      requestRefund: (amountMinor, note) => call('/wallet/refund-requests', refundRequestDto, post({ amountMinor, ...(note.trim() ? { note: note.trim() } : {}) })),
    },
    operator: {
      opsStatus: (workspaceId) => op(`/workspaces/${encodeURIComponent(workspaceId)}/ops`, opsStatusDto),
      killSwitch: async (workspaceId, action, reason) => { await op(`/workspaces/${encodeURIComponent(workspaceId)}/${action}`, done, post({ reason })); },
      pricingSettings: async () => (await op('/pricing-settings', items(pricingSettingsDto))).items,
      publishPricingSettings: (input) => op('/pricing-settings', pricingSettingsDto, post(input)),
      rateCards: async () => (await op('/rate-cards', items(rateCardVersionDto))).items,
      publishRateCard: async (input) => { await op('/rate-cards', done, post(input)); },
      fxRates: async () => (await op('/fx-rates', items(fxRateDto))).items,
      publishFx: async (input) => { await op('/fx-rates', done, post(input)); },
      overrides: async (workspaceId) => (await op(`/pricing-overrides/${encodeURIComponent(workspaceId)}`, items(marginOverrideDto))).items,
      publishOverride: async (workspaceId, input) => { await op(`/pricing-overrides/${encodeURIComponent(workspaceId)}`, done, post(input)); },
      setFunding: async (phoneNumberId, funding, reason) => { await op(`/numbers/${encodeURIComponent(phoneNumberId)}/funding`, done, { method: 'PUT', body: JSON.stringify({ funding, reason }) }); },
      refundQueue: async () => (await op('/refund-requests', items(refundRequestDto))).items,
      decideRefund: (id, decision, note) => op(`/refund-requests/${encodeURIComponent(id)}/decision`, refundRequestDto, post({ decision, ...(note.trim() ? { note: note.trim() } : {}) })),
      linkDashboardRefund: async (id, kashierRefundId, amountMinor) => { await op(`/refund-requests/${encodeURIComponent(id)}/link-dashboard-refund`, done, { method: 'POST', body: JSON.stringify({ kashierRefundId, amountMinor }) }); },
      abandonRefund: (id) => op(`/refund-requests/${encodeURIComponent(id)}/abandon`, z.object({ ok: z.literal(true), needsSecond: z.literal(true).optional(), already: z.literal(true).optional() }).loose(), post({})),
      markRefundPaid: async (id) => { await op(`/refund-requests/${encodeURIComponent(id)}/manual-paid`, done, { method: 'POST' }); },
      instapayQueue: async () => (await op('/instapay?state=under_review', items(operatorInstapayDto))).items,
      instapayProofLink: (id) => op(`/instapay/${encodeURIComponent(id)}/proof-link`, z.object({ url: z.string(), expiresAt: z.number().int() })),
      confirmInstapay: (id, bankRef, noReferenceReason) => op(`/instapay/${encodeURIComponent(id)}/confirm`, operatorInstapayDto.extend({ needsSecond: z.literal(true).optional() }), post(noReferenceReason ? { noReference: true, reason: noReferenceReason } : bankRef ? { bankRef } : {})),
      releaseInstapay: (id, reason) => op(`/instapay/${encodeURIComponent(id)}/release`, operatorInstapayDto, post({ reason })),
      rejectInstapay: (id, reason) => op(`/instapay/${encodeURIComponent(id)}/reject`, operatorInstapayDto, post({ reason })),
      autoConfirmations: () => op('/instapay/auto', operatorAutoListDto),
      revertAutoConfirmed: async (requestId, reason) => { await op(`/instapay/auto/${encodeURIComponent(requestId)}/revert`, done, post({ reason })); },
      setAutoMode: async (mode, reason) => { await op('/instapay/auto/mode', done, { method: 'PUT', body: JSON.stringify({ mode, reason }) }); },
      setWorkspaceAuto: async (workspaceId, enabled, reason) => { await op(`/instapay/auto/workspaces/${encodeURIComponent(workspaceId)}`, done, { method: 'PUT', body: JSON.stringify({ enabled, reason }) }); },
      adjustments: async () => (await op('/adjustments', items(adjustmentDto))).items,
      createAdjustment: (workspaceId, amountMinor, reason) => op(`/workspaces/${encodeURIComponent(workspaceId)}/adjustments`, adjustmentDto, post({ amountMinor, reason })),
      decideAdjustment: (id, decision) => op(`/adjustments/${encodeURIComponent(id)}/decision`, adjustmentDto, post({ decision })),
      metaDeletions: async () => (await op('/meta-deletions', items(z.object({ code: z.string(), state: z.enum(['queued', 'done', 'nothing_found', 'failed']), receivedAt: z.number().int(), removedConnections: z.number().int(), finishedAt: z.number().int().nullable() })))).items,
      offboardings: async () => (await op('/offboardings', items(operatorOffboardingDto))).items,
      offboarding: (ws) => op(`/workspaces/${encodeURIComponent(ws)}/offboarding`, operatorOffboardingDto),
      requestOffboarding: (ws, body) => op(`/workspaces/${encodeURIComponent(ws)}/offboarding`, operatorOffboardingDto, post(body)),
      cancelOffboarding: async (ws, reason) => { await op(`/workspaces/${encodeURIComponent(ws)}/offboarding`, done, { method: 'DELETE', body: JSON.stringify({ reason }) }); },
      approveOffboarding: async (ws, reason) => { await op(`/workspaces/${encodeURIComponent(ws)}/offboarding/approve`, done, post({ reason })); },
      releaseOffboardingHold: async (ws, reason) => { await op(`/workspaces/${encodeURIComponent(ws)}/offboarding/release-hold`, done, post({ reason })); },
      changeLog: async () => (await op('/change-log?limit=100', items(changeLogItemDto))).items,
      auditLog: async (f) => {
        const q = new URLSearchParams({ limit: '100' });
        for (const [k, v] of Object.entries(f)) if (v !== undefined && v !== '') q.set(k, String(v));
        return (await op(`/audit-log?${q}`, items(auditLogItemDto))).items;
      },
      yearlyRefundQuote: (orderId) => op(`/package-orders/${encodeURIComponent(orderId)}/refund-quote`, z.object({
        orderId: z.string(), packageId: z.string(), periodMonths: z.number(), monthlyMinor: z.number(), unusedMonths: z.number(), grossMinor: z.number(), debtMinor: z.number(), debtSettledMinor: z.number(), refundMinor: z.number(),
      }).loose()),
      yearlyRefundExecute: (orderId, reason) => op(`/package-orders/${encodeURIComponent(orderId)}/yearly-refund`, z.object({
        orderId: z.string(), shortenedMonths: z.number(), debtSettledMinor: z.number(), cashRefundMinor: z.number(), noMoneyOut: z.boolean(), periodEnd: z.number(),
      }), post({ reason })),
    },
    sharedTemplates: {
      list: async () => (await op('/shared-templates', listTemplatesResponse)).items,
      sync: () => op('/shared-templates/sync', z.object({ upserted: z.number(), removed: z.number() }), post({})),
      submit: (input) => op('/shared-templates', z.object({ status: z.string() }).loose(), post(input)),
      requests: async () => (await op('/shared-template-requests', z.object({ items: z.array(sharedRequestDto.extend({ workspaceId: z.string() })) }))).items,
    },
    async mediaUrl(path) {
      const res = await f(`${o.baseUrl}${path}`, { headers: { authorization: `Bearer ${await o.getToken()}` } });
      if (!res.ok) throw new ApiError('not_found', res.status);
      return URL.createObjectURL(await res.blob());
    },
    async longBody(messageId) {
      const r = await call(`/messages/${messageId}/body`, z.object({ text: z.string() }));
      return r.text;
    },
    async upload(file) {
      const form = new FormData();
      form.set('file', file);
      const r = await call('/media', z.object({ uploadId: z.string() }).loose(), { method: 'POST', body: form });
      return r.uploadId;
    },
    onReload(cb) {
      reloaders.add(cb);
      return () => reloaders.delete(cb);
    },
    subscribe(onEvent) {
      listeners.add(onEvent);
      return () => listeners.delete(onEvent);
    },
    fetchEvents: (after) => call(`/events?after=${after}`, eventsResponse),
    emit: (e) => listeners.forEach((l) => l(e)),
    reload: () => reloaders.forEach((r) => r()),
    async loadCapabilities() {
      try {
        const me = await call('/me', meResponse.partial().loose());
        source.capabilities = { codOutcome: me.capabilities?.codOutcome === true, numbers: me.capabilities?.numbers === true, assistant: me.capabilities?.assistant === true };
        if (me.role) source.role = me.role;
      } catch (e) {
        source.capabilities = { codOutcome: false };
        if (e instanceof ApiError && e.status === 403 && e.code === 'no_seat') source.noSeat = e.detail === 'seat_over_limit' ? 'over_limit' : 'none';
      }
    },
  };
  return source;
}

export interface SocketLike {
  onopen: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: (() => void) | null;
  close(): void;
}

type RealtimeOpts = {
  url: string;
  getToken: () => Promise<string>;
  onEvent: (e: RealtimeEvent) => void;
  /** Called when events may have been missed beyond repair (first connect, gap older than the server's buffer). */
  onReload?: () => void;
  fetchEvents: (after: number) => Promise<{ items: RealtimeEvent[]; latestSeq: number }>;
  socketImpl?: new (url: string, protocols: string[]) => SocketLike;
  backoffMs?: (attempt: number) => number;
};

/**
 * Realtime with gap repair: events arrive in seq order; a gap (or a reconnect) triggers GET /events?after=<last seq>.
 * Browsers cannot set headers on a WebSocket, so the token travels as the `bearer.<token>` subprotocol.
 */
export function connectRealtime(o: RealtimeOpts): () => void {
  const Socket = o.socketImpl ?? (WebSocket as unknown as new (url: string, protocols: string[]) => SocketLike);
  const backoff = o.backoffMs ?? ((n: number) => Math.min(30_000, 500 * 2 ** n) * (0.5 + Math.random() / 2));
  let lastSeq = 0;
  let stopped = false;
  let attempt = 0;
  let socket: SocketLike | null = null;
  let connected = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<void> = Promise.resolve();

  const deliver = (e: RealtimeEvent) => {
    if (stopped || e.seq <= lastSeq) return; // after stop() (sign-out) nothing more reaches the app
    lastSeq = e.seq;
    o.onEvent(e);
  };
  const resync = () =>
    o.fetchEvents(lastSeq).then((r) => {
      const items = r.items.sort((a, b) => a.seq - b.seq);
      // The server keeps the last N events; a first item past lastSeq+1 means some are gone: reload instead.
      if (lastSeq === 0 || (items[0] && items[0].seq > lastSeq + 1)) {
        lastSeq = Math.max(lastSeq, r.latestSeq);
        o.onReload?.();
        return;
      }
      for (const e of items) deliver(e);
      lastSeq = Math.max(lastSeq, r.latestSeq);
    }).catch(() => undefined);

  const schedule = (delay: number) => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void open(), delay);
  };

  const open = async () => {
    if (stopped) return;
    let s: SocketLike;
    try {
      // The server echoes "inbox.v1"; the token rides alongside because browsers cannot set WebSocket headers.
      const token = await o.getToken();
      if (stopped) return; // stopped while the token was being fetched: do not open a socket for a signed-out page
      s = new Socket(o.url, ['inbox.v1', `bearer.${token}`]);
    } catch {
      schedule(backoff(attempt++)); // offline or token refresh failed: try again later, never give up
      return;
    }
    socket = s;
    connected = false;
    s.onopen = () => {
      attempt = 0;
      connected = true;
      chain = chain.then(resync); // first connect included: covers events between the list load and now
    };
    s.onmessage = (msg) => {
      let parsed;
      try { parsed = realtimeEvent.safeParse(JSON.parse(msg.data)); } catch { return; }
      if (!parsed.success) return;
      const e = parsed.data;
      chain = chain.then(async () => {
        if (e.seq > lastSeq + 1) await resync();
        deliver(e);
      });
    };
    s.onclose = () => {
      connected = false;
      if (socket === s) schedule(backoff(attempt++));
    };
  };
  // A phone waking up or a network coming back reconnects at once instead of waiting out the backoff.
  const wake = () => {
    if (stopped) return;
    if (!connected) { attempt = 0; schedule(0); } else chain = chain.then(resync);
  };
  const onVisible = () => { if (typeof document !== 'undefined' && document.visibilityState === 'visible') wake(); };
  if (typeof window !== 'undefined') {
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', onVisible);
  }
  void open();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', onVisible);
    }
    socket?.close();
  };
}
