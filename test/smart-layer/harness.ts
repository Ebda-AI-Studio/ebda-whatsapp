import { SELF, env } from 'cloudflare:test';
import { expect } from 'vitest';
import { configureAssistant } from '../../src/routes/assistant';
import { apiFor, storeId } from '../helpers/api';
import { seedNumber, workspace } from '../helpers/workspace';

type Script = Array<{ text?: string; call?: { name: string; args: unknown } }>;
/** A Workers AI binding that answers from a script: the classifier call gets a fixed in-scope JSON, every other call the next scripted OpenAI-shaped reply. */
export function scriptedAi(script: Script) {
  let i = 0;
  const seen: string[] = [];
  return {
    seen,
    run: async (_m: string, inputs: Record<string, unknown>) => {
      seen.push(JSON.stringify(inputs));
      const system = (((inputs.messages as Array<{ content?: string }>)[0]?.content) ?? '') as string;
      if (system.includes('Classify the merchant message')) return { choices: [{ message: { content: '{"inScope":true,"abuse":false,"injection":false}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };
      const s = script[Math.min(i++, script.length - 1)]!;
      return { choices: [{ message: { content: s.text ?? null, ...(s.call ? { tool_calls: [{ id: `c${i}`, type: 'function', function: { name: s.call.name, arguments: JSON.stringify(s.call.args) } }] } : {}) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } };
    },
  };
}
export const noHelp = { db: env.DB, embed: undefined, vectors: undefined } as never;

export const base = (s: string, p: string) => `https://x/api/v1/stores/${s}/assistant${p}`;
export const post = (s: string, token: string, path: string, body?: unknown) => SELF.fetch(base(s, path), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body ?? {}) });
export type Card = { previewId: string; policy: 'preview' | 'confirm'; reasons: string[]; rows: Array<{ before?: unknown; after?: unknown }>; undo: string; approvalId?: string };
export type TurnOut = { status: string; previews: Card[]; approvals?: Array<{ approvalId: string; previewId: string; token: string }>; segments?: unknown[] };

/** One workspace in `act` mode with customers (inbound within the window); `ask` runs one scripted turn that calls a tool. */
export async function setup(n: number, role: 'owner' | 'staff' = 'owner', names: string[] = ['منى السيد']) {
  const s = storeId(n);
  const api = await apiFor(s, role);
  await seedNumber(`pn-${s}`, s);
  const ws = workspace(s);
  await ws.setAssistantMode('act');
  let k = 0;
  for (const name of names) await ws.ingest({ phoneNumberId: `pn-${s}`, inbound: [{ wamid: `wamid.${s}.${k}`, from: `2010123456${String(k++).padStart(2, '0')}`, ts: Math.floor(Date.now() / 1000), type: 'text', text: 'hi', profileName: name }], statuses: [], receivedAt: 1 });
  const ask = async (text: string, call?: { name: string; args: unknown }, ai = scriptedAi([...(call ? [{ call }] : []), { text: 'المعاينة جاهزة.' }])): Promise<TurnOut> => {
    configureAssistant({ ai: ai as never, help: noHelp });
    const res = await post(s, api.token, '/turn', { conversationId: crypto.randomUUID(), text, locale: 'ar' });
    expect(res.status).toBe(200);
    return (await res.json()) as TurnOut;
  };
  const get = async (path: string) => (await (await api.call('GET', path)).json()) as never;
  return {
    s, api, ws, ask, get,
    apply: (id: string) => post(s, api.token, `/previews/${id}/apply`),
    undo: (id: string) => post(s, api.token, `/applied/${id}/undo`),
    confirm: (approvalId: string, token: string, as = api.token) => post(s, as, `/approvals/${approvalId}/confirm`, { token }),
    reject: (approvalId: string) => post(s, api.token, `/approvals/${approvalId}/reject`, {}),
  };
}
