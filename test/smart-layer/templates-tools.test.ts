import { env } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TemplateDraftInput } from '../../src/core/api/contract';
import { configureAssistant } from '../../src/routes/assistant';
import { graphStub, useApiKey } from '../helpers/api';
import { makeCampaign, seedContacts, seedTemplate } from '../helpers/campaigns';
import type { stubGraph } from '../helpers/graph';
import { exec, rows } from '../helpers/workspace';
import { scriptedAi, setup } from './harness';

useApiKey();
let graph: ReturnType<typeof stubGraph> | undefined;
beforeEach(async () => { await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at) VALUES ('sl.global', '{\"mode\":\"act\"}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(); });
afterEach(() => { graph?.restore(); configureAssistant({}); });

const draft = (over: Partial<TemplateDraftInput> = {}): TemplateDraftInput => ({
  name: 'shipping_update', label: 'تحديث الشحن', language: 'ar', category: 'UTILITY', header: null,
  body: { text: 'أهلاً {{1}}، طلبك رقم {{2}} خرج للشحن وهيوصلك خلال {{3}}.', examples: ['أحمد', '1001', 'يومين'] }, footer: null, buttons: [], ...over,
});
const created = () => graphStub(() => ({ status: 200, json: { id: 'meta-1', status: 'PENDING', category: 'UTILITY' } }));
const submits = () => graph!.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/message_templates'));
const ASK = 'قدّم قالب شحن جديد لميتا';
const SUBMIT = (d = draft()) => ({ name: 'template_submit', args: d });

describe('template tools over the templates service', () => {
  it('submit: the preview carries the check hash as expectedHash; the press posts the exact previewed draft with it', async () => {
    const t = await setup(7501);
    graph = created();
    const out = await t.ask(ASK, SUBMIT());
    const card = out.previews[0]!;
    expect(card).toMatchObject({ policy: 'confirm', undo: 'irreversible' });
    // the message is drawn as the customer will see it (the panel renders the draft object as a WhatsApp card)
    expect(card.rows.some((r) => (r.after as { kind?: string; draft?: { body: { text: string } } } | undefined)?.kind === 'whatsapp_template' && (r.after as { draft: { body: { text: string } } }).draft.body.text === draft().body.text)).toBe(true);
    const check = (await (await t.api.call('POST', '/templates/check', draft())).json()) as { payloadHash: string };
    const stored = JSON.parse(String((await rows(t.s, 'SELECT json FROM sl_previews'))[0]!.json)) as { draft: { payload: { body: { expectedHash: string; body: { text: string } } } } };
    expect(stored.draft.payload.body.expectedHash).toBe(check.payloadHash);
    expect(submits()).toEqual([]); // nothing reached Meta
    const ap = out.approvals![0]!;
    expect(((await (await t.confirm(ap.approvalId, ap.token)).json()) as { status: string }).status).toBe('applied');
    expect(submits()).toHaveLength(1);
    expect(submits()[0]!.body).toMatchObject({ name: 'shipping_update', category: 'UTILITY', components: [{ type: 'BODY', text: draft().body.text }] });
    expect(await rows(t.s, 'SELECT name, status FROM templates')).toEqual([{ name: 'shipping_update', status: 'PENDING' }]);
  });

  it('what the check says changed between the preview and the press (the same text now exists under another name): the press does not submit', async () => {
    const t = await setup(7502);
    graph = created();
    const out = await t.ask(ASK, SUBMIT());
    const ap = out.approvals![0]!;
    await exec(t.s, "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('other_name', 'ar', 'UTILITY', 'APPROVED', ?, 1)", JSON.stringify([{ type: 'BODY', text: draft().body.text }]));
    const res = (await (await t.confirm(ap.approvalId, ap.token)).json()) as { status: string };
    // a new warning would be a new card (stale); a new ERROR (Meta refuses a duplicate text) cannot even be previewed again: either way nothing is submitted
    expect(['stale', 'failed']).toContain(res.status);
    expect(submits()).toEqual([]);
  });

  it('an error issue builds no preview; template_check tells the merchant in plain Arabic and English what to fix', async () => {
    const t = await setup(7503);
    graph = created();
    const bad = draft({ body: { text: '{{1}} أهلاً', examples: ['x'] } });
    expect((await t.ask(ASK, SUBMIT(bad))).previews).toEqual([]);
    expect(await rows(t.s, 'SELECT count(*) AS n FROM sl_previews')).toEqual([{ n: 0 }]);
    const ai = scriptedAi([{ call: { name: 'template_check', args: bad } }, { text: 'في مشكلة.' }]);
    await t.ask('افحص القالب ده قبل ما اقدمه', undefined, ai);
    const result = ai.seen.join(' ');
    expect(result).toContain('variable_at_edge');
    expect(result).toContain('متبدأش الرسالة');
  });

  it('staff can check and list; the submit card is built but the press is a 403 from the route and nothing reaches Meta', async () => {
    const t = await setup(7504, 'staff');
    graph = created();
    const ai = scriptedAi([{ call: { name: 'template_check', args: draft() } }, { text: 'سليم.' }]);
    await t.ask('افحص القالب', undefined, ai);
    expect(ai.seen.join(' ')).toContain('canSubmit');
    const out = await t.ask(ASK, SUBMIT());
    expect(out.previews).toHaveLength(1);
    const ap = out.approvals![0]!;
    expect((await t.confirm(ap.approvalId, ap.token)).status).toBe(403);
    expect(submits()).toEqual([]);
  });

  it('template_status shows Meta\'s reason with plain advice and, when the edit limit applies, the time it unlocks', async () => {
    const t = await setup(7505);
    await exec(t.s, "INSERT INTO templates (name, language, category, status, components, updated_at, meta_id) VALUES ('shipping_update', 'ar', 'UTILITY', 'APPROVED', '[]', 1, 'm-9')");
    const at = Date.now() - 5_000;
    await exec(t.s, 'INSERT INTO template_edits (name, language, at) VALUES (?, ?, ?)', 'shipping_update', 'ar', at);
    const ai = scriptedAi([{ call: { name: 'template_status', args: { name: 'shipping_update', language: 'ar' } } }, { text: 'تقدر تعدله بعد كده.' }]);
    await t.ask('حالة قالب shipping_update', undefined, ai);
    const seen = ai.seen.join(' ');
    expect(seen).toContain('editUnlocksAt');
    expect(seen).toContain('canEdit');
    // and an edit now builds no card: the limit is the product's, not the assistant's to talk around
    graph = created();
    expect((await t.ask('عدّل القالب', { name: 'template_edit', args: draft() })).previews).toEqual([]);
  });

  it('a REJECTED template is edited through a confirm card that carries the new hash; the press sends one edit', async () => {
    const t = await setup(7506);
    await exec(t.s, "INSERT INTO templates (name, language, category, status, components, updated_at, meta_id, rejected_reason) VALUES ('shipping_update', 'ar', 'UTILITY', 'REJECTED', '[{\"type\":\"BODY\",\"text\":\"قديم\"}]', 1, 'm-9', 'INVALID_FORMAT')");
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    const out = await t.ask('عدّل القالب وصلّحه', { name: 'template_edit', args: draft() });
    expect(out.previews[0]).toMatchObject({ policy: 'confirm' });
    const ap = out.approvals![0]!;
    expect(((await (await t.confirm(ap.approvalId, ap.token)).json()) as { status: string }).status).toBe('applied');
    expect(graph.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/m-9'))).toHaveLength(1);
  });

  it('delete: refused while a campaign still uses the template (nothing deleted); with none, a confirm card says the name is blocked for 30 days', async () => {
    const t = await setup(7507, 'owner', ['منى']);
    await seedTemplate(t.s);
    await seedContacts(t.s, 2);
    await makeCampaign(t.s);
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    expect((await t.ask('امسح القالب promo', { name: 'template_delete', args: { name: 'promo', language: 'ar' } })).previews).toEqual([]);
    expect(await rows(t.s, "SELECT name FROM templates WHERE name = 'promo'")).toEqual([{ name: 'promo' }]);
    await exec(t.s, "DELETE FROM campaigns");
    const out = await t.ask('امسح القالب promo', { name: 'template_delete', args: { name: 'promo', language: 'ar' } });
    expect(out.previews[0]).toMatchObject({ policy: 'confirm' });
    expect(out.previews[0]!.reasons).toContain('delete');
    expect(JSON.stringify(out.previews[0]!.rows)).toContain('30');
  });
});
