import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TemplateDraftInput } from '../../src/core/api/contract';
import { creditsAvailable, grantCredits } from '../../src/core/ai/credits';
import { configureAssistant } from '../../src/routes/assistant';
import { graphStub, useApiKey } from '../helpers/api';
import type { stubGraph } from '../helpers/graph';
import { exec, rows } from '../helpers/workspace';
import { scriptedAi, setup } from './harness';

useApiKey();
let graph: ReturnType<typeof stubGraph> | undefined;
beforeEach(async () => { await env.DB.prepare("INSERT INTO platform_flags (key, value, updated_at) VALUES ('sl.global', '{\"mode\":\"act\"}', 0) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(); });
afterEach(() => { graph?.restore(); configureAssistant({}); });

const good: TemplateDraftInput = {
  name: 'order_shipped', label: 'تحديث الشحن', language: 'ar', category: 'UTILITY', header: null,
  body: { text: 'أهلاً {{1}}، طلبك رقم {{2}} خرج للشحن وهيوصلك خلال {{3}}.', examples: ['أحمد', '1001', 'يومين'] }, footer: null, buttons: [],
};
const json = (d: unknown) => ({ text: JSON.stringify(d) });
const WRITE = (request = 'رسالة أبلغ بيها العميل إن الأوردر اتشحن') => ({ call: { name: 'template_write', args: { request } } });
const writerCalls = (ai: { seen: string[] }) => ai.seen.filter((x) => x.includes('You write WhatsApp Business message templates'));
const grant = (s: string, ws: ReturnType<typeof import('../helpers/workspace').workspace>, credits = 10) => runInDurableObject(ws, (_i, st) => { grantCredits(st.storage.sql, { periodStart: Date.now(), packageId: 'p', credits, now: Date.now() }); });
const avail = (ws: ReturnType<typeof import('../helpers/workspace').workspace>) => runInDurableObject(ws, (_i, st) => creditsAvailable(st.storage.sql, Date.now()));
const ASK = 'عايز رسالة أبلغ بيها العميل إن الأوردر اتشحن';
const created = () => graphStub(() => ({ status: 200, json: { id: 'meta-1', status: 'PENDING', category: 'UTILITY' } }));
const bubble = (c: { rows: Array<{ after?: unknown }> }) => c.rows.map((r) => r.after as { kind?: string; draft?: TemplateDraftInput }).find((x) => x?.kind === 'whatsapp_template')?.draft;

describe('template writer (plan 4 D2)', () => {
  it('"tell the customer the order shipped" -> a UTILITY Arabic draft with a variable and its example, no error issues, shown with its cost; nothing is submitted', async () => {
    const t = await setup(7601);
    await grant(t.s, t.ws);
    graph = created();
    const ai = scriptedAi([WRITE(), json(good), { text: 'جهزت لك القالب.' }]);
    const out = await t.ask(ASK, undefined, ai);
    const card = out.previews[0] as typeof out.previews[0] & { costCredits?: number };
    expect(card).toMatchObject({ policy: 'confirm', costCredits: 2 });
    const d = bubble(card)!;
    expect(d).toMatchObject({ category: 'UTILITY', language: 'ar' });
    expect(d.body.text).toContain('{{1}}');
    expect(d.body.examples.length).toBe(3);
    expect(graph.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/message_templates'))).toEqual([]);
    expect(await avail(t.ws)).toBe(8); // two credits spent on the draft
    expect(await rows(t.s, "SELECT kind, amount, note FROM credit_ledger WHERE kind = 'ai_charge'")).toEqual([{ kind: 'ai_charge', amount: -2, note: 'assistant' }]);
  });

  it('a draft with {{1}} and {{3}} is sent back once with the problem codes and the fixed draft is what the merchant sees', async () => {
    const t = await setup(7602);
    await grant(t.s, t.ws);
    const bad = { ...good, body: { text: 'أهلاً {{1}}، طلبك خرج للشحن وهيوصلك في {{3}}.', examples: ['أحمد', '1001', 'يومين'] } };
    const ai = scriptedAi([WRITE(), json(bad), json(good), { text: 'تمام.' }]);
    const out = await t.ask(ASK, undefined, ai);
    const calls = writerCalls(ai);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain('variable_gap');
    expect(bubble(out.previews[0]!)!.body.text).toBe(good.body.text);
    expect(await avail(t.ws)).toBe(8); // charged once for the two rounds
  });

  it('a utility ask that is really a promotion keeps Meta\'s category warning on the card', async () => {
    const t = await setup(7603);
    await grant(t.s, t.ws);
    const promo = { ...good, name: 'eid_offer', body: { text: 'أهلاً {{1}}، خصم ٢٠٪ على كل المنتجات بمناسبة العيد، اطلب دلوقتي من متجرنا.', examples: ['منى'] } };
    const out = await t.ask('خصم ٢٠٪ للعيد', undefined, scriptedAi([WRITE('خصم ٢٠٪ للعيد على كل المنتجات'), json(promo), { text: 'تمام.' }]));
    const card = out.previews[0]!;
    expect(bubble(card)!.category).toBe('UTILITY');
    expect(JSON.stringify(card.rows)).toContain('تنبيه');
  });

  it('not enough credits: no model call for the writer, no card, nothing charged', async () => {
    const t = await setup(7604);
    await grant(t.s, t.ws, 1);
    const ai = scriptedAi([WRITE(), json(good), { text: 'مش قادر.' }]);
    const out = await t.ask(ASK, undefined, ai);
    expect(out.previews).toEqual([]);
    expect(writerCalls(ai)).toEqual([]);
    expect(await avail(t.ws)).toBe(1);
  });

  it('credits are held before the model call and released when the writer fails; nothing is charged', async () => {
    const t = await setup(7605);
    await grant(t.s, t.ws);
    let heldDuringCall = -1;
    const ai = scriptedAi([WRITE(), { text: 'مش JSON' }, { text: 'برضه مش JSON' }, { text: 'آسف.' }]);
    const run = ai.run;
    ai.run = async (m, inputs) => {
      if (JSON.stringify(inputs).includes('You write WhatsApp Business message templates') && heldDuringCall < 0) heldDuringCall = ((await (await t.api.call('GET', '/agent')).json()) as { credits: number }).credits;
      return run(m, inputs);
    };
    const out = await t.ask(ASK, undefined, ai);
    expect(out.previews).toEqual([]);
    expect(heldDuringCall).toBe(8); // the hold was already there when the model was called
    expect(await avail(t.ws)).toBe(10); // released
    expect(await rows(t.s, "SELECT count(*) AS n FROM credit_ledger WHERE kind = 'ai_charge'")).toEqual([{ n: 0 }]);
  });

  it('the press submits exactly the draft that was shown, with one Meta call, and does not call the model again or charge again', async () => {
    const t = await setup(7606);
    await grant(t.s, t.ws);
    graph = created();
    const ai = scriptedAi([WRITE(), json(good), { text: 'تمام.' }]);
    const out = await t.ask(ASK, undefined, ai);
    const before = writerCalls(ai).length;
    const ap = out.approvals![0]!;
    expect(((await (await t.confirm(ap.approvalId, ap.token)).json()) as { status: string }).status).toBe('applied');
    expect(writerCalls(ai).length).toBe(before);
    const posts = graph.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/message_templates'));
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({ name: 'order_shipped', category: 'UTILITY', components: [{ type: 'BODY', text: good.body.text }] });
    expect(await avail(t.ws)).toBe(8);
  });

  it('a name already in use gets a free one (_v2)', async () => {
    const t = await setup(7607);
    await grant(t.s, t.ws);
    await exec(t.s, "INSERT INTO templates (name, language, category, status, components, updated_at) VALUES ('order_shipped', 'ar', 'UTILITY', 'APPROVED', '[{\"type\":\"BODY\",\"text\":\"قديم تمامًا مختلف\"}]', 1)");
    const out = await t.ask(ASK, undefined, scriptedAi([WRITE(), json(good), { text: 'تمام.' }]));
    expect(bubble(out.previews[0]!)!.name).toBe('order_shipped_v2');
  });

  it('template_fix on a REJECTED template starts from the stored text and Meta\'s reason, keeps its name, and the press edits it once', async () => {
    const t = await setup(7608);
    await grant(t.s, t.ws);
    await exec(t.s, "INSERT INTO templates (name, language, category, status, components, updated_at, meta_id, rejected_reason, label) VALUES ('order_shipped', 'ar', 'UTILITY', 'REJECTED', ?, 1, 'm-9', 'INVALID_FORMAT', 'تحديث الشحن')", JSON.stringify([{ type: 'BODY', text: '{{1}} طلبك خرج', example: { body_text: [['x']] } }]));
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    const ai = scriptedAi([{ call: { name: 'template_fix', args: { name: 'order_shipped', language: 'ar' } } }, json({ ...good, name: 'something_else' }), { text: 'صلّحته.' }]);
    const out = await t.ask('القالب order_shipped اترفض صلّحه', undefined, ai);
    const req = writerCalls(ai)[0]!;
    expect(req).toContain('INVALID_FORMAT');
    expect(req).toContain('{{1}} طلبك خرج');
    expect(bubble(out.previews[0]!)!.name).toBe('order_shipped'); // a fix never renames
    const ap = out.approvals![0]!;
    expect(((await (await t.confirm(ap.approvalId, ap.token)).json()) as { status: string }).status).toBe('applied');
    expect(graph.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/m-9'))).toHaveLength(1);
  });

  it('a staff member can ask for a draft (it is charged to the workspace) but the press is refused by the route', async () => {
    const t = await setup(7609, 'staff');
    await grant(t.s, t.ws);
    graph = created();
    const out = await t.ask(ASK, undefined, scriptedAi([WRITE(), json(good), { text: 'تمام.' }]));
    expect(out.previews).toHaveLength(1);
    const ap = out.approvals![0]!;
    expect((await t.confirm(ap.approvalId, ap.token)).status).toBe(403);
    expect(graph.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/message_templates'))).toEqual([]);
  });

  it('the cached draft is erased with the store and with the person', async () => {
    const t = await setup(7610);
    await grant(t.s, t.ws);
    await t.ask(ASK, undefined, scriptedAi([WRITE(), json(good), { text: 'تمام.' }]));
    expect(await rows(t.s, 'SELECT count(*) AS n FROM sl_cache')).toEqual([{ n: 1 }]);
    await t.ws.smartLayer('eraseStore', [t.s]);
    expect(await rows(t.s, 'SELECT count(*) AS n FROM sl_cache')).toEqual([{ n: 0 }]);
  });
});
