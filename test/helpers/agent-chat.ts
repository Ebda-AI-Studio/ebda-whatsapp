import { SELF, runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import type { stubGraph } from './graph';
import { postWebhook } from './meta';
import { rawMessagePayload } from './payload';
import { WA_1, storeWorkspace } from './store-link';
import { workspace } from './workspace';

type Graph = ReturnType<typeof stubGraph>;
let seq = 0;
export const wamid = () => `wamid.agent.${++seq}.${Date.now()}`;

/** A workspace with an active number, the agent switched on and no gap between sends. */
export async function agentWorkspace(ws: string, settings: Record<string, unknown> = {}) {
  const pn = await storeWorkspace(ws, { templates: false });
  await runInDurableObject(workspace(ws), (i) => { (i as unknown as { botSendGapMs: number }).botSendGapMs = 0; });
  expect((await workspace(ws).setAgentSettings({ enabled: true, ...settings })).ok).toBe(true);
  return pn;
}

export type Sent = { kind: string; text: string | null; body: Record<string, any> };
export function sentOf(g: Graph, from = 0): Sent[] {
  return g.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages')).slice(from).map((c) => {
    const b = c.body as Record<string, any>;
    return { kind: b.type === 'interactive' ? (b.interactive.type === 'list' ? 'list' : 'buttons') : b.type, text: b.type === 'text' ? b.text.body : null, body: b };
  });
}
export const sendCount = (g: Graph) => g.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages')).length;

/** One inbound message through the real webhook, then the workspace's due tasks; returns what was sent in reply. */
export async function say(ws: string, pn: string, message: Record<string, unknown>, g: Graph): Promise<Sent[]> {
  const from = sendCount(g);
  expect((await postWebhook(SELF, rawMessagePayload(pn, message))).status).toBe(200);
  await workspace(ws).runDueTasks();
  return sentOf(g, from);
}
export const text = (t: string, from = WA_1) => ({ id: wamid(), from, type: 'text', text: { body: t } });
export const audio = (from = WA_1) => ({ id: wamid(), from, type: 'audio', audio: { id: 'media-a', mime_type: 'audio/ogg' } });
