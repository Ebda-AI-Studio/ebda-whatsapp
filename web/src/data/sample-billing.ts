import type { OffboardingView, OperatorOffboarding, OpsStatusDto, InstapayRequest, ChangeLogItem, FxRate, MarginOverride, OperatorApi, PricingSettings, RateCardVersion, RefundRequest, StatementDto, WalletApi, Adjustment, WalletDto } from './billing';
import { ApiError } from './api';

// Sample billing data for preview only (the app labels the whole source as sample). Amounts are invented; nothing here is real money.
const BASE = Date.UTC(2026, 9, 24, 17, 0);
const H = 3_600_000;
const D = 24 * H;

const OCT = (day: number, hour = 10) => Date.UTC(2026, 9, day, hour, 0);
type Row = StatementDto['rows'][number];
const RAW: { at: number; kind: string; amount: number; category: string | null; note: string | null }[] = [
  { at: OCT(2), kind: 'topup', amount: 10000, category: null, note: null },
  { at: OCT(6), kind: 'meta_charge', amount: -340, category: 'utility', note: null },
  { at: OCT(8), kind: 'meta_charge', amount: -170, category: 'service', note: null },
  { at: OCT(12), kind: 'ai_charge', amount: -800, category: null, note: null },
  { at: OCT(18), kind: 'meta_charge', amount: -18150, category: 'marketing', note: null },
  { at: OCT(21), kind: 'meta_charge', amount: -2040, category: 'marketing', note: null },
];
const OPENING = 30000;

function octoberRows(): Row[] {
  let balance = OPENING;
  return RAW.map((r, i) => {
    balance += r.amount;
    return { at: r.at, kind: r.kind, netMinor: r.amount, vatMinor: 0, amountMinor: r.amount, balanceAfterMinor: balance, ref: `sample:${i}`, wamid: null, category: r.category, note: r.note };
  });
}

function totals(rows: Row[], key: (r: Row) => string | null) {
  const out: StatementDto['totalsByKind'] = {};
  for (const r of rows) {
    const k = key(r);
    if (!k) continue;
    const t = (out[k] ??= { count: 0, netMinor: 0, vatMinor: 0, amountMinor: 0 });
    t.count += 1; t.netMinor += r.netMinor; t.vatMinor += r.vatMinor; t.amountMinor += r.amountMinor;
  }
  return out;
}

function sampleStatement(month: string): StatementDto {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const from = Date.UTC(y, m - 1, 1);
  const to = Date.UTC(y, m, 1);
  if (month !== '2026-10') {
    const level = month < '2026-10' ? OPENING : 18500;
    return { month, from, to, openingMinor: level, closingMinor: level, rows: [], truncated: false, totalsByKind: {}, totalsByCategory: {}, cardCosts: [] };
  }
  const rows = octoberRows();
  return {
    month, from, to, openingMinor: OPENING, closingMinor: rows[rows.length - 1]!.balanceAfterMinor, rows, truncated: false,
    totalsByKind: totals(rows, (r) => r.kind), totalsByCategory: totals(rows, (r) => (r.kind === 'meta_charge' ? r.category : null)),
    cardCosts: [{ category: 'marketing', count: 120, usdMicros: 1_800_000 }, { category: 'utility', count: 45, usdMicros: 135_000 }],
  };
}

export function createSampleWallet(): WalletApi {
  let nextId = 1;
  const refunds: RefundRequest[] = [
    { id: 'r-1', workspaceId: 'ws-sample', amountMinor: 20000, note: 'نهاية الاشتراك', state: 'rejected', requestedBy: 'u-me', createdAt: BASE - 20 * D, decidedBy: 'u-root', decidedAt: BASE - 19 * D, decisionNote: 'الرصيد اتصرف على حملة قبل الطلب.', cardRefundedMinor: 0, manualMinor: 0 },
    { id: 'r-2', workspaceId: 'ws-sample', amountMinor: 5000, note: null, state: 'paid', requestedBy: 'u-me', createdAt: BASE - 60 * D, decidedBy: 'u-root', decidedAt: BASE - 58 * D, decisionNote: null, cardRefundedMinor: 5000, manualMinor: 0 },
  ];
  const instapayItems: InstapayRequest[] = [
    { id: 'ip-0', reference: 'WA-K7M2Q9XD', kind: 'package', packageId: 'gold', amountMinor: 50000, currency: 'EGP', state: 'rejected', createdAt: BASE - 5 * D, expiresAt: BASE - 3 * D, hasProof: true, rejectReason: 'المبلغ في الإيصال أقل من المطلوب', decidedAt: BASE - 4 * D },
  ];
  let off: OffboardingView = { state: 'none' };
  const wallet: WalletDto = {
    balanceMinor: 18500, heldMinor: 2500, availableMinor: 16000, debtMinor: 0, creditLimitMinor: 5000, currency: 'EGP',
    funding: [{ phoneNumberId: 'pn-sample-1', displayPhone: '+20 100 555 0101', funding: 'merchant_card' }, { phoneNumberId: 'pn-sample-shared', displayPhone: '+20 100 555 0900', funding: 'platform_line' }],
    topupsEnabled: true, lowBalance: false, aiCredits: { balance: 500, available: 480 },
    plan: { packageId: 'growth', status: 'active', periodEnd: BASE + 18 * D, cancelledAt: null },
  };
  return {
    wallet: async () => structuredClone(wallet),
    statement: async (month) => sampleStatement(month),
    async statementCsv(month) {
      const s = sampleStatement(month);
      const csv = ['date,kind,category,net,vat,amount,balance_after', ...s.rows.map((r) => [new Date(r.at).toISOString(), r.kind, r.category ?? '', r.netMinor, r.vatMinor, r.amountMinor, r.balanceAfterMinor].join(','))].join('\n');
      return `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    },
    estimate: async () => ({ funding: 'merchant_card', paidBy: 'merchant_card', perMessageMinor: 0, totalMinor: 0, priced: true, currency: 'EGP' }),
    async topup(amountMinor) {
      const feeMinor = Math.round(amountMinor * 0.025) + 300;
      const id = nextId++;
      return { orderId: `T-${id}`, state: 'pending', amountMinor, feeMinor, totalMinor: amountMinor + feeMinor, checkoutUrl: `https://pay.example.test/checkout/T-${id}` };
    },
    topupState: async (orderId) => ({ orderId, state: 'pending', amountMinor: 0, feeMinor: 0, totalMinor: 0 }),
    packages: async () => [
      { id: 'basic', name: 'Basic', priceMinor: 25000, aiCredits: 100, maxMembers: 2, features: ['members', 'shared_inbox', 'order_confirmations', 'templates', 'ai_credits'], periodMonths: 1 },
      { id: 'gold', name: 'Gold', priceMinor: 50000, aiCredits: 300, maxMembers: 5, features: ['members', 'shared_inbox', 'order_confirmations', 'templates', 'campaigns', 'order_in_chat', 'ai_credits'], periodMonths: 1 },
    ],
    async buyPackage(packageId) {
      const id = nextId++;
      return { orderId: `P-${id}`, state: 'pending', packageId, amountMinor: packageId === 'basic' ? 25000 : 50000, checkoutUrl: `https://pay.example.test/checkout/P-${id}` };
    },
    packageOrderState: async (orderId) => ({ orderId, state: 'pending', packageId: 'gold', amountMinor: 50000 }),
    async instapay() {
      return { enabled: true, payee: { handle: 'sample@instapay', name: 'Sample Studio', qrUrl: null }, items: instapayItems.map((r) => ({ ...r })) };
    },
    async createInstapay(input) {
      const id = `ip-${nextId++}`;
      const r: InstapayRequest = { id, reference: `WA-SAMPLE${nextId}`.slice(0, 11), kind: input.kind, packageId: input.kind === 'package' ? input.packageId : null, amountMinor: input.kind === 'package' ? (input.packageId === 'basic' ? 25000 : 50000) : input.amountMinor, currency: 'EGP', state: 'awaiting_proof', createdAt: Date.now(), expiresAt: Date.now() + 48 * 3_600_000, hasProof: false, rejectReason: null, decidedAt: null };
      instapayItems.unshift(r);
      return { ...r, payee: { handle: 'sample@instapay', name: 'Sample Studio', qrUrl: null } };
    },
    async uploadInstapayProof(requestId) {
      const r = instapayItems.find((x) => x.id === requestId);
      if (!r) throw new ApiError('not_found', 404);
      Object.assign(r, { state: 'under_review', hasProof: true });
      return { ...r };
    },
    refundRequests: async () => refunds.map((r) => ({ ...r })).sort((a, b) => b.createdAt - a.createdAt),
    async requestRefund(amountMinor, note) {
      if (amountMinor < 5000) throw new ApiError('invalid_request', 409, 'below_minimum');
      const r: RefundRequest = { id: `r-new-${nextId++}`, workspaceId: 'ws-sample', amountMinor, note: note.trim() || null, state: 'pending', requestedBy: 'u-me', createdAt: Date.now(), decidedBy: null, decidedAt: null, decisionNote: null, cardRefundedMinor: 0, manualMinor: 0 };
      refunds.push(r);
      return { ...r };
    },
    offboarding: async () => ({ ...off }),
    async requestOffboarding(opts) {
      if (wallet.balanceMinor > 0 && !opts.acceptWriteOff) throw new ApiError('invalid_request', 409, 'wallet_balance_remains');
      off = { state: 'pending', requestedRole: 'owner', requestedAt: BASE, executeAfter: BASE + 14 * D, writeOffMinor: Math.max(0, wallet.balanceMinor) };
      return { ...off };
    },
    async cancelOffboarding() {
      if (off.state !== 'pending') throw new ApiError('invalid_request', 409, 'nothing_pending');
      off = { state: 'cancelled' };
    },
  };
}

export function createSampleOperator(currentUserId: string): OperatorApi {
  let n = 100;
  const offs = new Map<string, OperatorOffboarding>();
  const ops = { suspended: false, evicted: false, revokedAt: null as number | null };
  const opsView = (): OpsStatusDto => ({
    suspended: ops.suspended, suspendedReason: ops.suspended ? 'sample' : null, integrationsRevokedAt: ops.revokedAt, evicted: ops.evicted,
    numbers: [{ phoneNumberId: 'pn-sample-1', health: 'green', healthReason: null, healthAt: null }],
    sharedNumber: { phoneNumberId: 'pn-platform', health: 'green', healthReason: null, healthAt: null }, recentActions: [],
  });
  const settings: PricingSettings[] = [
    { ver: 3, effectiveFrom: BASE + 3 * D, marginBps: 1800, creditLimitMinor: 5000, fxBufferBps: 200, vatBps: 0, actor: 'u-root', reason: 'رفع الهامش بعد زيادة أسعار ميتا' },
    { ver: 2, effectiveFrom: BASE - 10 * D, marginBps: 1500, creditLimitMinor: 5000, fxBufferBps: 200, vatBps: 0, actor: 'u-root', reason: 'تحديث هامش الربع الأخير' },
    { ver: 1, effectiveFrom: BASE - 60 * D, marginBps: 0, creditLimitMinor: 5000, fxBufferBps: 0, vatBps: 0, actor: 'u-root', reason: 'الإعداد الأولي' },
  ];
  const rateCards: RateCardVersion[] = [
    { ver: 2, effectiveFrom: BASE + 2 * D, rows: 240, publishedAt: BASE - D, actor: 'u-root' },
    { ver: 1, effectiveFrom: BASE - 30 * D, rows: 238, publishedAt: BASE - 31 * D, actor: 'u-root' },
  ];
  const fx: FxRate[] = [
    { ver: 2, effectiveFrom: BASE - 2 * D, egpPerUsdMicros: 49_250_000, bufferBps: 100, publishedAt: BASE - 3 * D, actor: 'u-root' },
    { ver: 1, effectiveFrom: BASE - 30 * D, egpPerUsdMicros: 48_500_000, bufferBps: 100, publishedAt: BASE - 31 * D, actor: 'u-root' },
  ];
  const overrides: Record<string, MarginOverride[]> = { 'ws-sample': [{ ver: 1, effectiveFrom: BASE - 5 * D, marginBps: 1000, actor: 'u-root', reason: 'اتفاق خاص مع العميل' }] };
  const refunds: RefundRequest[] = [
    { id: 'q-1', workspaceId: 'ws-sample', amountMinor: 20000, note: 'ألغيت الاشتراك وعايز باقي الرصيد', state: 'pending', requestedBy: 'u-merchant', createdAt: BASE - 2 * D, decidedBy: null, decidedAt: null, decisionNote: null, cardRefundedMinor: 0, manualMinor: 0 },
    { id: 'q-2', workspaceId: 'ws-demo-2', amountMinor: 7500, note: null, state: 'manual_payout', requestedBy: 'u-merchant-2', createdAt: BASE - 9 * D, decidedBy: 'u-root', decidedAt: BASE - 8 * D, decisionNote: null, cardRefundedMinor: 0, manualMinor: 7500 },
  ];
  const adjustments: Adjustment[] = [
    { id: 'a-1', workspaceId: 'ws-sample', amountMinor: 250000, reason: 'تعويض عن عطل في إرسال حملة', requestedBy: currentUserId, state: 'pending', approvedBy: null, createdAt: BASE - 3 * H, decidedAt: null },
    { id: 'a-2', workspaceId: 'ws-demo-2', amountMinor: -50000, reason: 'شحنة اتسجلت مرتين', requestedBy: 'u-root', state: 'pending', approvedBy: null, createdAt: BASE - 5 * H, decidedAt: null },
    { id: 'a-3', workspaceId: 'ws-sample', amountMinor: 1500, reason: 'رصيد ترحيب', requestedBy: 'u-root', state: 'approved', approvedBy: 'u-root', createdAt: BASE - 12 * D, decidedAt: BASE - 12 * D },
  ];
  const log: ChangeLogItem[] = [
    { id: 3, at: BASE - 3 * D, actor: 'u-root', action: 'settings_published', workspaceId: null, before: { marginBps: 1500, fxBufferBps: 200 }, after: { marginBps: 1800, fxBufferBps: 200 }, reason: 'رفع الهامش بعد زيادة أسعار ميتا' },
    { id: 2, at: BASE - 5 * D, actor: 'u-root', action: 'override_published', workspaceId: 'ws-sample', before: null, after: { marginBps: 1000 }, reason: 'اتفاق خاص مع العميل' },
    { id: 1, at: BASE - 12 * D, actor: 'u-root', action: 'adjustment_applied', workspaceId: 'ws-sample', before: null, after: { amountMinor: 1500 }, reason: 'رصيد ترحيب' },
  ];
  const record = (action: string, workspaceId: string | null, before: unknown, after: unknown, reason: string) =>
    log.unshift({ id: ++n, at: Date.now(), actor: currentUserId, action, workspaceId, before: before ?? null, after: after ?? null, reason });
  const find = <T extends { id: string }>(xs: T[], id: string): T => {
    const x = xs.find((y) => y.id === id);
    if (!x) throw new ApiError('not_found', 404);
    return x;
  };
  return {
    opsStatus: async () => opsView(),
    killSwitch: async (_ws, action) => {
      if (action === 'suspend') ops.suspended = true;
      else if (action === 'unsuspend') ops.suspended = false;
      else if (action === 'shared-number/evict') ops.evicted = true;
      else if (action === 'shared-number/readmit') ops.evicted = false;
      else if (action === 'integrations/revoke') ops.revokedAt = Date.now();
      else if (action === 'integrations/restore') ops.revokedAt = null;
    },
    pricingSettings: async () => structuredClone(settings),
    async publishPricingSettings(input) {
      const row: PricingSettings = { ver: settings.length + 1, ...input, actor: currentUserId };
      settings.unshift(row);
      record('settings_published', null, settings[1] ?? null, row, input.reason);
      return { ...row };
    },
    rateCards: async () => structuredClone(rateCards),
    async publishRateCard(input) {
      rateCards.unshift({ ver: rateCards.length + 1, effectiveFrom: input.effectiveFrom, rows: input.rates.length, publishedAt: Date.now(), actor: currentUserId });
      record('rate_card_published', null, null, { rows: input.rates.length }, input.reason);
    },
    fxRates: async () => structuredClone(fx),
    async publishFx(input) {
      fx.unshift({ ver: fx.length + 1, effectiveFrom: input.effectiveFrom, egpPerUsdMicros: input.egpPerUsdMicros, bufferBps: input.bufferBps, publishedAt: Date.now(), actor: currentUserId });
      record('fx_published', null, null, { egpPerUsdMicros: input.egpPerUsdMicros }, input.reason);
    },
    overrides: async (workspaceId) => structuredClone(overrides[workspaceId] ?? []),
    async publishOverride(workspaceId, input) {
      (overrides[workspaceId] ??= []).unshift({ ver: (overrides[workspaceId]?.length ?? 0) + 1, effectiveFrom: input.effectiveFrom, marginBps: input.marginBps, actor: currentUserId, reason: input.reason });
      record('override_published', workspaceId, null, { marginBps: input.marginBps }, input.reason);
    },
    async setFunding(phoneNumberId, funding, reason) { record('funding_set', null, null, { phoneNumberId, funding }, reason); },
    refundQueue: async () => structuredClone(refunds),
    async decideRefund(id, decision, note) {
      const r = find(refunds, id);
      Object.assign(r, decision === 'approve' ? { state: 'processing', cardRefundedMinor: r.amountMinor } : { state: 'rejected' }, { decidedBy: currentUserId, decidedAt: Date.now(), decisionNote: note.trim() || null });
      record(`refund_${decision}`, r.workspaceId, { state: 'pending' }, { state: r.state }, note.trim() || '—');
      return { ...r };
    },
    async linkDashboardRefund(id, _refundId, amountMinor) { const r = find(refunds, id); Object.assign(r, { cardRefundedMinor: r.cardRefundedMinor + amountMinor, manualMinor: Math.max(0, r.manualMinor - amountMinor), state: r.manualMinor - amountMinor > 0 ? 'manual_payout' : 'paid' }); },
    instapayQueue: async () => [{ id: 'ip-op-1', reference: 'WA-H4N8T2PC', kind: 'topup', packageId: null, amountMinor: 20000, currency: 'EGP', state: 'under_review', createdAt: BASE - D, expiresAt: BASE + D, hasProof: true, rejectReason: null, decidedAt: null, workspaceId: 'ws-sample', createdBy: 'u-merchant', proofAt: BASE - D, firstApprover: null, decidedBy: null, proofMime: 'image/png' }],
    instapayProofLink: async () => ({ url: '/api/v1/instapay-proof/sample', expiresAt: Date.now() + 120_000 }),
    async confirmInstapay(id) { return { id, reference: 'WA-H4N8T2PC', kind: 'topup', packageId: null, amountMinor: 20000, currency: 'EGP', state: 'confirmed', createdAt: BASE - D, expiresAt: BASE + D, hasProof: true, rejectReason: null, decidedAt: Date.now(), workspaceId: 'ws-sample', createdBy: 'u-merchant', proofAt: BASE - D, firstApprover: null, decidedBy: currentUserId, proofMime: 'image/png' }; },
    async rejectInstapay(id, reason) { return { id, reference: 'WA-H4N8T2PC', kind: 'topup', packageId: null, amountMinor: 20000, currency: 'EGP', state: 'rejected', createdAt: BASE - D, expiresAt: BASE + D, hasProof: true, rejectReason: reason, decidedAt: Date.now(), workspaceId: 'ws-sample', createdBy: 'u-merchant', proofAt: BASE - D, firstApprover: null, decidedBy: currentUserId, proofMime: 'image/png' }; },
    async abandonRefund() { return { needsSecond: true as const }; },
    async markRefundPaid(id) { Object.assign(find(refunds, id), { state: 'paid' }); },
    adjustments: async () => structuredClone(adjustments),
    async createAdjustment(workspaceId, amountMinor, reason) {
      const a: Adjustment = { id: `a-${n++}`, workspaceId, amountMinor, reason, requestedBy: currentUserId, state: 'pending', approvedBy: null, createdAt: Date.now(), decidedAt: null };
      adjustments.unshift(a);
      record('adjustment_requested', workspaceId, null, { amountMinor }, reason);
      return { ...a };
    },
    async decideAdjustment(id, decision) {
      const a = find(adjustments, id);
      if (a.requestedBy === currentUserId) throw new ApiError('forbidden', 403, 'second_approver_required');
      Object.assign(a, { state: decision === 'approve' ? 'approved' : 'rejected', approvedBy: currentUserId, decidedAt: Date.now() });
      record(`adjustment_${decision}d`, a.workspaceId, { state: 'pending' }, { state: a.state }, a.reason);
      return { ...a };
    },
    async offboardings() { return [...offs.values()].map((o) => structuredClone(o)); },
    async offboarding(ws) {
      const o = offs.get(ws);
      if (!o) throw new ApiError('not_found', 404);
      return structuredClone(o);
    },
    async requestOffboarding(ws, body) {
      const at = BASE;
      const prev = offs.get(ws);
      const o: OperatorOffboarding = prev ?? { workspaceId: ws, state: 'pending', requestedBy: currentUserId, requestedRole: 'operator', reason: body.reason, requestedAt: at, executeAfter: at + 14 * D, writeOffMinor: 0, stepsDone: [], attempts: 0, lastError: null, finishedAt: null, log: [] };
      if (body.immediate) o.executeAfter = at;
      Object.assign(o, { requestedRole: 'operator', requestedBy: currentUserId, reason: body.reason });
      o.log = [...(o.log ?? []), { at, actor: currentUserId, action: prev ? 'operator_changed' : 'requested', reason: body.reason }];
      offs.set(ws, o);
      return structuredClone(o);
    },
    async cancelOffboarding(ws, reason) {
      const o = offs.get(ws);
      if (!o || o.state !== 'pending') throw new ApiError('invalid_request', 409, 'nothing_pending');
      o.state = 'cancelled';
      o.log = [...(o.log ?? []), { at: BASE, actor: currentUserId, action: 'cancelled', reason }];
    },
    changeLog: async () => structuredClone(log),
    async auditLog(f) {
      const all = [
        { id: 3, at: BASE - D, workspaceId: 'ws-sample', actor: 'u-staff', actorRole: 'staff' as const, action: 'POST /stores/:storeId/conversations/:conversationId/assign', targetType: 'conversationId', targetId: '41', status: 200 },
        { id: 2, at: BASE - 2 * D, workspaceId: 'ws-sample', actor: 'u-root', actorRole: 'operator' as const, action: 'POST /operator/workspaces/:workspaceId/suspend', targetType: null, targetId: null, status: 200 },
        { id: 1, at: BASE - 3 * D, workspaceId: 'ws-sample', actor: 'u-owner', actorRole: 'owner' as const, action: 'DELETE /stores/:storeId/contacts/:waId', targetType: 'waId', targetId: '3f9a1c0e5b7d4a2c8e6f1b0d9c3a7e52', status: 200 },
      ];
      return all.filter((r) => (!f.workspaceId || r.workspaceId === f.workspaceId) && (!f.actor || r.actor === f.actor) && (!f.action || r.action === f.action) && (!f.before || r.id < f.before));
    },
    async yearlyRefundQuote(orderId) {
      if (!/^yearly-/.test(orderId)) throw new ApiError('not_found', 404);
      return { orderId, packageId: 'growth-yearly', periodMonths: 12, monthlyMinor: 111750, unusedMonths: 11, grossMinor: 1229250, debtMinor: 100000, debtSettledMinor: 100000, refundMinor: 1129250 };
    },
    async yearlyRefundExecute(orderId, reason) {
      if (!/^yearly-/.test(orderId)) throw new ApiError('not_found', 404);
      record('yearly_refund', null, null, { orderId, shortenedMonths: 11 }, reason);
      return { orderId, shortenedMonths: 11, debtSettledMinor: 100000, cashRefundMinor: 1129250, noMoneyOut: false, periodEnd: Date.now() + 20 * 86_400_000 };
    },
  };
}
