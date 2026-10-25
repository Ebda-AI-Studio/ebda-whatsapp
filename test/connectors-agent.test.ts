import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectorLimits } from '../src/core/connectors/registry';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, sendCount, text } from './helpers/agent-chat';
import { hangs, logText, spyLogs, stubClient } from './helpers/connectors';
import { holdPoint } from './helpers/hold';
import { FakeOdoo } from './helpers/odoo';
import { BUYER_KEY_1, WA_1, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

useStoreLink();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000093${String(n).padStart(2, '0')}`;
const SECRET = 'test-secret-0123456789abcdef';
const model = (steps: ConstructorParameters<typeof ScriptedProvider>[0]) => (agent.model = new ScriptedProvider(steps)) as ScriptedProvider;
const tool = { name: 'check_booking', description: 'Look up a booking.', params: [{ name: 'reference', type: 'string' as const, required: true }] };
const hook = { kind: 'webhook' as const, enabled: true, config: { url: 'https://hooks.acme-client.com/wa', tools: [tool] }, secret: SECRET };

async function setup(ws: string, connector: Record<string, unknown> | null = hook, id = 'crm') {
  const pn = await agentWorkspace(ws);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  if (connector) expect((await workspace(ws).putConnector(id, connector as never, null)).ok).toBe(true);
  return pn;
}
const call = (reference: string) => ({ name: 'crm__check_booking', arguments: { reference } });
const toolMessages = (m: ScriptedProvider, round: number) => m.calls[round]!.messages.filter((x) => x.role === 'tool');
afterEach(() => { connectorLimits.callWindowMs = 12_000; });

describe('the agent and connectors', () => {
  it('offers enabled connector tools (prefixed) next to the built-ins, passes the call through and shows the model the result', async () => {
    const ws = W(1);
    const pn = await setup(ws);
    const c = stubClient(() => ({ json: { ok: true, result: { status: 'confirmed', seats: 4 } } }));
    const m = model([{ tools: [call('AB12')] }, { text: 'حجزك مؤكد' }]);
    const out = await say(ws, pn, text('حجزي AB12؟'), c.graph);
    expect(out.map((s) => s.text)).toEqual(['حجزك مؤكد']);
    expect(m.calls[0]!.tools.map((t) => t.name)).toEqual(['search_catalog', 'order_status', 'start_order', 'handoff_to_human', 'crm__check_booking']);
    expect(m.calls[0]!.system).toContain('crm__check_booking');
    expect(c.calls).toHaveLength(1);
    expect(c.calls[0]!.json).toMatchObject({ event: 'tool_call', tool: 'check_booking', args: { reference: 'AB12' }, workspaceId: ws, buyerKey: BUYER_KEY_1, idempotencyKey: expect.stringMatching(/^conn:\d+:0$/) });
    expect(c.calls[0]!.json.conversationId).toBeGreaterThan(0);
    expect(c.calls[0]!.raw).not.toContain(WA_1);
    expect(JSON.parse(toolMessages(m, 1)[0]!.content as string)).toEqual({ ok: true, result: { status: 'confirmed', seats: 4 } });
  });

  it('a connector tool named like a built-in cannot shadow it: names carry the connector id', async () => {
    const ws = W(2);
    const pn = await setup(ws, { ...hook, config: { ...hook.config, tools: [{ ...tool, name: 'search_catalog' }, { ...tool, name: 'handoff_to_human' }] } });
    const c = stubClient(() => ({ json: { ok: true } }));
    const m = model([{ text: 'تمام' }]);
    await say(ws, pn, text('hi'), c.graph);
    const names = m.calls[0]!.tools.map((t) => t.name);
    expect(names.filter((n) => n === 'search_catalog')).toHaveLength(1);
    expect(names).toEqual(expect.arrayContaining(['crm__search_catalog', 'crm__handoff_to_human']));
    for (const n of names) expect(n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/); // the strictest provider rule (OpenAI)
  });

  it('a disabled connector is not offered; neither is any connector while the agent is off', async () => {
    const off = W(3);
    const pn = await setup(off, { ...hook, enabled: false });
    const c = stubClient(() => ({ json: { ok: true } }));
    const m = model([{ text: 'تمام' }]);
    await say(off, pn, text('hi'), c.graph);
    expect(m.calls[0]!.tools.map((t) => t.name)).not.toContain('crm__check_booking');

    const ws = W(4);
    const pn2 = await setup(ws);
    expect((await workspace(ws).setAgentSettings({ enabled: false })).ok).toBe(true);
    const m2 = model([{ tools: [call('A')] }]);
    await say(ws, pn2, text('hi'), c.graph);
    expect(m2.callCount).toBe(0);
    expect(c.calls).toHaveLength(0);
  });

  it('a model that names a connector tool that is not offered gets unknown_tool, and nothing leaves', async () => {
    const ws = W(5);
    const pn = await setup(ws, null);
    const c = stubClient(() => ({ json: { ok: true } }));
    const m = model([{ tools: [call('A')] }, { text: 'آسف' }]);
    await say(ws, pn, text('hi'), c.graph);
    expect(JSON.parse(toolMessages(m, 1)[0]!.content as string)).toEqual({ error: 'unknown_tool' });
    expect(c.calls).toHaveLength(0);
  });

  it('connector calls count against the per-round tool cap (3), like any tool', async () => {
    const ws = W(6);
    const pn = await setup(ws);
    const c = stubClient(() => ({ json: { ok: true, result: 1 } }));
    model([{ tools: [1, 2, 3, 4, 5].map((i) => call(`R${i}`)) }, { text: 'خلصت' }]);
    await say(ws, pn, text('hi'), c.graph);
    expect(c.calls.map((x) => x.json.args.reference)).toEqual(['R1', 'R2', 'R3']);
    expect(new Set(c.calls.map((x) => x.json.idempotencyKey)).size).toBe(3);
  });

  it('and against the turn cap: after 3 rounds the model is offered no tools', async () => {
    const ws = W(7);
    const pn = await setup(ws);
    const c = stubClient(() => ({ json: { ok: true } }));
    const m = model([{ tools: [call('1')] }, { tools: [call('2')] }, { tools: [call('3')] }, { tools: [call('4')] }]);
    await say(ws, pn, text('hi'), c.graph);
    expect(c.calls).toHaveLength(3);
    expect(m.calls[3]!.tools).toEqual([]);
  });

  it('a slow client system is a tool error and the turn still answers', async () => {
    const ws = W(8);
    const pn = await setup(ws);
    connectorLimits.callWindowMs = 80;
    const c = stubClient((_c, _n, signal) => hangs(signal));
    const m = model([{ tools: [call('A')] }, { text: 'ما قدرتش أتأكد دلوقتي' }]);
    const out = await say(ws, pn, text('hi'), c.graph);
    expect(out.map((s) => s.text)).toEqual(['ما قدرتش أتأكد دلوقتي']);
    expect(JSON.parse(toolMessages(m, 1)[0]!.content as string)).toEqual({ ok: false, error: 'timeout' });
    expect(c.calls).toHaveLength(1); // no retry
  });

  it('works with Odoo: the buyer becomes the partner without the model ever seeing the number', async () => {
    const ws = W(9);
    const pn = await setup(ws, { kind: 'odoo', enabled: true, config: { url: 'https://erp.acme-client.com', database: 'prod', login: 'bot@acme-client.com' }, secret: 'test-secret-odoo-api-key' }, 'erp');
    const odoo = new FakeOdoo();
    const c = stubClient((x) => odoo.handle(x), 'erp.acme-client.com');
    const m = model([{ tools: [{ name: 'erp__create_sale_order', arguments: { lines: [{ code: 'ROSE-1', qty: 2 }] } }] }, { text: 'تم عمل عرض سعر' }]);
    const logs = spyLogs();
    await say(ws, pn, text('عايز ورد'), c.graph);
    expect(m.calls[0]!.tools.map((t) => t.name)).toContain('erp__read_stock');
    expect(odoo.partners[0]).toMatchObject({ phone: '+201001234567' });
    expect(odoo.orders[0]).toMatchObject({ client_order_ref: expect.stringMatching(/^conn:\d+:0$/) });
    expect(JSON.stringify(m.calls)).not.toContain('201001234567');
    expect(logText(logs)).not.toContain('1001234567');
  });

  it('no connector call after the customer is erased: while the model is deciding', async () => {
    const ws = W(10);
    const pn = await setup(ws);
    const c = stubClient(() => ({ json: { ok: true } }));
    let thinking = false;
    let released = false;
    model([{ tools: [call('A')], onStart: () => { thinking = true; }, holdUntil: () => released }, { text: 'لا' }]);
    const turn = say(ws, pn, text('hi'), c.graph);
    await vi.waitFor(() => expect(thinking).toBe(true));
    await workspace(ws).eraseContact(WA_1);
    released = true;
    await turn;
    expect(c.calls).toHaveLength(0);
    expect(sendCount(c.graph)).toBe(0);
    expect(await rows(ws, 'SELECT 1 FROM agent_turns')).toEqual([]);
  });

  it('and while the first call of a round is in flight: the second is never made', async () => {
    const ws = W(11);
    const pn = await setup(ws);
    const gate = holdPoint();
    const c = stubClient(async () => { await gate.hold(); return { json: { ok: true } }; });
    model([{ tools: [call('A'), call('B')] }, { text: 'لا' }]);
    const turn = say(ws, pn, text('hi'), c.graph);
    await gate.reached();
    await workspace(ws).eraseContact(WA_1);
    gate.release();
    await turn;
    expect(c.calls.map((x) => x.json.args.reference)).toEqual(['A']);
    expect(sendCount(c.graph)).toBe(0);
  });

  it('a customer who sends STOP while the first call of a round is in flight: the second is never made', async () => {
    const ws = W(91);
    const pn = await setup(ws);
    const gate = holdPoint();
    const c = stubClient(async () => { await gate.hold(); return { json: { ok: true } }; });
    model([{ tools: [call('A'), call('B')] }, { text: 'لا' }]);
    const turn = say(ws, pn, text('hi'), c.graph);
    await gate.reached();
    await exec(ws, 'UPDATE contacts SET opted_out_at = ?', Date.now() + 1000);
    gate.release();
    await turn;
    expect(c.calls.map((x) => x.json.args.reference)).toEqual(['A']);
    expect(sendCount(c.graph)).toBe(0);
  });

  it('a customer who sent STOP while the model was deciding makes no connector call either', async () => {
    const ws = W(12);
    const pn = await setup(ws);
    const c = stubClient(() => ({ json: { ok: true } }));
    let thinking = false;
    let released = false;
    model([{ tools: [call('A')], onStart: () => { thinking = true; }, holdUntil: () => released }]);
    const turn = say(ws, pn, text('hi'), c.graph);
    await vi.waitFor(() => expect(thinking).toBe(true));
    await exec(ws, 'UPDATE contacts SET opted_out_at = ?', Date.now() + 1000);
    released = true;
    await turn;
    expect(c.calls).toHaveLength(0);
  });

  it('a connector switched off during the turn is not called', async () => {
    const ws = W(13);
    const pn = await setup(ws);
    const c = stubClient(() => ({ json: { ok: true } }));
    let thinking = false;
    let released = false;
    const m = model([{ tools: [call('A')], onStart: () => { thinking = true; }, holdUntil: () => released }, { text: 'تمام' }]);
    const turn = say(ws, pn, text('hi'), c.graph);
    await vi.waitFor(() => expect(thinking).toBe(true));
    await workspace(ws).putConnector('crm', { ...hook, enabled: false, secret: undefined } as never, null);
    released = true;
    await turn;
    expect(c.calls).toHaveLength(0);
    expect(JSON.parse(toolMessages(m, 1)[0]!.content as string)).toEqual({ ok: false, error: 'unavailable' });
  });

  it('failures are logged as classes only: no secret, argument or result in any log', async () => {
    const ws = W(14);
    const pn = await setup(ws);
    const c = stubClient(() => ({ status: 500, text: 'boom test-secret-0123456789abcdef AB12' }));
    const logs = spyLogs();
    model([{ tools: [call('AB12')] }, { text: 'آسف' }]);
    await say(ws, pn, text('hi'), c.graph);
    const out = logText(logs);
    expect(out).toContain('connector_call_failed');
    for (const bad of [SECRET, 'AB12', 'boom', '1001234567']) expect(out).not.toContain(bad);
  });
});
