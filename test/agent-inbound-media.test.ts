import { describe, expect, it } from 'vitest';
import { EBDA_AGENT_COPY } from '../src/addons/ebda/agent-copy';
import { EBDA_ORDERING_COPY } from '../src/addons/ebda/store-copy';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, text, wamid } from './helpers/agent-chat';
import { stubGraph } from './helpers/graph';
import { WA_1, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

// Audit row 25 (the rest): an image, sticker, document, video or audio FILE during an agent conversation gets one short Egyptian note, never a model call.
useStoreLink();
const agent = useAgent();
const W = (n: number) => `00000000-0000-4000-8000-0000000093${String(n).padStart(2, '0')}`;
const T = EBDA_AGENT_COPY.t;
const msg = (type: string, body: Record<string, unknown>) => ({ id: wamid(), from: WA_1, type, [type]: body });
const image = () => msg('image', { id: 'media-i', mime_type: 'image/jpeg' });
const sticker = () => msg('sticker', { id: 'media-s', mime_type: 'image/webp' });
const document = () => msg('document', { id: 'media-d', mime_type: 'application/pdf', filename: 'a.pdf' });
const audioFile = () => msg('audio', { id: 'media-a', mime_type: 'audio/mpeg', voice: false });

async function start(ws: string) {
  const pn = await agentWorkspace(ws);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  const m = (agent.model = new ScriptedProvider([])) as ScriptedProvider;
  return { pn, m };
}
let seq = 0;
const stored = (ws: string, type: string) => rows<{ type: string }>(ws, "SELECT type FROM messages WHERE direction = 'in' AND type = ?", type);

describe('inbound media in an agent conversation', () => {
  it.each([['image', image, T.mediaNote.ar], ['document', document, T.mediaNote.ar], ['audio file (voice:false)', audioFile, T.mediaNote.ar], ['sticker', sticker, T.stickerNote.ar]] as const)('%s: one short note, no model call, the media stays in the inbox', async (_n, make, note) => {
    const ws = W(++seq);
    const { pn, m } = await start(ws);
    const out = await say(ws, pn, make(), stubGraph());
    expect(out.map((s) => s.text)).toEqual([note]);
    expect(m.callCount).toBe(0);
    expect((await rows(ws, 'SELECT 1 FROM messages WHERE direction = \'in\''))).toHaveLength(1); // stored as today
    expect(await rows(ws, "SELECT outcome FROM agent_turns WHERE outcome = 'media_note'")).toHaveLength(1);
  });

  it('the note offers a person, and "عايز اكلم حد" afterwards still hands over', async () => {
    const ws = W(91);
    const { pn } = await start(ws);
    const g = stubGraph();
    expect((await say(ws, pn, image(), g))[0]!.text).toContain('عايز أكلم حد');
    const out = await say(ws, pn, text('عايز اكلم حد'), g);
    expect(out.map((s) => s.text)).toEqual([T.handoffAck.ar]);
    expect((await rows(ws, 'SELECT reason FROM agent_handoffs'))[0]).toEqual({ reason: 'asked' });
  });

  it('never loops: once per 10 minutes per customer across image, sticker and document; again after the gap', async () => {
    const ws = W(92);
    const { pn, m } = await start(ws);
    const g = stubGraph();
    expect(await say(ws, pn, image(), g)).toHaveLength(1);
    expect(await say(ws, pn, sticker(), g)).toHaveLength(0);
    expect(await say(ws, pn, document(), g)).toHaveLength(0);
    expect(await rows(ws, "SELECT outcome FROM agent_turns WHERE outcome = 'media_quiet'")).toHaveLength(2);
    expect(await stored(ws, 'sticker')).toHaveLength(1); // still stored
    await exec(ws, "UPDATE messages SET created_at = created_at - ? WHERE idempotency_key LIKE 'agent:%:medianote'", 11 * 60_000);
    expect(await say(ws, pn, sticker(), g)).toHaveLength(1);
    expect(m.callCount).toBe(0);
  });

  it('does not spend a credit or count as an AI turn', async () => {
    const ws = W(93);
    const { pn } = await start(ws);
    await say(ws, pn, image(), stubGraph());
    expect(await rows(ws, 'SELECT 1 FROM credit_holds')).toHaveLength(0);
  });

  it('a voice note (voice:true, or no flag) is still transcribed, not answered with the media note', async () => {
    const ws = W(94);
    const { pn } = await start(ws);
    const out = await say(ws, pn, msg('audio', { id: 'media-a', mime_type: 'audio/ogg', voice: true }), stubGraph());
    expect(out.map((s) => s.text)).not.toContain(T.mediaNote.ar);
  });

  it('the payment-proof step is unchanged: with an InstaPay order a picture goes to the ordering bot, not the media note', async () => {
    const ws = W(95);
    const { pn } = await start(ws);
    await say(ws, pn, sticker(), stubGraph()); // creates the contact (answered with the sticker note)
    await exec(ws, "INSERT INTO store_orders (order_id, order_number, wa_id, payment_method, status, proof_deadline_at, updated_at) VALUES ('o1', '1001', ?, 'instapay', 'pending_payment', 1, ?)", WA_1, Date.now());
    const out = await say(ws, pn, image(), stubGraph());
    expect(out.map((s) => s.text)).toEqual([EBDA_ORDERING_COPY.t.proofExpired.ar]);
    expect(await rows(ws, "SELECT 1 FROM agent_turns WHERE outcome LIKE 'media%'")).toHaveLength(1); // only the sticker's
  });
});
