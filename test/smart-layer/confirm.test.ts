import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configureAssistant } from '../../src/routes/assistant';
import { apiKey, useApiKey } from '../helpers/api';
import { mint } from '../helpers/issuer';
import { installWallet, makeCampaign, resetWallet, seedContacts, seedTemplate } from '../helpers/campaigns';
import { exec, rows } from '../helpers/workspace';
import { sha256Hex } from '../../foundation/smart-layer/release';
import { scriptedAi, setup } from './harness';

useApiKey();
beforeEach(async () => { await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at) VALUES ('sl.global', '{\"mode\":\"act\"}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(); });
afterEach(() => { configureAssistant({}); resetWallet(); });

const TEXT = 'أهلا يا منى، طلبك اتشحن النهارده';
const sendText = (text = TEXT) => ({ name: 'send_text', args: { customer: 'منى السيد', text } });
const outbound = async (t: Awaited<ReturnType<typeof setup>>) => {
  const conv = (await t.get('/conversations') as { items: Array<{ id: number }> }).items[0]!.id;
  return ((await t.get(`/conversations/${conv}/messages`)) as { items: Array<{ direction: string; text: string | null }> }).items.filter((m) => m.direction === 'out');
};
const status = async (r: Response) => ((await r.json()) as { status: string }).status;
const decisions = (s: string) => rows(s, 'SELECT decision FROM sl_decisions ORDER BY seq');

describe('confirm class: only the merchant\'s own button press sends', () => {
  it('send_text: the turn sends nothing and returns a confirm card; the token appears only in approvals, never in the card, a stored row or a model request', async () => {
    const t = await setup(7401);
    const ai = scriptedAi([{ call: sendText() }, { text: 'المعاينة جاهزة.' }]);
    const out = await t.ask('ابعت لمنى السيد رسالة', undefined, ai);
    expect(out.previews[0]).toMatchObject({ policy: 'confirm', undo: 'irreversible' });
    expect(out.previews[0]!.reasons).toEqual(expect.arrayContaining(['customer_message', 'irreversible']));
    expect(out.previews[0]!.rows.some((r) => r.after === TEXT)).toBe(true);
    const ap = out.approvals![0]!;
    expect(ap.approvalId).toBe(out.previews[0]!.approvalId);
    expect(JSON.stringify(out.previews)).not.toContain(ap.token);
    expect(await outbound(t)).toEqual([]);
    for (const table of ['sl_turns', 'sl_audit', 'sl_previews', 'sl_approvals', 'sl_decisions']) expect(JSON.stringify(await rows(t.s, `SELECT * FROM ${table}`)), table).not.toContain(ap.token);
    expect(ai.seen.join('')).not.toContain(ap.token);
    const res = (await (await t.confirm(ap.approvalId, ap.token)).json()) as { status: string };
    expect(res.status).toBe('applied');
    expect((await outbound(t)).map((m) => m.text)).toEqual([TEXT]);
    expect(await decisions(t.s)).toEqual([{ decision: 'confirmed' }]);
  });

  it('a typed "yes" applies nothing: the approval stays pending and nothing is sent', async () => {
    const t = await setup(7402);
    const out = await t.ask('ابعت لمنى السيد رسالة', sendText());
    await t.ask('أيوه نفّذ', undefined, scriptedAi([{ text: 'تمام.' }]));
    expect(await outbound(t)).toEqual([]);
    expect(await rows(t.s, "SELECT status FROM sl_approvals WHERE id = '" + out.approvals![0]!.approvalId + "'")).toEqual([{ status: 'pending' }]);
  });

  it('two parallel confirms send once', async () => {
    const t = await setup(7403);
    const ap = (await t.ask('ابعت لمنى السيد رسالة', sendText())).approvals![0]!;
    const [a, b] = await Promise.all([t.confirm(ap.approvalId, ap.token), t.confirm(ap.approvalId, ap.token)]);
    const statuses = (await Promise.all([a, b].map(async (r) => ((await r.json()) as { status: string }).status))).sort();
    expect(statuses).toEqual(['applied', 'used']);
    expect(await outbound(t)).toHaveLength(1);
  });

  it('a token for one card cannot confirm another card (the payload hash binds it), and one character of difference is a different card', async () => {
    const t = await setup(7404);
    const a = (await t.ask('ابعت لمنى السيد رسالة', sendText(TEXT))).approvals![0]!;
    const bOut = await t.ask('ابعت لمنى السيد رسالة', sendText(`${TEXT}!`));
    const b = bOut.approvals![0]!;
    const hashes = await rows(t.s, 'SELECT json_extract(json, \'$.payloadHash\') AS h FROM sl_previews ORDER BY created_at, id');
    expect(new Set(hashes.map((x) => x.h)).size).toBe(2);
    const wrong = (await (await t.confirm(b.approvalId, a.token)).json()) as { status: string };
    expect(wrong.status).toBe('mismatch');
    expect(await outbound(t)).toEqual([]);
  });

  it('a role change between the card and the press: refused by the route, nothing happens, the decision is logged rejected:permission', async () => {
    const t = await setup(7405);
    const out = await t.ask('امسح العميل منى السيد', { name: 'contact_erase', args: { customer: 'منى السيد' } });
    expect(out.previews[0]).toMatchObject({ policy: 'confirm' });
    expect(out.previews[0]!.reasons).toContain('delete');
    const ap = out.approvals![0]!;
    const owner = '6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f';
    const demoted = await mint(apiKey(), { sub: owner, stores: [{ id: t.s, role: 'staff' }] });
    const res = await t.confirm(ap.approvalId, ap.token, demoted);
    expect(res.status).toBe(403);
    expect(((await t.get('/contacts')) as { items: unknown[] }).items).toHaveLength(1);
    expect(await decisions(t.s)).toEqual([{ decision: 'rejected:permission' }]);
  });

  it('reject records the decision and the token is then dead', async () => {
    const t = await setup(7406);
    const ap = (await t.ask('ابعت لمنى السيد رسالة', sendText())).approvals![0]!;
    expect(((await (await t.reject(ap.approvalId)).json()) as { status: string }).status).toBe('rejected');
    expect(((await (await t.confirm(ap.approvalId, ap.token)).json()) as { status: string }).status).toBe('used');
    expect(await outbound(t)).toEqual([]);
    expect(await decisions(t.s)).toEqual([{ decision: 'rejected' }]);
  });

  it('another member cannot press someone else\'s card', async () => {
    const t = await setup(7407);
    const ap = (await t.ask('ابعت لمنى السيد رسالة', sendText())).approvals![0]!;
    const other = await mint(apiKey(), { sub: '7a2e3d2f-9b9f-4b4c-8a2f-2b3c4d5e6f70', stores: [{ id: t.s, role: 'owner' }] });
    expect((await t.confirm(ap.approvalId, ap.token, other)).status).toBe(403);
    expect(await outbound(t)).toEqual([]);
  });

  it('the confirm routes are closed by the kill switch and by a missing token', async () => {
    const t = await setup(7408);
    const ap = (await t.ask('ابعت لمنى السيد رسالة', sendText())).approvals![0]!;
    expect((await t.confirm(ap.approvalId, 'short')).status).toBe(400);
    await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at) VALUES ('sl.global', '{\"kill\":true}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    expect((await t.confirm(ap.approvalId, ap.token)).status).toBe(403);
    expect(await outbound(t)).toEqual([]);
  });
});

describe('wave 2 tools', () => {
  it('campaign_send_now: the card shows the audience, the template and the wallet estimate the product computes, and only the press sends', async () => {
    const t = await setup(7410, 'owner', ['منى']);
    await seedTemplate(t.s);
    await seedContacts(t.s, 3);
    installWallet({ perMessage: 150 });
    const camp = await makeCampaign(t.s, { criteria: { everyone: true } });
    expect(camp.status).toBe('draft');
    const out = await t.ask('ابعت حملة Eid sale دلوقتي', { name: 'campaign_send_now', args: { campaign: 'Eid sale' } });
    const card = out.previews[0]!;
    expect(card.policy).toBe('confirm');
    expect(card.reasons).toEqual(expect.arrayContaining(['money', 'customer_message', 'irreversible']));
    expect(JSON.stringify(card.rows)).toContain('promo');
    expect(card.rows.some((r) => typeof r.after === 'string' && /^\d+(\.\d+)?$/.test(r.after) && r.after !== '1')).toBe(true);
    expect(((await t.get(`/campaigns/${camp.id}`)) as { status: string }).status).toBe('draft');
    const res = (await (await t.confirm(out.approvals![0]!.approvalId, out.approvals![0]!.token)).json()) as { status: string };
    expect(res.status).toBe('applied');
    expect(((await t.get(`/campaigns/${camp.id}`)) as { status: string }).status).not.toBe('draft');
  });

  it('campaign_delete_draft is a delete confirm; an unknown campaign builds no card', async () => {
    const t = await setup(7411, 'owner', ['منى']);
    await seedTemplate(t.s);
    await seedContacts(t.s, 2);
    await makeCampaign(t.s);
    expect((await t.ask('امسح حملة مش موجودة', { name: 'campaign_delete_draft', args: { campaign: 'nope' } })).previews).toEqual([]);
    const out = await t.ask('امسح مسودة Eid sale', { name: 'campaign_delete_draft', args: { campaign: 'Eid sale' } });
    expect(out.previews[0]!.reasons).toContain('delete');
    await t.confirm(out.approvals![0]!.approvalId, out.approvals![0]!.token);
    expect(((await t.get('/campaigns')) as { items: unknown[] }).items).toEqual([]);
  });

  it('segment: create is preview class and its undo (delete) needs a confirm card; delete then Undo restores the segment', async () => {
    const t = await setup(7412);
    const made = await t.ask('اعمل شريحة VIP', { name: 'segment_upsert', args: { name: 'VIP', criteria: { everyone: true } } });
    const applied = (await (await t.apply(made.previews[0]!.previewId)).json()) as { appliedId: string };
    const undo = (await (await t.undo(applied.appliedId)).json()) as { status: string; approvals?: Array<{ approvalId: string; token: string }> };
    expect(undo.status).toBe('needs_confirm');
    expect(((await t.get('/segments')) as { items: unknown[] }).items).toHaveLength(1);
    expect(((await (await t.confirm(undo.approvals![0]!.approvalId, undo.approvals![0]!.token)).json()) as { status: string }).status).toBe('applied');
    expect(((await t.get('/segments')) as { items: unknown[] }).items).toEqual([]);
    // delete (confirm) then Undo: the segment comes back through segment_upsert, a preview-class restore
    const again = await t.ask('اعمل شريحة VIP', { name: 'segment_upsert', args: { name: 'VIP', criteria: { everyone: true } } });
    await t.apply(again.previews[0]!.previewId);
    const del = await t.ask('امسح شريحة VIP', { name: 'segment_delete', args: { segment: 'VIP' } });
    const done = (await (await t.confirm(del.approvals![0]!.approvalId, del.approvals![0]!.token)).json()) as { status: string; appliedId: string };
    expect(done.status).toBe('applied');
    expect(((await t.get('/segments')) as { items: unknown[] }).items).toEqual([]);
    expect(((await (await t.undo(done.appliedId)).json()) as { status: string }).status).toBe('undone');
    expect(((await t.get('/segments')) as { items: Array<{ name: string }> }).items.map((s) => s.name)).toEqual(['VIP']);
  });

  it('segment: Undo of a delete REFUSES when a segment with the same name was made since (nothing is overwritten) and writes nothing', async () => {
    const t = await setup(7414);
    const first = await t.ask('اعمل شريحة VIP', { name: 'segment_upsert', args: { name: 'VIP', criteria: { everyone: true } } });
    await t.apply(first.previews[0]!.previewId);
    const del = await t.ask('امسح شريحة VIP', { name: 'segment_delete', args: { segment: 'VIP' } });
    const done = (await (await t.confirm(del.approvals![0]!.approvalId, del.approvals![0]!.token)).json()) as { status: string; appliedId: string };
    expect(done.status).toBe('applied');
    // the merchant (or the assistant) makes a new "VIP" with a different filter before pressing Undo
    const made = await t.ask('اعمل شريحة VIP', { name: 'segment_upsert', args: { name: 'VIP', criteria: { tags: { any: ['vip'] } } } });
    await t.apply(made.previews[0]!.previewId);
    const undo = (await (await t.undo(done.appliedId)).json()) as { status: string };
    expect(undo.status).toBe('failed'); // refused: nothing is written (a stale card would have offered to overwrite)
    const list = ((await t.get('/segments')) as { items: Array<{ name: string; criteria: unknown }> }).items;
    expect(list).toHaveLength(1);
    expect(list[0]!.criteria).toEqual({ tags: { any: ['vip'] } }); // the newer segment is untouched
  });

  it('contact_erase and contact_merge keep phone numbers out of the stored draft', async () => {
    const t = await setup(7413, 'owner', ['منى السيد', 'سارة علي']);
    const m = await t.ask('ادمج سارة علي في منى السيد', { name: 'contact_merge', args: { from: 'سارة علي', into: 'منى السيد' } });
    expect(m.previews[0]!.reasons).toContain('delete');
    expect(JSON.stringify(await rows(t.s, 'SELECT json FROM sl_previews'))).not.toMatch(/2010123456/);
    await t.confirm(m.approvals![0]!.approvalId, m.approvals![0]!.token);
    expect(((await t.get('/contacts')) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('templates_install_defaults is confirm and irreversible; send_template needs an approved template', async () => {
    const t = await setup(7414);
    const d = await t.ask('نزّل قوالب البداية', { name: 'templates_install_defaults', args: {} });
    expect(d.previews[0]).toMatchObject({ policy: 'confirm', undo: 'irreversible' });
    const none = await t.ask('ابعت قالب لمنى السيد', { name: 'send_template', args: { customer: 'منى السيد', template: { name: 'missing', language: 'ar' }, params: [] } });
    expect(none.previews).toEqual([]);
  });

  it('campaign_schedule: confirm class, a past time builds no card, the press schedules it, and Undo is a cancel that needs its own confirm', async () => {
    const t = await setup(7415, 'owner', ['منى']);
    await seedTemplate(t.s);
    await seedContacts(t.s, 3);
    installWallet({ perMessage: 100 });
    const camp = await makeCampaign(t.s);
    const past = await t.ask('جدول الحملة', { name: 'campaign_schedule', args: { campaign: 'Eid sale', at: '2020-01-01T10:00:00+02:00' } });
    expect(past.previews).toEqual([]);
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const out = await t.ask('جدول حملة Eid sale بعد 3 ايام', { name: 'campaign_schedule', args: { campaign: 'Eid sale', at } });
    expect(out.previews[0]).toMatchObject({ policy: 'confirm' });
    const done = (await (await t.confirm(out.approvals![0]!.approvalId, out.approvals![0]!.token)).json()) as { status: string; appliedId: string };
    expect(done.status).toBe('applied');
    expect(((await t.get(`/campaigns/${camp.id}`)) as { status: string }).status).toBe('scheduled');
    const undo = (await (await t.undo(done.appliedId)).json()) as { status: string; approvals?: Array<{ approvalId: string; token: string }> };
    expect(undo.status).toBe('needs_confirm');
    expect(((await t.get(`/campaigns/${camp.id}`)) as { status: string }).status).toBe('scheduled');
    await t.confirm(undo.approvals![0]!.approvalId, undo.approvals![0]!.token);
    expect(((await t.get(`/campaigns/${camp.id}`)) as { status: string }).status).toBe('cancelled');
  });

  it('send_template: the card shows the text that will arrive, with the parameters filled in', async () => {
    const t = await setup(7416);
    await seedTemplate(t.s);
    const out = await t.ask('ابعت قالب لمنى السيد', { name: 'send_template', args: { customer: 'منى السيد', template: { name: 'promo', language: 'ar' }, params: ['منى', '50%'] } });
    expect(out.previews[0]).toMatchObject({ policy: 'confirm' });
    expect(out.previews[0]!.rows.some((r) => r.after === 'أهلا منى عرض 50%')).toBe(true);
    const wrongCount = await t.ask('ابعت قالب لمنى السيد', { name: 'send_template', args: { customer: 'منى السيد', template: { name: 'promo', language: 'ar' }, params: ['منى'] } });
    expect(wrongCount.previews).toEqual([]);
  });

});

describe('review fixes (#99): who a message really goes to, what it costs, and sending once', () => {
  const last3 = (waId: string) => waId.slice(-3);
  const waOf = async (t: Awaited<ReturnType<typeof setup>>, name: string) => ((await t.get('/contacts')) as { items: Array<{ waId: string; name: string }> }).items.find((c) => c.name === name)!.waId;

  it('the card names the MATCHED contact and the last 3 digits of their number, never the words the model typed', async () => {
    const t = await setup(7420, 'owner', ['أحمد علي']);
    const out = await t.ask('ابعت لأحمد رسالة', { name: 'send_text', args: { customer: 'أحمد', text: 'طلبك اتشحن' } });
    const card = out.previews[0]!;
    const who = JSON.stringify((card as unknown as { summary: unknown; rows: unknown }));
    expect(who).toContain('أحمد علي');
    expect(who).toContain(last3(await waOf(t, 'أحمد علي')));
    expect((card as unknown as { summary: { ar: string } }).summary.ar).not.toMatch(/لـ أحمد$/); // the model's words alone are never the label
  });

  it('more than one plausible match (even with an exact one among them): no card, nothing sent', async () => {
    const t = await setup(7421, 'owner', ['أحمد', 'أحمد علي']);
    const out = await t.ask('ابعت لأحمد رسالة', { name: 'send_text', args: { customer: 'أحمد', text: 'طلبك اتشحن' } });
    expect(out.previews).toEqual([]);
    expect(await outbound(t)).toEqual([]);
  });

  it('the matched identity is part of the stale check: if the match changes between card and press, the press re-previews and sends nothing', async () => {
    const t = await setup(7422, 'owner', ['أحمد علي']);
    const out = await t.ask('ابعت لأحمد علي رسالة', { name: 'send_text', args: { customer: 'أحمد علي', text: 'طلبك اتشحن' } });
    const ap = out.approvals![0]!;
    await t.api.call('PATCH', `/contacts/${await waOf(t, 'أحمد علي')}`, { name: 'أحمد علي الكبير' });
    const res = (await (await t.confirm(ap.approvalId, ap.token)).json()) as { status: string };
    expect(['stale', 'failed']).toContain(res.status);
    expect(await outbound(t)).toEqual([]);
  });

  it('a contact who opted out is never messaged by the assistant (text or template)', async () => {
    const t = await setup(7423, 'owner', ['منى السيد']);
    await seedTemplate(t.s);
    await exec(t.s, "UPDATE contacts SET opted_out_at = 1000 WHERE profile_name = 'منى السيد'");
    expect((await t.ask('ابعت لمنى رسالة', { name: 'send_text', args: { customer: 'منى السيد', text: 'اهلا' } })).previews).toEqual([]);
    expect((await t.ask('ابعت قالب لمنى', { name: 'send_template', args: { customer: 'منى السيد', template: { name: 'promo', language: 'ar' }, params: ['منى', '50%'] } })).previews).toEqual([]);
    expect(await outbound(t)).toEqual([]);
  });

  it('no confirm card without a cost: send now, schedule and resume are refused until the estimate exists; with a wallet they build the card', async () => {
    const t = await setup(7424, 'owner', ['منى']);
    await seedTemplate(t.s);
    await seedContacts(t.s, 3);
    const camp = await makeCampaign(t.s);
    await env.DB.prepare("INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, 'platform_line', 0)").bind(`pn-${t.s}`).run();
    await t.ws.refreshPricing();
    const at = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const send = { name: 'campaign_send_now', args: { campaign: 'Eid sale' } };
    const sched = { name: 'campaign_schedule', args: { campaign: 'Eid sale', at } };
    resetWallet();
    expect((await t.ask('ابعت حملة Eid sale دلوقتي', send)).previews).toEqual([]);
    expect((await t.ask('جدول حملة Eid sale', sched)).previews).toEqual([]);
    await exec(t.s, "UPDATE campaigns SET status = 'paused' WHERE id = ?", camp.id);
    expect((await t.ask('كمّل حملة Eid sale', { name: 'campaign_resume', args: { campaign: 'Eid sale' } })).previews).toEqual([]);
    installWallet({ perMessage: 150 });
    await exec(t.s, "UPDATE campaigns SET status = 'draft' WHERE id = ?", camp.id);
    expect((await t.ask('ابعت حملة Eid sale دلوقتي', send)).previews).toHaveLength(1);
    expect((await t.ask('جدول حملة Eid sale', sched)).previews).toHaveLength(1);
    // a number Meta bills to the merchant's own card has a zero wallet estimate that is the truth: the card says so instead of a price
    resetWallet();
    await env.DB.prepare("INSERT OR REPLACE INTO number_funding (phone_number_id, funding, updated_at) VALUES (?, 'merchant_card', 0)").bind(`pn-${t.s}`).run();
    await t.ws.refreshPricing();
    const card = await t.ask('ابعت حملة Eid sale دلوقتي', send);
    expect(JSON.stringify(card.previews[0]?.rows)).toContain('Meta bills your card');
    await exec(t.s, "UPDATE campaigns SET status = 'paused' WHERE id = ?", camp.id);
    expect((await t.ask('كمّل حملة Eid sale', { name: 'campaign_resume', args: { campaign: 'Eid sale' } })).previews).toHaveLength(1); // card-billed: the card says so
  });

  it('the send key belongs to the PREVIEW: a crashed apply that is retried on a fresh approval of the same preview cannot send twice', async () => {
    const t = await setup(7425);
    const out = await t.ask('ابعت لمنى السيد رسالة', sendText());
    const ap = out.approvals![0]!;
    expect(await status(await t.confirm(ap.approvalId, ap.token))).toBe('applied');
    expect(await outbound(t)).toHaveLength(1);
    // simulate the crash: the preview is open again and the engine issued a new approval for the same preview
    const previewId = out.previews[0]!.previewId;
    const pv = (await t.ws.smartLayer('getPreview', [t.s, previewId])) as { payloadHash: string };
    await t.ws.smartLayer('transitionPreview', [t.s, previewId, 'applied', 'open']);
    await t.ws.smartLayer('putApproval', [{ id: crypto.randomUUID(), storeId: t.s, userId: '6f1d2c1e-8a8f-4a3b-9f1e-1a2b3c4d5e6f', previewId, tokenHash: await sha256Hex('retry-token-retry-token-retry'), payloadHash: pv.payloadHash, expiresAt: Date.now() + 600_000, status: 'pending', createdAt: Date.now() }]);
    const retry = (await t.ws.smartLayer('loadDecisions', [t.s, 'none'])) as unknown[];
    void retry;
    const rows2 = (await rows(t.s, "SELECT id FROM sl_approvals WHERE status = 'pending'")) as Array<{ id: string }>;
    expect(await status(await t.confirm(rows2[0]!.id, 'retry-token-retry-token-retry'))).toBe('applied');
    expect(await outbound(t)).toHaveLength(1);
  });
});
