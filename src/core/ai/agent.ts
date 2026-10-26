/**
 * The AI agent's turn: one inbound text, an answer (or a handoff). It runs inside the customer's turn lock, never alongside the
 * ordering bot, and follows the same rules as that bot: the customer must still be there (not erased, not opted out since)
 * after every await before a write, replies go out directly 150 ms apart inside the 24 h window only, and a replayed task
 * does not call the model again (the finished turn is recorded in the same transaction as its replies).
 */
import { WINDOW_MS } from '../dto';
import { errClass, alert } from '../observability';
import { turnGone, orderingActive, runBotTurnLocked, type BotInput } from '../ordering/bot';
import type { SendJob } from '../send-queue';
import { bridgeFor } from '../store-link';
import type { LinkHost } from '../store-link/host';
import { normaliseText } from '../text-normalise';
import { loadConnectors, runConnectorTool } from '../connectors/registry';
import { agentConfig } from './config';
import { recordFunnel } from '../bot-funnel';
import { markHandoff, type HandoffReason } from './handoff';
import { retrieveKnowledge } from './knowledge';
import { heartbeatHold, holdCredits, releaseHold, settleHold } from './credits';
import { LlmError, type ChatTurn, type LlmProvider, type LlmResponse } from './provider';
import { getAgentState, providerFor, putAgentState, readAgentSettings, type AgentSettings } from './settings';
import { MAX_CALLS_PER_ROUND, MAX_TOOL_ROUNDS, runTool, toolDefs, type ToolContext } from './tools';

export const AGENT_MAX_TOKENS = 450;
const HISTORY_MESSAGES = 8;
const HISTORY_CHARS = 500;
export const REPLY_MAX_CHARS = 1500;

export const agentActive = (host: Pick<LinkHost, 'sql'>): boolean => agentConfig().copy !== null && readAgentSettings(host.sql).enabled;

class Aborted extends Error {}

type Locale = 'ar' | 'en';
const localeFor = (s: AgentSettings, text: string | null): Locale => (s.language === 'auto' ? (text && /[A-Za-z]/.test(text) && !/[؀-ۿ]/.test(text) ? 'en' : 'ar') : s.language);

/** Any pattern of the addon that matches the normalised words: the customer wants a person. */
export function isHumanRequest(text: string): boolean {
  const copy = agentConfig().copy;
  if (!copy) return false;
  const norm = normaliseText(text);
  return copy.handoffPatterns.some((re) => re.test(norm));
}

const windowOpen = (host: LinkHost, waId: string, now: number): boolean => {
  const r = host.sql.exec<{ last_inbound_at: number | null }>('SELECT last_inbound_at FROM contacts WHERE wa_id = ?', waId).toArray()[0];
  return !!r?.last_inbound_at && r.last_inbound_at * 1000 + WINDOW_MS > now;
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const keyPrefix = (input: BotInput) => `agent:${input.messageId}:`;

// ---- storing and sending -----------------------------------------------------------------------------------------------

/** Stores the texts as queued outbound rows (author agent) and records the turn, atomically. Call inside a transaction. */
function storeReplies(host: LinkHost, input: BotInput, texts: { key: string; text: string }[], now: number): void {
  const { conversationId } = host.ensureConversation(input.from, now);
  for (const { key, text } of texts) {
    if (host.sql.exec('SELECT 1 FROM messages WHERE idempotency_key = ?', key).toArray().length) continue;
    host.insertOutbound(conversationId, { type: 'text', preview: text, body: text, key, author: 'agent' }, now);
  }
}

function recordTurn(host: LinkHost, input: BotInput, outcome: string, now: number): void {
  host.sql.exec('INSERT OR IGNORE INTO agent_turns (message_id, outcome, at) VALUES (?, ?, ?)', input.messageId, outcome, now);
}

/** Hands every stored reply of this turn to the send pipeline, in order. Idempotent: a message already claimed is skipped there. */
async function deliverStored(host: LinkHost, input: BotInput): Promise<void> {
  const rows = host.sql.exec<{ idempotency_key: string; body: string | null }>('SELECT idempotency_key, body FROM messages WHERE idempotency_key LIKE ? ORDER BY id', `${keyPrefix(input)}%`).toArray();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    if (!r.body) continue;
    const job: SendJob = { workspaceId: host.workspaceId, phoneNumberId: input.phoneNumberId, to: input.from, idempotencyKey: r.idempotency_key, kind: 'text', text: r.body };
    await host.deliver(job);
    if (i < rows.length - 1 && host.sendGapMs > 0) await sleep(host.sendGapMs);
  }
}

/** Says something short now (an acknowledgement, a note for a picture). Returns false when the customer is gone. */
async function sayNow(host: LinkHost, input: BotInput, suffix: string, text: string, now: number): Promise<boolean> {
  const key = `${keyPrefix(input)}${suffix}`;
  const stored = host.storage.transactionSync(() => {
    if (turnGone(host, input)) return false;
    storeReplies(host, input, [{ key, text }], now);
    return true;
  });
  if (!stored) return false;
  const job: SendJob = { workspaceId: host.workspaceId, phoneNumberId: input.phoneNumberId, to: input.from, idempotencyKey: key, kind: 'text', text };
  await host.deliver(job);
  return true;
}

/** Tells the customer a person will take over, tags the conversation and silences the bot for the handoff window. */
export async function handoff(host: LinkHost, input: BotInput, reason: HandoffReason, locale: Locale, now: number): Promise<void> {
  const copy = agentConfig().copy!;
  const done = host.storage.transactionSync(() => {
    if (turnGone(host, input)) return false;
    storeReplies(host, input, [{ key: `${keyPrefix(input)}handoff`, text: copy.t.handoffAck[locale] }], now);
    markHandoff(host, input.from, reason, now);
    recordTurn(host, input, `handoff:${reason}`, now);
    return true;
  });
  if (done) {
    await recordFunnel(host, { step: 'handoff', waId: input.from, now, skip: () => turnGone(host, input) });
    await deliverStored(host, input);
  }
}

// ---- the model ----------------------------------------------------------------------------------------------------------

/** History as chat turns: the last few messages of the conversation, oldest first, ending with the customer's message. */
function historyOf(host: LinkHost, input: BotInput): ChatTurn[] {
  const rows = host.sql.exec<{ direction: 'in' | 'out'; text: string | null }>(
    `SELECT m.direction, coalesce(m.body, m.preview) AS text FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
     WHERE ct.wa_id = ? AND m.id <= ? AND coalesce(m.body, m.preview) IS NOT NULL ORDER BY m.id DESC LIMIT ?`,
    input.from, input.messageId, HISTORY_MESSAGES,
  ).toArray().reverse();
  const turns: ChatTurn[] = [];
  for (const r of rows) {
    const content = (r.text ?? '').slice(0, HISTORY_CHARS);
    if (!content) continue;
    const role = r.direction === 'in' ? 'user' : 'assistant';
    const last = turns.at(-1);
    if (last && last.role === role) (last as { content: string }).content += `\n${content}`;
    else turns.push({ role, content });
  }
  while (turns[0]?.role === 'assistant') turns.shift();
  if (turns.at(-1)?.role !== 'user') turns.push({ role: 'user', content: (input.text ?? '').slice(0, HISTORY_CHARS) });
  return turns;
}

async function callModel(provider: LlmProvider, req: Parameters<LlmProvider['complete']>[0]): Promise<LlmResponse> {
  try {
    return await provider.complete(req);
  } catch (err) {
    if (err instanceof LlmError && err.retryable) {
      await sleep(300);
      return provider.complete(req);
    }
    throw err;
  }
}

/** A reply the customer may see: no thinking blocks, no leaked structure, bounded. Null = unusable. */
export function cleanReply(raw: string | undefined): string | null {
  const t = (raw ?? '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!t) return null;
  if (/^[{[]/.test(t) || /"(tool_calls?|intent|arguments)"\s*:/.test(t) || /<\/?(tool_call|function)/i.test(t)) return null;
  return Array.from(t).length > REPLY_MAX_CHARS ? `${Array.from(t).slice(0, REPLY_MAX_CHARS - 1).join('')}…` : t;
}

type Outcome = { kind: 'reply'; text: string } | { kind: 'handoff'; reason: HandoffReason } | { kind: 'order' };

async function converse(host: LinkHost, input: BotInput, provider: LlmProvider, settings: AgentSettings, locale: Locale, now: number, knowledge: string[]): Promise<Outcome> {
  const copy = agentConfig().copy!;
  const bridge = bridgeFor(host.env);
  const availability = { catalog: bridge !== null, orders: bridge !== null, ordering: orderingActive(host) };
  // Tools of the workspace's enabled connectors (the agent is on, or this turn would not be running); names are `<connector>__<tool>`.
  const connectors = loadConnectors(host);
  const tools = [...toolDefs(availability), ...(connectors?.tools ?? [])];
  let connectorCalls = 0;
  const system = copy.systemPrompt({ persona: settings.persona.trim() || copy.defaultPersona[locale], language: settings.language, storeName: null, knowledge, tools: tools.map((t) => t.name) });
  const ctx: ToolContext = { host, from: input.from, bridge, availability };
  const messages = historyOf(host, input);
  const started = Date.now();
  // A slow model is announced before it is asked: the recent answer time of this workspace decides.
  const recent = Number(getAgentState(host.sql, 'latency_ewma_ms'));
  let acked = false;
  const ack = async () => {
    acked = true;
    if (!(await sayNow(host, input, 'ack', copy.t.ack[locale], now))) throw new Aborted();
  };
  if (recent > agentConfig().slowMs) await ack();
  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const offered = round < MAX_TOOL_ROUNDS ? tools : [];
    const res = await callModel(provider, { system, messages, tools: offered, maxTokens: AGENT_MAX_TOKENS });
    if (turnGone(host, input)) throw new Aborted();
    const calls = offered.length ? (res.toolCalls ?? []).slice(0, MAX_CALLS_PER_ROUND) : [];
    if (!calls.length) {
      const elapsed = Date.now() - started;
      putAgentState(host.sql, 'latency_ewma_ms', String(Math.round(recent > 0 ? recent * 0.7 + elapsed * 0.3 : elapsed)));
      const text = cleanReply(res.text);
      return text ? { kind: 'reply', text } : { kind: 'handoff', reason: res.text ? 'bad_output' : 'no_answer' };
    }
    if (!acked && Date.now() - started >= agentConfig().slowMs) await ack();
    messages.push({ role: 'assistant', content: res.text ?? '', toolCalls: calls });
    for (const call of calls) {
      if (connectors?.owns(call.name)) {
        // The customer may have been erased or said stop while the previous await ran: then nothing goes to the client's system.
        if (turnGone(host, input)) throw new Aborted();
        const content = await runConnectorTool(host, connectors, input.from, call.name, call.arguments, `conn:${input.messageId}:${connectorCalls++}`);
        if (turnGone(host, input)) throw new Aborted();
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
        continue;
      }
      const out = await runTool(ctx, call);
      if ('handoff' in out) return { kind: 'handoff', reason: 'model' };
      if ('startOrder' in out) return { kind: 'order' };
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: out.content });
    }
    if (turnGone(host, input)) throw new Aborted();
  }
  return { kind: 'handoff', reason: 'no_answer' };
}

/** The turn lock is held by the caller (the router). */
export async function runAgentTurn(host: LinkHost, input: BotInput, now: number): Promise<void> {
  const copy = agentConfig().copy;
  if (!copy) return;
  const settings = readAgentSettings(host.sql);
  const locale = localeFor(settings, input.text);

  // A replayed task: the finished turn is not asked again; what was stored is (re)delivered.
  const done = host.sql.exec<{ outcome: string }>('SELECT outcome FROM agent_turns WHERE message_id = ?', input.messageId).toArray()[0];
  if (done) {
    if (done.outcome === 'order') await runBotTurnLocked(host, input, now, { restart: true });
    else await deliverStored(host, input);
    return;
  }
  if (turnGone(host, input)) return;
  if (!windowOpen(host, input.from, now)) return; // AI replies (the text-only note included) only inside the 24 h window
  if (input.type !== 'text' || !input.text) {
    if (await sayNow(host, input, 'textonly', copy.t.textOnly[locale], now)) host.storage.transactionSync(() => recordTurn(host, input, 'text_only', now));
    return;
  }

  try {
    const real = await providerFor(host.env, host.workspaceId, host.sql, settings);
    if (!real) return await handoff(host, input, 'misconfigured', locale, now);
    // One credit is held before the model is called (concurrent messages cannot overdraw) and settled after it answered. A workspace
    // with its own model key is never debited. No credit left: the agent stops and a person takes over.
    const holdRef = `ai:${input.messageId}`;
    if (!real.byoKey) {
      const held = host.storage.transactionSync(() => holdCredits(host.sql, holdRef, Date.now()));
      if (held === 'insufficient') {
        alert('agent_no_credits', { workspace: host.workspaceId });
        return await handoff(host, input, 'no_credits', locale, now);
      }
      if (held === 'already_charged') {
        // An earlier run answered and was charged, then died before its replies were stored: never ask (and pay for) the model again.
        // Whatever it stored is handed over again; with nothing stored the customer simply writes again.
        return await deliverStored(host, input);
      }
    }
    let answered = 0;
    // Hold times use the real clock: a turn can outlast the moment it started. Each round tells the hold the turn is still alive.
    const provider: LlmProvider = { byoKey: real.byoKey, complete: async (r) => { if (!real.byoKey) heartbeatHold(host.sql, holdRef, Date.now()); const out = await real.complete(r); answered++; return out; } };
    const finishHold = () => {
      if (real.byoKey) return;
      host.storage.transactionSync(() => (answered > 0 ? settleHold(host.sql, holdRef, Date.now()) : releaseHold(host.sql, holdRef, Date.now())));
    };
    let outcome: Outcome;
    try {
      outcome = await converse(host, input, provider, settings, locale, now, await retrieveKnowledge(host, input.text ?? ''));
    } catch (err) {
      finishHold();
      if (err instanceof Aborted) return;
      alert('agent_model_failed', { workspace: host.workspaceId, error: errClass(err) });
      return await handoff(host, input, 'provider_error', locale, now);
    }
    finishHold();
    if (outcome.kind === 'handoff') return await handoff(host, input, outcome.reason, locale, now);
    if (outcome.kind === 'order') {
      host.storage.transactionSync(() => {
        if (turnGone(host, input)) throw new Aborted();
        recordTurn(host, input, 'order', now);
      });
      return await runBotTurnLocked(host, input, now, { restart: true });
    }
    host.storage.transactionSync(() => {
      if (turnGone(host, input)) throw new Aborted();
      storeReplies(host, input, [{ key: `${keyPrefix(input)}0`, text: outcome.text }], now);
      recordTurn(host, input, 'reply', now);
    });
    await deliverStored(host, input);
  } catch (err) {
    if (!(err instanceof Aborted)) throw err; // a storage or send failure: the scheduler retries the task
  }
}
