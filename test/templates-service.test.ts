import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import { EBDA_DEFAULT_TEMPLATES } from '../src/addons/ebda/templates';
import { checkOnly, createTemplate, deleteTemplate, editTemplate, installDefaults, refreshPending, syncTemplates, type TemplatesCtx } from '../src/core/templates-service';
import { payloadHash, type TemplateDraft } from '../src/core/template-draft';
import { clearTokenCaches } from '../src/core/numbers/token';
import { graphStub, storeId as W, useApiKey } from './helpers/api';
import { makeCampaign, seedContacts, seedTemplate } from './helpers/campaigns';
import type { stubGraph } from './helpers/graph';
import { exec, rows, seedNumber, workspace } from './helpers/workspace';

useApiKey();
let graph: ReturnType<typeof stubGraph> | undefined;
afterEach(() => { graph?.restore(); clearTokenCaches(); });

const DAY = 86_400_000;
const draft = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({
  name: 'shipping_update', label: 'تحديث الشحن', language: 'ar', category: 'UTILITY', header: null,
  body: { text: 'أهلاً {{1}}، طلبك رقم {{2}} خرج للشحن وهيوصلك خلال {{3}}.', examples: ['أحمد', '1001', 'يومين'] }, footer: null, buttons: [], ...over,
});
async function ctx(n: number): Promise<TemplatesCtx> {
  const id = W(n);
  await seedNumber(`pn-${id}`, id);
  return { env, ws: workspace(id), workspaceId: id, number: { phoneNumberId: `pn-${id}`, wabaId: 'waba-1' } };
}
const mk = async (c: TemplatesCtx, d: TemplateDraft) => createTemplate(c, d, { expectedHash: await payloadHash(d) });
const ed = async (c: TemplatesCtx, d: TemplateDraft) => editTemplate(c, d, { expectedHash: await payloadHash(d) });
const ok = (json: unknown = { id: 'meta-1', status: 'PENDING', category: 'UTILITY' }) => ({ status: 200, json });
const metaCalls = () => graph!.calls.filter((c) => c.url.includes('/message_templates') || /\/v[\d.]+\/(meta-|tpl-)/.test(c.url));

describe('checkOnly', () => {
  it('is free: no Graph call, returns issues and the hash', async () => {
    const c = await ctx(400);
    graph = graphStub(() => ok());
    const bad = draft({ body: { text: '{{1}} أهلاً', examples: ['x'] } });
    const r = await checkOnly(c, bad);
    expect(r.issues.map((i) => i.code)).toContain('variable_at_edge');
    expect(r.payloadHash).toBe(await payloadHash(bad));
    expect(graph.calls.filter((x) => x.url.includes('message_templates'))).toEqual([]);
  });
});

describe('createTemplate', () => {
  it('submits toMetaComponents output and stores PENDING with the merchant label', async () => {
    const c = await ctx(401);
    graph = graphStub(() => ok());
    const r = await mk(c, draft());
    expect(r).toEqual({ ok: true, name: 'shipping_update', language: 'ar', status: 'PENDING', category: 'UTILITY', categoryChanged: false });
    expect(metaCalls()[0]).toMatchObject({ method: 'POST', url: 'https://graph.facebook.com/v25.0/waba-1/message_templates', body: { name: 'shipping_update', language: 'ar', category: 'UTILITY', components: [{ type: 'BODY', text: draft().body.text, example: { body_text: [['أحمد', '1001', 'يومين']] } }] } });
    expect(await rows(c.workspaceId, 'SELECT name, status, meta_id, label FROM templates')).toEqual([{ name: 'shipping_update', status: 'PENDING', meta_id: 'meta-1', label: 'تحديث الشحن' }]);
  });
  it('an error issue is invalid and Graph is never called', async () => {
    const c = await ctx(402);
    graph = graphStub(() => ok());
    const r = await mk(c, draft({ body: { text: '{{1}} أهلاً', examples: ['x'] } }));
    expect(r).toMatchObject({ ok: false, reason: 'invalid' });
    expect(metaCalls()).toEqual([]);
    expect(await rows(c.workspaceId, 'SELECT 1 FROM templates')).toEqual([]);
  });
  it('a second create of the same name+language is exists, Graph called once only', async () => {
    const c = await ctx(403);
    graph = graphStub(() => ok());
    expect((await mk(c, draft())).ok).toBe(true);
    expect(await mk(c, draft())).toMatchObject({ ok: false, reason: 'exists' });
    expect(metaCalls()).toHaveLength(1);
  });
  it('two taps at once (slow Meta) submit ONCE: the loser is exists before any Meta call', async () => {
    const c = await ctx(404);
    graph = graphStub(() => ok(), 40);
    const [a, b] = await Promise.all([mk(c, draft()), mk(c, draft())]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)).toMatchObject({ reason: 'exists' });
    expect(metaCalls()).toHaveLength(1);
  });
  it('a definite Meta refusal (4xx) releases the name so the merchant can fix and retry', async () => {
    const c = await ctx(405);
    graph = graphStub(() => ({ status: 400, json: { error: { message: 'Invalid parameter' } } }));
    expect(await mk(c, draft())).toEqual({ ok: false, reason: 'meta_rejected', message: 'Invalid parameter' });
    expect(await rows(c.workspaceId, 'SELECT 1 FROM templates')).toEqual([]);
  });
  it('an ambiguous failure (503 / timeout) KEEPS the claim as PENDING: Meta may have created it, and the sweep reconciles it', async () => {
    const c = await ctx(430);
    graph = graphStub(() => ({ status: 503, json: {} }));
    expect(await mk(c, draft())).toMatchObject({ ok: false, reason: 'meta_unavailable' });
    expect(await rows(c.workspaceId, 'SELECT name, status, meta_id FROM templates')).toEqual([{ name: 'shipping_update', status: 'PENDING', meta_id: null }]);
    expect(await rows(c.workspaceId, "SELECT kind FROM scheduled_tasks WHERE kind = 'template_refresh'")).toEqual([{ kind: 'template_refresh' }]);
    expect(await mk(c, draft())).toMatchObject({ ok: false, reason: 'exists' }); // a quick retry is the same claim, never a second submission
    expect(metaCalls()).toHaveLength(1);
  });
  it('a stale ambiguous claim that Meta DOES have is adopted on retry and shown, never hidden behind "already exists"', async () => {
    const c = await ctx(431);
    graph = graphStub(() => ({ status: 503, json: {} }));
    await mk(c, draft());
    graph.restore();
    await exec(c.workspaceId, 'UPDATE templates SET submitted_at = 1, updated_at = 1');
    graph = graphStub((call) => (call.method === 'GET' ? { status: 200, json: { data: [{ id: 'at-meta', name: 'shipping_update', language: 'ar', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'x y.' }] }] } } : { status: 400, json: { error: { message: 'Template name already exists' } } }));
    expect(await mk(c, draft())).toMatchObject({ ok: false, reason: 'exists' });
    expect(await rows(c.workspaceId, 'SELECT status, meta_id, label FROM templates')).toEqual([{ status: 'APPROVED', meta_id: 'at-meta', label: 'تحديث الشحن' }]);
    expect(graph.calls.filter((x) => x.method === 'POST')).toEqual([]); // adopted, not resubmitted
  });
  it('a stale ambiguous claim that Meta does NOT have is dropped and the retry submits fresh', async () => {
    const c = await ctx(432);
    graph = graphStub(() => ({ status: 503, json: {} }));
    await mk(c, draft());
    graph.restore();
    await exec(c.workspaceId, 'UPDATE templates SET submitted_at = 1, updated_at = 1');
    graph = graphStub((call) => (call.method === 'GET' ? { status: 200, json: { data: [] } } : ok()));
    expect(await mk(c, draft())).toMatchObject({ ok: true, status: 'PENDING' });
    expect(await rows(c.workspaceId, 'SELECT meta_id FROM templates')).toEqual([{ meta_id: 'meta-1' }]);
  });
  it('a definite "already exists" from Meta for a template we do not have adopts the existing one and says so', async () => {
    const c = await ctx(433);
    graph = graphStub((call) => (call.method === 'GET' ? { status: 200, json: { data: [{ id: 'old-1', name: 'shipping_update', language: 'ar', category: 'UTILITY', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', components: [{ type: 'BODY', text: 'x y.' }] }] } } : { status: 400, json: { error: { message: 'Template name already exists' } } }));
    expect(await mk(c, draft())).toMatchObject({ ok: false, reason: 'exists' });
    expect(await rows(c.workspaceId, 'SELECT status, meta_id, rejected_reason FROM templates')).toEqual([{ status: 'REJECTED', meta_id: 'old-1', rejected_reason: 'INVALID_FORMAT' }]);
  });
  it('expectedHash mismatch is payload_changed and Graph is never called; a matching hash submits', async () => {
    const c = await ctx(406);
    graph = graphStub(() => ok());
    const confirmed = draft();
    const tampered = draft({ body: { ...confirmed.body, examples: ['أحمد', '9999', 'يومين'] } });
    expect(await createTemplate(c, tampered, { expectedHash: await payloadHash(confirmed) })).toMatchObject({ ok: false, reason: 'payload_changed' });
    expect(metaCalls()).toEqual([]);
    expect((await createTemplate(c, confirmed, { expectedHash: await payloadHash(confirmed) })).ok).toBe(true);
  });
  it("Meta answering MARKETING for a requested UTILITY is categoryChanged and the stored category is MARKETING", async () => {
    const c = await ctx(407);
    graph = graphStub(() => ok({ id: 'meta-2', status: 'PENDING', category: 'MARKETING' }));
    const r = await mk(c, draft());
    expect(r).toMatchObject({ ok: true, category: 'MARKETING', categoryChanged: true });
    expect(await rows(c.workspaceId, 'SELECT category FROM templates')).toEqual([{ category: 'MARKETING' }]);
  });
  it('an unusable token is token_unavailable and no Graph call is made', async () => {
    const c = await ctx(408);
    await env.DB.prepare("INSERT OR REPLACE INTO waba_credentials (waba_id, workspace_id, token_enc, kind, created_at, updated_at) VALUES ('waba-1', ?, 'garbage', 'own', 1, 1)").bind(c.workspaceId).run();
    graph = graphStub(() => ok());
    try {
      expect(await mk(c, draft())).toMatchObject({ ok: false, reason: 'token_unavailable' });
      expect(metaCalls()).toEqual([]);
      expect(await rows(c.workspaceId, 'SELECT 1 FROM templates')).toEqual([]);
    } finally {
      await env.DB.prepare("DELETE FROM waba_credentials WHERE waba_id = 'waba-1'").run();
    }
  });
});

describe('expectedHash is required (the approval is bound to the previewed payload)', () => {
  it('createTemplate and editTemplate without a hash are hash_required and never reach Meta, nor claim a name', async () => {
    const c = await ctx(434);
    graph = graphStub(() => ok());
    expect(await createTemplate(c, draft(), {} as never)).toMatchObject({ ok: false, reason: 'hash_required' });
    expect(await createTemplate(c, draft(), { expectedHash: '' })).toMatchObject({ ok: false, reason: 'hash_required' });
    expect(await editTemplate(c, draft(), {} as never)).toMatchObject({ ok: false, reason: 'hash_required' });
    expect(metaCalls()).toEqual([]);
    expect(await rows(c.workspaceId, 'SELECT 1 FROM templates')).toEqual([]);
  });
});

describe('editTemplate', () => {
  const seed = async (n: number, status: string, over: Record<string, string> = {}) => {
    const c = await ctx(n);
    await c.ws.saveSubmittedTemplate({ name: 'shipping_update', language: 'ar', category: over.category ?? 'UTILITY', status, components: [{ type: 'BODY', text: 'قديم {{1}} نص.' }], metaId: over.metaId ?? 'meta-1', label: 'تحديث الشحن' });
    return c;
  };
  it('APPROVED within 24 h of the last edit is edit_limit with retryAt; Graph not called', async () => {
    const c = await seed(409, 'APPROVED');
    const at = Date.now() - 5_000;
    await c.ws.recordTemplateEdit('shipping_update', 'ar', at);
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    expect(await ed(c, draft())).toEqual({ ok: false, reason: 'edit_limit', retryAt: at + DAY });
    expect(metaCalls()).toEqual([]);
  });
  it('an APPROVED template cannot change category: not_editable', async () => {
    const c = await seed(410, 'APPROVED');
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    expect(await ed(c, draft({ category: 'MARKETING' }))).toMatchObject({ ok: false, reason: 'not_editable' });
    expect(metaCalls()).toEqual([]);
  });
  it('a PENDING template is not editable', async () => {
    const c = await seed(411, 'PENDING');
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    expect(await ed(c, draft())).toMatchObject({ ok: false, reason: 'not_editable' });
  });
  it('REJECTED edit succeeds: posts to the Meta id with components, status PENDING, reason cleared, not counted against the approved limit', async () => {
    const c = await seed(412, 'REJECTED');
    await exec(c.workspaceId, "UPDATE templates SET rejected_reason = 'INVALID_FORMAT'");
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    const d = draft({ category: 'MARKETING' }); // a rejected template may change category
    expect(await ed(c, d)).toEqual({ ok: true, status: 'PENDING' });
    expect(metaCalls()[0]).toMatchObject({ method: 'POST', url: 'https://graph.facebook.com/v25.0/meta-1', body: { category: 'MARKETING', components: [{ type: 'BODY', text: d.body.text }] } });
    expect(await rows(c.workspaceId, 'SELECT status, category, rejected_reason FROM templates')).toEqual([{ status: 'PENDING', category: 'MARKETING', rejected_reason: null }]);
    expect(await rows(c.workspaceId, 'SELECT 1 FROM template_edits')).toEqual([]);
  });
  it('an APPROVED edit is recorded in the edit log and does not send category', async () => {
    const c = await seed(413, 'APPROVED');
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    expect(await ed(c, draft())).toEqual({ ok: true, status: 'PENDING' });
    expect(metaCalls()[0]!.body).not.toHaveProperty('category');
    expect((await rows(c.workspaceId, 'SELECT name FROM template_edits')).length).toBe(1);
    expect(await c.ws.getTemplate('shipping_update', 'ar')).toMatchObject({ status: 'PENDING' }); // Meta re-reviews an edited template
  });
  it('without a stored Meta id it looks the id up by name first', async () => {
    const c = await seed(414, 'REJECTED', { metaId: '' });
    await exec(c.workspaceId, "UPDATE templates SET meta_id = NULL");
    graph = graphStub((call) => (call.method === 'GET' ? { status: 200, json: { data: [{ id: 'found-7', name: 'shipping_update', language: 'ar', category: 'UTILITY', status: 'REJECTED', components: [] }] } } : { status: 200, json: { success: true } }));
    expect(await ed(c, draft())).toEqual({ ok: true, status: 'PENDING' });
    expect(graph.calls.find((x) => x.method === 'POST')!.url).toBe('https://graph.facebook.com/v25.0/found-7');
  });
  it('two concurrent edits of the same template: one runs, the other is edit_in_progress, Meta is called once and one edit is logged', async () => {
    const c = await seed(435, 'APPROVED');
    graph = graphStub(() => ({ status: 200, json: { success: true } }), 40);
    const [a, b] = await Promise.all([ed(c, draft()), ed(c, draft())]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    expect([a, b].find((x) => !x.ok)).toMatchObject({ reason: 'edit_in_progress' });
    expect(graph.calls.filter((x) => x.method === 'POST')).toHaveLength(1);
    expect((await rows(c.workspaceId, 'SELECT 1 FROM template_edits')).length).toBe(1);
  });
  it('the edit claim is released after a failure, so the merchant can try again', async () => {
    const c = await seed(436, 'REJECTED');
    graph = graphStub(() => ({ status: 400, json: { error: { message: 'no' } } }));
    expect(await ed(c, draft())).toMatchObject({ ok: false, reason: 'meta_rejected' });
    graph.restore();
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    expect(await ed(c, draft())).toEqual({ ok: true, status: 'PENDING' });
  });
  it('an unknown template is not_found; a changed payload is payload_changed', async () => {
    const c = await seed(415, 'REJECTED');
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    expect(await ed(c, draft({ name: 'nope' }))).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await editTemplate(c, draft(), { expectedHash: 'deadbeef' })).toMatchObject({ ok: false, reason: 'payload_changed' });
    expect(metaCalls()).toEqual([]);
  });
});

describe('deleteTemplate', () => {
  const seed = async (n: number, status = 'APPROVED') => {
    const c = await ctx(n);
    await c.ws.saveSubmittedTemplate({ name: 'promo', language: 'ar', category: 'MARKETING', status, components: [{ type: 'BODY', text: 'أهلاً {{1}} عرض {{2}} الليلة.' }], metaId: 'meta-5', label: 'عرض' });
    return c;
  };
  it('sends hsm_id (one language only) and removes the row; deleting again is not_found', async () => {
    const c = await seed(416);
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    expect(await deleteTemplate(c, { name: 'promo', language: 'ar' })).toEqual({ ok: true });
    expect(graph.calls.find((x) => x.method === 'DELETE')!.url).toBe('https://graph.facebook.com/v25.0/waba-1/message_templates?name=promo&hsm_id=meta-5');
    expect(await rows(c.workspaceId, 'SELECT 1 FROM templates')).toEqual([]);
    expect(await deleteTemplate(c, { name: 'promo', language: 'ar' })).toMatchObject({ ok: false, reason: 'not_found' });
  });
  it('a template a campaign still uses is in_use, Graph not called', async () => {
    const c = await seed(417);
    await seedContacts(c.workspaceId, 1);
    await makeCampaign(c.workspaceId); // draft campaign on 'promo'
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    expect(await deleteTemplate(c, { name: 'promo', language: 'ar' })).toMatchObject({ ok: false, reason: 'in_use' });
    expect(graph.calls.filter((x) => x.method === 'DELETE')).toEqual([]);
  });
  it('a DISABLED template is not_deletable', async () => {
    const c = await seed(418, 'DISABLED');
    graph = graphStub(() => ({ status: 200, json: { success: true } }));
    expect(await deleteTemplate(c, { name: 'promo', language: 'ar' })).toMatchObject({ ok: false, reason: 'not_deletable' });
    expect(graph.calls.filter((x) => x.method === 'DELETE')).toEqual([]);
  });
  it('never deletes every language: without a stored id it resolves the id first, and refuses when it cannot', async () => {
    const c = await seed(419);
    await exec(c.workspaceId, 'UPDATE templates SET meta_id = NULL');
    graph = graphStub((call) => (call.method === 'GET' ? { status: 503, json: {} } : { status: 200, json: { success: true } }));
    expect(await deleteTemplate(c, { name: 'promo', language: 'ar' })).toMatchObject({ ok: false, reason: 'meta_unavailable' });
    expect(graph.calls.filter((x) => x.method === 'DELETE')).toEqual([]);
    graph.restore();
    graph = graphStub((call) => (call.method === 'GET' ? { status: 200, json: { data: [{ id: 'resolved-1', name: 'promo', language: 'ar', category: 'MARKETING', status: 'APPROVED', components: [] }] } } : { status: 200, json: { success: true } }));
    expect(await deleteTemplate(c, { name: 'promo', language: 'ar' })).toEqual({ ok: true });
    expect(graph.calls.find((x) => x.method === 'DELETE')!.url).toContain('hsm_id=resolved-1');
  });
  it('Meta saying it is already gone counts as success and the row goes', async () => {
    const c = await seed(420);
    graph = graphStub((call) => (call.method === 'DELETE' ? { status: 400, json: { error: { message: 'Template not found' } } } : { status: 200, json: { data: [] } }));
    expect(await deleteTemplate(c, { name: 'promo', language: 'ar' })).toEqual({ ok: true });
    expect(await rows(c.workspaceId, 'SELECT 1 FROM templates')).toEqual([]);
  });
  it('a real Meta refusal keeps the row and passes Meta text through', async () => {
    const c = await seed(421);
    graph = graphStub((call) => (call.method === 'DELETE' ? { status: 400, json: { error: { message: 'Cannot delete now' } } } : { status: 200, json: { data: [{ id: 'meta-5', name: 'promo', language: 'ar', category: 'MARKETING', status: 'APPROVED', components: [] }] } }));
    expect(await deleteTemplate(c, { name: 'promo', language: 'ar' })).toEqual({ ok: false, reason: 'meta_rejected', message: 'Cannot delete now' });
    expect((await rows(c.workspaceId, 'SELECT 1 FROM templates')).length).toBe(1);
  });
});

describe('syncTemplates / installDefaults / refreshPending', () => {
  it('sync stores Meta ids and keeps the merchant label', async () => {
    const c = await ctx(422);
    await c.ws.saveSubmittedTemplate({ name: 'a', language: 'ar', category: 'UTILITY', status: 'PENDING', components: [], metaId: null, label: 'تسمية' });
    graph = graphStub(() => ({ status: 200, json: { data: [{ id: 'ida', name: 'a', language: 'ar', category: 'UTILITY', status: 'APPROVED', components: [{ type: 'BODY', text: 'x y.' }] }] } }));
    expect(await syncTemplates(c)).toEqual({ ok: true, upserted: 1, removed: 0 });
    expect(await rows(c.workspaceId, 'SELECT meta_id, label, status FROM templates')).toEqual([{ meta_id: 'ida', label: 'تسمية', status: 'APPROVED' }]);
  });
  it('sync does not delete a submission that is still being sent to Meta', async () => {
    const c = await ctx(423);
    await c.ws.saveSubmittedTemplate({ name: 'inflight', language: 'ar', category: 'UTILITY', status: 'PENDING', components: [], metaId: null, label: null });
    graph = graphStub(() => ({ status: 200, json: { data: [] } }));
    expect(await syncTemplates(c)).toMatchObject({ ok: true, removed: 0 });
  });
  it('installDefaults skips what exists', async () => {
    const c = await ctx(424);
    await seedTemplate(c.workspaceId, { name: 'order_confirmation', category: 'UTILITY', status: 'APPROVED', components: '[]' });
    graph = graphStub(() => ok({ id: '9', status: 'PENDING' }));
    expect(await installDefaults(c, EBDA_DEFAULT_TEMPLATES)).toEqual({ ok: true, submitted: ['cod_confirmation', 'shipping_update', 'otp_code', 'cart_recovery', 'shipping_tracking', 'shipping_status'], skipped: ['order_confirmation'], failed: [] });
  });
  it('installDefaults reports a bad pack entry in failed and still installs the good ones (never throws)', async () => {
    const c = await ctx(437);
    graph = graphStub(() => ok({ id: '9', status: 'PENDING' }));
    const good = EBDA_DEFAULT_TEMPLATES[0]!;
    const r = await installDefaults(c, [{ name: 'Bad Name!', language: 'ar', category: 'UTILITY', components: [] }, { nope: 1 } as never, good]);
    expect(r).toEqual({ ok: true, submitted: [good.name], skipped: [], failed: ['Bad Name!', 'invalid_entry'] });
    expect(metaCalls()).toHaveLength(1);
  });
  it('installDefaults keeps the claim of an ambiguous (5xx) submission and releases a refused one', async () => {
    const c = await ctx(438);
    graph = graphStub((call) => (call.body?.name === 'order_confirmation' ? { status: 503, json: {} } : call.body?.name === 'cod_confirmation' ? { status: 400, json: { error: { message: 'no' } } } : ok({ id: 'x', status: 'PENDING' })));
    const r = await installDefaults(c, EBDA_DEFAULT_TEMPLATES.slice(0, 3));
    expect(r).toMatchObject({ ok: true, submitted: ['shipping_update'], failed: ['order_confirmation', 'cod_confirmation'] });
    expect((await rows<{ name: string }>(c.workspaceId, 'SELECT name FROM templates ORDER BY name')).map((x) => x.name)).toEqual(['order_confirmation', 'shipping_update']);
  });
  it('refreshPending updates a stale PENDING row from Meta, and drops an orphan reservation Meta never saw', async () => {
    const c = await ctx(425);
    await c.ws.saveSubmittedTemplate({ name: 'late', language: 'ar', category: 'UTILITY', status: 'PENDING', components: [], metaId: null, label: null });
    await c.ws.saveSubmittedTemplate({ name: 'orphan', language: 'ar', category: 'UTILITY', status: 'PENDING', components: [], metaId: null, label: null });
    await exec(c.workspaceId, 'UPDATE templates SET updated_at = 1');
    graph = graphStub((call) => ({ status: 200, json: { data: call.url.includes('name=late') ? [{ id: 'ml', name: 'late', language: 'ar', category: 'UTILITY', status: 'REJECTED', rejected_reason: 'INVALID_FORMAT', components: [] }] : [] } }));
    expect(await refreshPending(c, 60 * 60_000)).toEqual({ ok: true, checked: 2, updated: 2 });
    expect(await rows(c.workspaceId, 'SELECT name, status, meta_id, rejected_reason FROM templates')).toEqual([{ name: 'late', status: 'REJECTED', meta_id: 'ml', rejected_reason: 'INVALID_FORMAT' }]);
  });
});
