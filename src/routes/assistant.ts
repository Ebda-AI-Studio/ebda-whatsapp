import type { Hono } from 'hono';
import { Hono as HonoApp } from 'hono';
import { z } from 'zod';
import { BUDGET } from '../../foundation/smart-layer/plan/budget';
import { checkAdapterContract } from '../../foundation/smart-layer/eval/adapter-contract';
import { runTurn } from '../../foundation/smart-layer/loop';
import { applyPreview, undoApplied } from '../../foundation/smart-layer/exec/journal';
import { confirmApproval, rejectApproval, type ApprovalToken } from '../../foundation/smart-layer/exec/approval';
import { assistantConfirmRequest, assistantRejectRequest } from '../core/api/contract';
import { buildSystemPrompt, computeReleaseId } from '../../foundation/smart-layer/release';
import type { Mode, TurnCtx } from '../../foundation/smart-layer/types';
import { alert } from '../core/observability';
import { chatAdapter } from '../core/smart-layer/adapter';
import { chatControls } from '../core/smart-layer/controls';
import type { Env } from '../env';
import { viewOf, type StoredCap } from '../core/smart-layer/registry';
import type { HelpCorpus, HelpDeps } from '../core/smart-layer/help-index';
import type { AiBinding } from '../../foundation/smart-layer/provider';
import registryJson from '../../assistant/registry.generated.json';
import corpusJson from '../../assistant/help-corpus.generated.json';
import { ensureHelpIndex, helpDeps } from '../core/smart-layer/help-index';
import type { CallApi } from '../core/smart-layer/tools/read.tools';
import { apiError, workspaceStub, type ApiContext, type ApiEnv } from './shared';

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
/** `<user>:<client id>`: one history per (store, user, conversation). Turns of another member under the same client id are simply a different conversation. */
const ownConversation = (userId: string, conversationId: string): string => `${userId}:${conversationId}`;
export const ASSISTANT_CAPABILITY = 'assistant.ebda-assistant';

/** The kill switch covers every assistant route, not just the turn: with the assistant off, history and feedback are closed too. */
const assistantOff = async (c: { env: Env }, ws: { assistantMode(): Promise<Mode> }) => (await chatControls(c.env, ws)).mode === 'off';

/** A person presses a handful of buttons a minute; more is a script. */
const limited = async (c: ApiContext, ws: { smartLayer(op: 'bump', args: unknown[]): Promise<unknown> }, kind: string): Promise<boolean> =>
  ((await ws.smartLayer('bump', [`${kind}:${c.req.param('storeId')}:${c.get('principal').userId}`, 60_000, Date.now()])) as number) > 30;

/** The engine's answer as the panel reads it: 200 with a status word, except the two answers that are real HTTP errors. */
function outcome(c: ApiContext, out: { status: string }, approvals: ApprovalToken[]) {
  if (out.status === 'not_found') return apiError(c, 404, 'not_found');
  if (out.status === 'forbidden') return apiError(c, 403, 'forbidden');
  return c.json(approvals.length ? { ...out, approvals } : out);
}

/** Assistant routes. `api` is the app these routes are mounted on: a tool calls one of ITS routes in-process with the merchant's own Authorization header (SL-CHAT-1). */
export function assistantRoutes(api: Hono<ApiEnv>) {
  const r = new HonoApp<ApiEnv>();

  /** The adapter and the engine context of THIS request: the store is the route's own, the person is the session's, the tools call `api` with the caller's own header (SL-CHAT-1). */
  const session = async (c: ApiContext, conversationId: string, locale: 'ar' | 'en') => {
    const ws = await workspaceStub(c);
    if (!ws) return null;
    const storeId = c.req.param('storeId')!;
    const auth = c.req.header('authorization') ?? '';
    // Always the route's own store: the model never chooses it. A path or query value the model wrote is only ever an encoded value.
    const callApi: CallApi = async (ctx, path, query, init) => {
      const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
      const res = await api.request(`/stores/${ctx.storeId}${path}${qs}`, { method: init?.method ?? 'GET', headers: { authorization: auth, ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }, c.env, c.executionCtx);
      return { status: res.status, json: await res.json().catch(() => null) };
    };
    const adapter = chatAdapter({ env: c.env, ws, callApi, registry: REGISTRY, corpus: CORPUS, assistantCapability: ASSISTANT_CAPABILITY, ...(override.ai ? { ai: override.ai } : {}), ...(override.help ? { help: override.help } : {}) });
    if (!contractChecked) {
      const problems = checkAdapterContract(adapter);
      if (problems.length) throw new Error(`assistant adapter contract: ${problems.join('; ')}`);
      contractChecked = true;
    }
    release ??= computeReleaseId({ systemPrompt: buildSystemPrompt('ar'), tools: adapter.tools(), models: adapter.models, budget: BUDGET });
    // The history key carries the CALLER: the engine loads turns by conversation id alone, so a client-chosen id can never open (or plant text in) another member's history.
    const userId = c.get('principal').userId;
    const ctx: TurnCtx = { product: 'chat', storeId, userId, role: c.get('storeRole'), locale, now: Date.now(), conversationId: ownConversation(userId, conversationId), releaseId: await release };
    return { ws, adapter, ctx };
  };

  r.post('/stores/:storeId/assistant/turn', async (c) => {
    const body = turnBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, 'invalid_request');
    const s = await session(c, body.data.conversationId, body.data.locale);
    if (!s) return apiError(c, 404, 'not_found');
    if (!indexKicked && !override.help) {
      indexKicked = true;
      c.executionCtx.waitUntil(ensureHelpIndex(helpDeps(c.env), CORPUS).catch((e) => { indexKicked = false; alert('assistant_help_index_failed', { error: e instanceof Error ? e.name : 'unknown' }); }));
    }
    // The confirm token leaves the engine through this callback only: into THIS response for the merchant's own button, nowhere else.
    const approvals: ApprovalToken[] = [];
    const res = await runTurn(s.adapter, s.ctx, { text: body.data.text }, { onApprovalToken: (t) => approvals.push(t) });
    c.header('cache-control', 'no-store');
    return c.json({ status: res.status, segments: res.segments, previews: res.previews, ...(approvals.length ? { approvals } : {}), turnId: res.turnId });
  });

  // The merchant presses Apply on a preview card: the only way a change happens. Its own route, never reachable from a tool or from chat text.
  r.post('/stores/:storeId/assistant/previews/:previewId/apply', async (c) => {
    const id = z.string().uuid().safeParse(c.req.param('previewId'));
    if (!id.success) return apiError(c, 400, 'invalid_request');
    const s = await session(c, crypto.randomUUID(), 'ar');
    if (!s) return apiError(c, 404, 'not_found');
    if (await assistantOff(c, s.ws)) return apiError(c, 403, 'forbidden', 'assistant_off');
    if (await limited(c, s.ws, 'applyrate')) return apiError(c, 429, 'rate_limited');
    const out = await applyPreview(s.adapter, s.ctx, id.data);
    return outcome(c, out, []);
  });

  r.post('/stores/:storeId/assistant/applied/:appliedId/undo', async (c) => {
    const id = z.string().uuid().safeParse(c.req.param('appliedId'));
    if (!id.success) return apiError(c, 400, 'invalid_request');
    const s = await session(c, crypto.randomUUID(), 'ar');
    if (!s) return apiError(c, 404, 'not_found');
    if (await assistantOff(c, s.ws)) return apiError(c, 403, 'forbidden', 'assistant_off');
    if (await limited(c, s.ws, 'undorate')) return apiError(c, 429, 'rate_limited');
    const approvals: ApprovalToken[] = [];
    const out = await undoApplied(s.adapter, s.ctx, id.data, { onApprovalToken: (t) => approvals.push(t) });
    c.header('cache-control', 'no-store');
    return outcome(c, out, approvals);
  });

  // The merchant presses the confirm button on a confirm-class card: the only way money, deletion, customer messaging, bulk or price changes happen. The token is the
  // server-issued, single-use one from the turn response, bound to the exact previewed payload; chat text can never carry it, so a typed "yes" applies nothing.
  r.post('/stores/:storeId/assistant/approvals/:approvalId/confirm', async (c) => {
    const id = z.string().uuid().safeParse(c.req.param('approvalId'));
    const body = assistantConfirmRequest.safeParse(await c.req.json().catch(() => null));
    if (!id.success || !body.success) return apiError(c, 400, 'invalid_request');
    const s = await session(c, crypto.randomUUID(), 'ar');
    if (!s) return apiError(c, 404, 'not_found');
    if (await assistantOff(c, s.ws)) return apiError(c, 403, 'forbidden', 'assistant_off');
    if (await limited(c, s.ws, 'confirmrate')) return apiError(c, 429, 'rate_limited');
    const approvals: ApprovalToken[] = [];
    const out = await confirmApproval(s.adapter, s.ctx, id.data, body.data.token, { onApprovalToken: (t) => approvals.push(t) });
    c.header('cache-control', 'no-store');
    return outcome(c, out, approvals);
  });

  r.post('/stores/:storeId/assistant/approvals/:approvalId/reject', async (c) => {
    const id = z.string().uuid().safeParse(c.req.param('approvalId'));
    const body = assistantRejectRequest.safeParse(await c.req.json().catch(() => ({})));
    if (!id.success || !body.success) return apiError(c, 400, 'invalid_request');
    const s = await session(c, crypto.randomUUID(), 'ar');
    if (!s) return apiError(c, 404, 'not_found');
    if (await assistantOff(c, s.ws)) return apiError(c, 403, 'forbidden', 'assistant_off');
    const out = await rejectApproval(s.adapter, s.ctx, id.data, body.data.reason);
    if (out.status === 'missing') return apiError(c, 404, 'not_found');
    if (out.status === 'forbidden') return apiError(c, 403, 'forbidden');
    return c.json(out);
  });

  // Only the caller's own turns: a conversation id is chosen by the client, so it never opens another member's chat.
  r.get('/stores/:storeId/assistant/conversations/:conversationId', async (c) => {
    const id = z.string().uuid().safeParse(c.req.param('conversationId'));
    if (!id.success) return apiError(c, 400, 'invalid_request');
    const ws = await workspaceStub(c);
    if (!ws) return apiError(c, 404, 'not_found');
    if (await assistantOff(c, ws)) return apiError(c, 403, 'forbidden', 'assistant_off');
    const me = c.get('principal').userId;
    const turns = (await ws.smartLayer('loadTurns', [c.req.param('storeId'), ownConversation(me, id.data), 40])) as Array<{ id: string; userId: string; role: string; maskedText: string; at: number }>;
    return c.json({ items: turns.filter((t) => t.userId === me).map((t) => ({ id: t.id, role: t.role, text: t.maskedText, at: t.at })) });
  });

  r.post('/stores/:storeId/assistant/feedback', async (c) => {
    const body = feedbackBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return apiError(c, 400, 'invalid_request');
    const ws = await workspaceStub(c);
    if (!ws) return apiError(c, 404, 'not_found');
    if (await assistantOff(c, ws)) return apiError(c, 403, 'forbidden', 'assistant_off');
    const storeId = c.req.param('storeId')!;
    const userId = c.get('principal').userId;
    // A person rates a handful of answers a minute; more is a script filling the journal for 90 days.
    if (((await ws.smartLayer('bump', [`fbrate:${storeId}:${userId}`, 60_000, Date.now()])) as number) > 30) return apiError(c, 429, 'rate_limited');
    // Only an answer THIS person received, once: another member's turn id or an invented one is a plain 404.
    const st = (await ws.smartLayer('turnState', [storeId, userId, body.data.turnId])) as { own: boolean; rated: boolean };
    if (!st.own) return apiError(c, 404, 'not_found');
    if (st.rated) return c.json({ ok: true });
    await ws.smartLayer('appendAudit', [{ id: crypto.randomUUID(), storeId, userId, turnId: body.data.turnId, at: Date.now(), releaseId: 'feedback', maskedPrompt: '', maskedOutput: '', rails: { thumb: body.data.thumb }, toolsOffered: [], toolCalls: [], outcome: 'answered', inputTokens: 0, outputTokens: 0, model: 'none' }]);
    return c.json({ ok: true });
  });

  return r;
}
