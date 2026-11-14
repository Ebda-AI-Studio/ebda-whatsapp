import type { Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import { z } from 'zod';
import { BUDGET } from '../../foundation/smart-layer/plan/budget';
import { checkAdapterContract } from '../../foundation/smart-layer/eval/adapter-contract';
import { runTurn } from '../../foundation/smart-layer/loop';
import { buildSystemPrompt, computeReleaseId } from '../../foundation/smart-layer/release';
import type { TurnCtx } from '../../foundation/smart-layer/types';
import { alert } from '../core/observability';
import { chatAdapter } from '../core/smart-layer/adapter';
import { viewOf, type StoredCap } from '../core/smart-layer/registry';
import type { HelpCorpus, HelpDeps } from '../core/smart-layer/help-index';
import type { AiBinding } from '../../foundation/smart-layer/provider';
import registryJson from '../../assistant/registry.generated.json';
import corpusJson from '../../assistant/help-corpus.generated.json';
import { ensureHelpIndex, helpDeps } from '../core/smart-layer/help-index';
import type { CallApi } from '../core/smart-layer/tools/read.tools';
import { apiError, workspaceStub, type ApiEnv } from './shared';

const turnBody = z.object({ conversationId: z.string().uuid(), text: z.string().min(1).max(BUDGET.inputChars), locale: z.enum(['ar', 'en']) });
const feedbackBody = z.object({ turnId: z.string().uuid(), thumb: z.enum(['up', 'down']) });

// Once per isolate: the tool list must agree with the capability registry (a weaker policy or a non-live capability fails loud, here and in the tests),
// the help index is brought up to date in the background, and the release id (prompt + tools + models + budget) is computed.
let release: Promise<string> | undefined;
let contractChecked = false;
let indexKicked = false;
const REGISTRY = viewOf(registryJson as unknown as StoredCap[]);
const CORPUS = corpusJson as unknown as HelpCorpus;
/** Test seam (like `configureAgent`): a scripted model binding and a fake help index. Production never sets it. */
let override: { ai?: AiBinding; help?: HelpDeps } = {};
export function configureAssistant(o: { ai?: AiBinding; help?: HelpDeps }): typeof override {
  const previous = override;
  override = o;
  return previous;
}
export const ASSISTANT_CAPABILITY = 'assistant.ebda-assistant';

/** Assistant routes. `api` is the app these routes are mounted on: a tool calls one of ITS routes in-process with the merchant's own Authorization header (SL-CHAT-1). */
export function assistantRoutes(api: Hono<ApiEnv>) {
  const r = new HonoApp<ApiEnv>();

  r.post('/stores/:storeId/assistant/turn', async (c) => {
    const body = turnBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, 'invalid_request');
    const ws = await workspaceStub(c);
    if (!ws) return apiError(c, 404, 'not_found');
    const storeId = c.req.param('storeId')!;
    const auth = c.req.header('authorization') ?? '';
    // Always the route's own store: the model never chooses it. A path or query value the model wrote is only ever an encoded value.
    const callApi: CallApi = async (ctx, path, query) => {
      const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
      const res = await api.request(`/stores/${ctx.storeId}${path}${qs}`, { method: 'GET', headers: { authorization: auth } }, c.env, c.executionCtx);
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const adapter = chatAdapter({ env: c.env, ws, callApi, registry: REGISTRY, corpus: CORPUS, assistantCapability: ASSISTANT_CAPABILITY, ...(override.ai ? { ai: override.ai } : {}), ...(override.help ? { help: override.help } : {}) });
    if (!contractChecked) {
      const problems = checkAdapterContract(adapter);
      if (problems.length) throw new Error(`assistant adapter contract: ${problems.join('; ')}`);
      contractChecked = true;
    }
    if (!indexKicked && !override.help) {
      indexKicked = true;
      c.executionCtx.waitUntil(ensureHelpIndex(helpDeps(c.env), CORPUS).catch((e) => { indexKicked = false; alert('assistant_help_index_failed', { error: e instanceof Error ? e.name : 'unknown' }); }));
    }
    release ??= computeReleaseId({ systemPrompt: buildSystemPrompt('ar'), tools: adapter.tools(), models: adapter.models, budget: BUDGET });
    const ctx: TurnCtx = { product: 'chat', storeId, userId: c.get('principal').userId, role: c.get('storeRole'), locale: body.data.locale, now: Date.now(), conversationId: body.data.conversationId, releaseId: await release };
    const res = await runTurn(adapter, ctx, { text: body.data.text });
    return c.json({ status: res.status, segments: res.segments, previews: res.previews, turnId: res.turnId });
  });

  // Only the caller's own turns: a conversation id is chosen by the client, so it never opens another member's chat.
  r.get('/stores/:storeId/assistant/conversations/:conversationId', async (c) => {
    const id = z.string().uuid().safeParse(c.req.param('conversationId'));
    if (!id.success) return apiError(c, 400, 'invalid_request');
    const ws = await workspaceStub(c);
    if (!ws) return apiError(c, 404, 'not_found');
    const me = c.get('principal').userId;
    const turns = (await ws.smartLayer('loadTurns', [c.req.param('storeId'), id.data, 40])) as Array<{ id: string; userId: string; role: string; maskedText: string; at: number }>;
    return c.json({ items: turns.filter((t) => t.userId === me).map((t) => ({ id: t.id, role: t.role, text: t.maskedText, at: t.at })) });
  });

  r.post('/stores/:storeId/assistant/feedback', async (c) => {
    const body = feedbackBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, 'invalid_request');
    const ws = await workspaceStub(c);
    if (!ws) return apiError(c, 404, 'not_found');
    await ws.smartLayer('appendAudit', [{ id: crypto.randomUUID(), storeId: c.req.param('storeId'), userId: c.get('principal').userId, turnId: body.data.turnId, at: Date.now(), releaseId: 'feedback', maskedPrompt: '', maskedOutput: '', rails: { thumb: body.data.thumb }, toolsOffered: [], toolCalls: [], outcome: 'answered', inputTokens: 0, outputTokens: 0, model: 'none' }]);
    return c.json({ ok: true });
  });

  return r;
}
