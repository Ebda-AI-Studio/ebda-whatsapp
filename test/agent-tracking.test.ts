import { describe, expect, it } from 'vitest';
import { guardReply, Trusted } from '../src/core/ai/reply-guard';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { stubGraph } from './helpers/graph';
import { BUYER_KEY_1, useStoreLink } from './helpers/store-link';
import { rows, workspace } from './helpers/workspace';

// Audit row 28: "فين أوردري؟". The bridge shipment carries {status, trackingUrl} only: the agent gets the status in the customer's words and the link, and is told
// there is no courier name or delivery date (Store-side ask in docs/store-link.md).
const link = useStoreLink();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000091${String(n).padStart(2, '0')}`;
const TRACK = 'https://track.example/abc123';
const order = (n: string, status: 'shipped' | 'confirmed', at: number) => link.fake.orders.set(`ord-${n}`, { orderId: `ord-${n}`, orderNumber: n, buyerKey: BUYER_KEY_1, status, paymentMethod: 'cod', lines: [{ variantId: 'v1', quantity: 1 }], totalMinor: 85_000, currency: 'EGP', at, proofs: [], codOutcome: 'confirmed', instapayReference: null });
const toolResult = (m: ScriptedProvider) => JSON.parse((m.calls[1]!.messages.at(-1) as { content: string }).content);

async function chat(ws: string, steps: ConstructorParameters<typeof ScriptedProvider>[0], msg: string) {
  const pn = await agentWorkspace(ws);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  const m = (agent.model = new ScriptedProvider(steps)) as ScriptedProvider;
  const out = await say(ws, pn, text(msg), stubGraph());
  return { m, out };
}

describe('order_status carries the shipment in the customer\'s words', () => {
  it('with an order number: status text, tracking link, and an explicit "no courier / no estimate"', async () => {
    order('1001', 'shipped', 2);
    link.fake.shipments.set('1001', { status: 'in_transit', trackingUrl: TRACK });
    const { m } = await chat(W(1), [{ tools: [{ name: 'order_status', arguments: { orderNumber: '1001' } }] }, { text: 'طلبك في الطريق ليك 🚚' }], 'فين أوردري 1001؟');
    expect(toolResult(m).shipment).toEqual({ status: 'in_transit', statusText: 'في الطريق ليك 🚚', trackingUrl: TRACK, courier: null, estimatedDelivery: null });
  });

  it('an unknown shipment code has no phrase (null), never an invented one', async () => {
    order('1001', 'shipped', 2);
    link.fake.shipments.set('1001', { status: 'weird_code', trackingUrl: null });
    const { m } = await chat(W(2), [{ tools: [{ name: 'order_status', arguments: { orderNumber: '1001' } }] }, { text: 'هراجع مع الفريق' }], 'فين 1001');
    expect(toolResult(m).shipment).toMatchObject({ status: 'weird_code', statusText: null, trackingUrl: null });
  });

  it('with no number: a shipped order in the listing already carries its shipment (no second tool round); a confirmed one does not cost a read', async () => {
    order('1001', 'shipped', 2);
    order('1002', 'confirmed', 1);
    link.fake.shipments.set('1001', { status: 'out_for_delivery', trackingUrl: TRACK });
    const { m } = await chat(W(3), [{ tools: [{ name: 'order_status' }] }, { text: 'أوردرك مع المندوب' }], 'فين أوردري؟');
    const orders = toolResult(m).orders as { orderNumber: string; shipment?: { statusText: string; trackingUrl: string } }[];
    expect(orders.find((o) => o.orderNumber === '1001')!.shipment).toMatchObject({ statusText: 'مع المندوب وهيوصلك النهاردة', trackingUrl: TRACK });
    expect(orders.find((o) => o.orderNumber === '1002')!.shipment).toBeUndefined();
    expect(link.fake.calls.filter((c) => c.method === 'getOrderStatus')).toHaveLength(1); // only the shipped one
    expect(m.callCount).toBe(2);
  });

  it('a failed shipment read leaves the shipment out, the listing still answers', async () => {
    order('1001', 'shipped', 2);
    const real = link.fake.getOrderStatus.bind(link.fake);
    link.fake.getOrderStatus = () => { throw new Error('boom'); };
    try {
      const { m } = await chat(W(4), [{ tools: [{ name: 'order_status' }] }, { text: 'أوردرك اتشحن' }], 'فين أوردري؟');
      expect(toolResult(m).orders[0]).toMatchObject({ orderNumber: '1001', status: 'shipped' });
      expect(toolResult(m).orders[0].shipment).toBeUndefined();
    } finally { link.fake.getOrderStatus = real; }
  });

  it('the agent can quote the tracking link the Store returned (it used to be refused: the guard did not know `trackingUrl`), and an invented link is still refused', async () => {
    order('1001', 'shipped', 2);
    link.fake.shipments.set('1001', { status: 'in_transit', trackingUrl: TRACK });
    const ws = W(5);
    const { out } = await chat(ws, [{ tools: [{ name: 'order_status', arguments: { orderNumber: '1001' } }] }, { text: `طلبك في الطريق ليك 🚚 تتبعه من هنا ${TRACK}` }], 'فين 1001');
    expect(out.map((s) => s.text)).toEqual([`طلبك في الطريق ليك 🚚 تتبعه من هنا ${TRACK}`]);
    expect(await rows(ws, 'SELECT 1 FROM agent_handoffs')).toHaveLength(0);
    const t = new Trusted();
    t.addStoreResult(JSON.stringify({ shipment: { trackingUrl: TRACK } }));
    expect(guardReply(`تتبعه من ${TRACK}`, t)).toEqual({ ok: true });
    expect(guardReply('تتبعه من https://track.example/zzz999', t)).toMatchObject({ ok: false, reason: 'url' });
  });
});

describe('the prompt', () => {
  it('forbids inventing a courier, tracking number or delivery date, and tells the model to hand over when pressed', async () => {
    const { m } = await chat(W(6), [{ text: 'تمام' }], 'ازيك');
    expect(m.calls[0]!.system).toContain('courier name, tracking number and delivery date are NOT available');
    expect(m.calls[0]!.system).toContain('handoff_to_human');
  });
});
