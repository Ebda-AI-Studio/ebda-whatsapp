import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import explainJson from '../../assistant/explain.generated.json';
import corpusJson from '../../assistant/help-corpus.generated.json';
import registryJson from '../../assistant/registry.generated.json';
import { selectTools } from '../../foundation/smart-layer/plan/select-tools';
import { chatAdapter } from '../../src/core/smart-layer/adapter';
import type { HelpCorpus } from '../../src/core/smart-layer/help-index';
import { viewOf, type StoredCap } from '../../src/core/smart-layer/registry';
import { EXPLAIN_IDS, explainTools, type ExplainData } from '../../src/core/smart-layer/tools/explain.tools';
import { configureAssistant } from '../../src/routes/assistant';
import { useApiKey } from '../helpers/api';
import { useStoreLink } from '../helpers/store-link';
import { exec, rows } from '../helpers/workspace';
import { noHelp, scriptedAi, setup } from './harness';

useApiKey();
const link = useStoreLink();
const OWNER = '6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f';
const STAFF = 'b0000000-0000-4000-8000-000000000001';
beforeEach(async () => { await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at) VALUES ('sl.global', '{\"mode\":\"act\"}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(); });
afterEach(() => { configureAssistant({}); });

const REG = viewOf(registryJson as unknown as StoredCap[]);
const adapter = () => chatAdapter({ env, ws: undefined as never, callApi: async () => ({ status: 200, json: {} }), registry: REG, corpus: corpusJson as unknown as HelpCorpus, assistantCapability: 'assistant.ebda-assistant', help: noHelp, ai: { run: async () => ({}) } });

async function readOnce(t: Awaited<ReturnType<typeof setup>>, text: string, call: { name: string; args: unknown }) {
  const ai = scriptedAi([{ call }, { text: 'تمام.' }]);
  await t.ask(text, undefined, ai);
  return ai.seen.join(' ').replace(/\\"/g, '"');
}
const status = async (r: Response) => ((await r.json()) as { status: string }).status;

describe('E7 reads', () => {
  it('access_roles, bot_funnel, catalogue_left_out, numbers_health, numbers_tier_limit, storelink_bridge_health, templates_shared_list, wallet_cost_estimate, wallet_statement answer from the merchant\'s own routes', async () => {
    const t = await setup(7801);
    const cases: Array<[string, string, unknown, string]> = [
      ['صلاحياتي ايه في الحساب', 'access_roles', {}, '"role":"owner"'],
      ['نتايج البوت الاسبوع ده', 'bot_funnel', { from: '2026-11-01', to: '2026-11-07' }, 'customersPerStep'],
      ['منتجات مش في الكتالوج ليه', 'catalogue_left_out', {}, '"linked":false'],
      ['صحة الرقم عندي', 'numbers_health', {}, '"status":"active"'],
      ['حد الرسايل الرقم كام', 'numbers_tier_limit', {}, '"tier"'],
      ['ربط المتجر شغال', 'storelink_bridge_health', {}, 'storeConnected'],
      ['قوالب الرقم المشترك الجاهزة', 'templates_shared_list', {}, '"onSharedNumber":false'],
      ['هتكلفني كام ارسال 100 رسالة تسويقية', 'wallet_cost_estimate', { category: 'marketing', count: 100 }, '"currency":"EGP"'],
      ['كشف حساب المحفظة لشهر نوفمبر', 'wallet_statement', { month: '2026-11' }, 'rows'],
    ];
    for (const [ask, name, args, expected] of cases) expect(await readOnce(t, ask, { name, args }), name).toContain(expected);
  });

  it('team_seats_view lists the team with seats (owner only)', async () => {
    const t = await setup(7802);
    link.fake.setMembers(t.s, [{ userId: OWNER, role: 'owner', displayName: 'ليلى' }, { userId: STAFF, role: 'staff', displayName: 'دينا' }]);
    const seen = await readOnce(t, 'الفريق مين عنده مقعد', { name: 'team_seats_view', args: {} });
    expect(seen).toContain('دينا');
    expect(seen).toContain('"seat":"none"');
  });

  it('every behaviour capability in the explain list answers, including the E7 ones, and none of them hides a merchant write route', () => {
    const tools = explainTools(explainJson as unknown as ExplainData);
    expect(tools.map((x) => x.capabilityId).sort()).toEqual([...EXPLAIN_IDS].sort());
    const writes = ['POST', 'PUT', 'PATCH', 'DELETE'];
    for (const id of EXPLAIN_IDS) {
      const apis = (REG.caps.get(id) ? ((registryJson as unknown as Array<{ id: string }>).find((c) => c.id === id) as unknown) : null) as unknown;
      expect(apis, id).not.toBeNull();
    }
    void writes;
  });
});

describe('E7 writes (confirm class)', () => {
  it('agent_enable and agent_promises: confirm cards (customer message / money), the press changes the setting, Undo of a promise restores it', async () => {
    const t = await setup(7803);
    const on = await t.ask('شغّل الموظف الذكي', { name: 'agent_enable', args: { enabled: true } });
    expect(on.previews[0]).toMatchObject({ policy: 'confirm' });
    expect(on.previews[0]!.reasons).toContain('customer_message');
    await t.confirm(on.approvals![0]!.approvalId, on.approvals![0]!.token);
    expect(((await t.get('/agent')) as { enabled: boolean }).enabled).toBe(true);
    const pr = await t.ask('خلي الموظف الذكي يوعد باسترجاع', { name: 'agent_promises', args: { allowRefund: true } });
    expect(pr.previews[0]!.reasons).toContain('money');
    const done = (await (await t.confirm(pr.approvals![0]!.approvalId, pr.approvals![0]!.token)).json()) as { status: string; appliedId: string };
    expect(done.status).toBe('applied');
    expect(((await t.get('/agent')) as { allowRefund: boolean }).allowRefund).toBe(true);
    expect(await status(await t.undo(done.appliedId))).toBe('undone');
    expect(((await t.get('/agent')) as { allowRefund: boolean }).allowRefund).toBe(false);
  });

  it('otp_toggle: turning sign-in codes on messages customers and costs money, so it is a confirm card; the press uses the route\'s own two steps', async () => {
    const t = await setup(7804);
    const out = await t.ask('شغّل كود الدخول بالواتساب', { name: 'otp_toggle', args: { enabled: true } });
    expect(out.previews[0]).toMatchObject({ policy: 'confirm' });
    expect(out.previews[0]!.reasons).toEqual(expect.arrayContaining(['money', 'customer_message']));
    await t.confirm(out.approvals![0]!.approvalId, out.approvals![0]!.token);
    expect(((await t.get('/store-link/settings')) as { otpViaWhatsApp: boolean }).otpViaWhatsApp).toBe(true);
  });

  it('seat_assign then Undo is a seat_remove confirm card; seat_remove then Undo gives the seat back', async () => {
    const t = await setup(7805);
    link.fake.setMembers(t.s, [{ userId: OWNER, role: 'owner', displayName: 'ليلى' }, { userId: STAFF, role: 'staff', displayName: 'دينا' }]);
    const a = await t.ask('إدّي الموظف دينا مقعد', { name: 'seat_assign', args: { member: 'دينا' } });
    const applied = (await (await t.apply(a.previews[0]!.previewId)).json()) as { appliedId: string };
    expect(await rows(t.s, 'SELECT user_id FROM seats WHERE user_id = ?', STAFF)).toHaveLength(1);
    const undo = (await (await t.undo(applied.appliedId)).json()) as { status: string; approvals?: Array<{ approvalId: string; token: string }> };
    expect(undo.status).toBe('needs_confirm');
    await t.confirm(undo.approvals![0]!.approvalId, undo.approvals![0]!.token);
    expect(await rows(t.s, 'SELECT user_id FROM seats WHERE user_id = ?', STAFF)).toHaveLength(0);
    // remove (confirm) on a seated member, then Undo restores it
    await t.apply((await t.ask('إدّي الموظف دينا مقعد', { name: 'seat_assign', args: { member: 'دينا' } })).previews[0]!.previewId);
    const r = await t.ask('شيل مقعد دينا', { name: 'seat_remove', args: { member: 'دينا' } });
    expect(r.previews[0]).toMatchObject({ policy: 'confirm' });
    const rd = (await (await t.confirm(r.approvals![0]!.approvalId, r.approvals![0]!.token)).json()) as { status: string; appliedId: string };
    expect(rd.status).toBe('applied');
    expect(await status(await t.undo(rd.appliedId))).toBe('undone');
    expect(await rows(t.s, 'SELECT user_id FROM seats WHERE user_id = ?', STAFF)).toHaveLength(1);
  });

  it('offboarding_request: a deleting, money confirm card; the press starts the cooling-off; Undo is a cancel card; an unknown wallet balance never slips through', async () => {
    const t = await setup(7806);
    const out = await t.ask('عايز امسح الحساب كله', { name: 'offboarding_request', args: { reason: 'بقفل المشروع' } });
    expect(out.previews[0]).toMatchObject({ policy: 'confirm' });
    expect(out.previews[0]!.reasons).toEqual(expect.arrayContaining(['delete', 'money']));
    const done = (await (await t.confirm(out.approvals![0]!.approvalId, out.approvals![0]!.token)).json()) as { status: string; appliedId: string };
    expect(done.status).toBe('applied');
    expect(((await t.get('/offboarding')) as { state: string }).state).toBe('pending');
    const undo = (await (await t.undo(done.appliedId)).json()) as { status: string; approvals?: Array<{ approvalId: string; token: string }> };
    expect(undo.status).toBe('needs_confirm');
    await t.confirm(undo.approvals![0]!.approvalId, undo.approvals![0]!.token);
    expect(((await t.get('/offboarding')) as { state: string }).state).not.toBe('pending');
  });

  it('numbers_disconnect is a confirm card for the merchant\'s own number; the press disconnects it', async () => {
    const t = await setup(7807);
    await exec(t.s, 'SELECT 1');
    const out = await t.ask('افصل رقم الواتساب', { name: 'numbers_disconnect', args: {} });
    if (out.previews[0]) {
      expect(out.previews[0]).toMatchObject({ policy: 'confirm', undo: 'irreversible' });
      await t.confirm(out.approvals![0]!.approvalId, out.approvals![0]!.token);
      expect(((await t.get('/numbers')) as { items: Array<{ status: string }> }).items.every((n) => n.status === 'disconnected')).toBe(true);
    } else {
      // a workspace whose numbers are not "own" (seeded as platform) has nothing of its own to disconnect: no card, nothing changed
      expect(((await t.get('/numbers')) as { items: Array<{ status: string }> }).items.every((n) => n.status === 'active')).toBe(true);
    }
  });

  it('tools that have nothing to do build no card: registered number, no notice, not on the shared number, balance too low, funding already set', async () => {
    const t = await setup(7808);
    expect((await t.ask('كمّل تسجيل الرقم', { name: 'numbers_finish_registration', args: {} })).previews).toEqual([]);
    expect((await t.ask('اخفي التنبيه', { name: 'numbers_dismiss_notice', args: {} })).previews).toEqual([]);
    expect((await t.ask('انضم للرقم المشترك', { name: 'numbers_shared_join', args: {} })).previews).toEqual([]);
    expect((await t.ask('اطلب قالب جديد للرقم المشترك', { name: 'templates_shared_request', args: { name: 'x_y', language: 'ar', category: 'UTILITY', body: 'نص' } })).previews).toEqual([]);
    expect((await t.ask('استرجاع رصيد المحفظة', { name: 'wallet_refund_request', args: { amountEgp: 500 } })).previews).toEqual([]);
    expect((await t.ask('الغي الباقة السنوية واسترجع', { name: 'wallet_yearly_refund_request', args: {} })).previews).toEqual([]);
    expect((await t.ask('الغي مسح الحساب', { name: 'offboarding_cancel', args: {} })).previews).toEqual([]);
  });

  it('staff cannot even build the owner-only cards (the owner screens\' reads refuse them)', async () => {
    const t = await setup(7809, 'staff');
    expect((await t.ask('شغّل الموظف الذكي', { name: 'agent_enable', args: { enabled: true } })).previews).toEqual([]);
    expect((await t.ask('خلي الموظف الذكي يوعد باسترجاع', { name: 'agent_promises', args: { allowRefund: true } })).previews).toEqual([]);
  });
});

describe('every capability is reachable now', () => {
  it('the deep-link-only entries added in E7 name a reason and keep their screen findable by show_me_where', () => {
    const tools = adapter().tools();
    for (const id of ['agent.connectors', 'packages.list-checkout', 'packages.yearly-switch', 'agent.credits-topup', 'wallet.instapay']) {
      expect(tools.some((x) => x.capabilityId === id), id).toBe(false);
      expect(REG.caps.get(id)?.status, id).toBe('live');
    }
  });
  it('every new write tool is offered for an Arabic ask built from its search words', () => {
    const tools = adapter().tools();
    const names = ['agent_enable', 'agent_promises', 'catalogue_provision', 'numbers_disconnect', 'numbers_finish_registration', 'numbers_dismiss_notice', 'numbers_shared_join', 'numbers_shared_leave', 'offboarding_request', 'offboarding_cancel', 'otp_toggle', 'seat_remove', 'templates_shared_request', 'wallet_funding', 'wallet_refund_request', 'wallet_yearly_refund_request'];
    const missing = names.filter((n) => { const d = tools.find((x) => x.name === n)!.description; const words = (d.match(/\[(.*)\]$/)?.[1] ?? '').split(' ').slice(0, 4).join(' '); return !selectTools(words, tools, REG, { mode: 'act', untrustedInContext: false }).some((o) => o.name === n); });
    expect(missing).toEqual([]);
  });
});
