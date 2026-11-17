/**
 * One decision per inbound message, taken inside the customer's turn lock: the ordering bot when the customer is mid-order
 * (or tapped one of its buttons, or sent a cart or a payment picture), otherwise the AI agent when it is switched on. Never both.
 */
import { isPlainEnglish } from '../franco';
import type { LinkHost } from '../store-link/host';
import { orderingActive, orderingEngaged, proofExpected, runBotTurnLocked, serialisedTurn, turnGone, type BotInput } from '../ordering/bot';
import { recordFunnel } from '../bot-funnel';
import { frontDeskActive, runFrontDesk, runHoursGate } from '../front-desk';
import { agentConfig } from './config';
import { agentActive, handoff, isHumanRequest, runAgentTurn } from './agent';
import { serviceOpen } from './gates';
import { handoffActive } from './handoff';
import { readAgentSettings } from './settings';

/** Types the ordering bot understands; the agent alone also answers the rest with a short "text only" note. */
const ORDERING_TYPES = new Set(['text', 'interactive', 'order', 'image']);

export async function runTurn(host: LinkHost, input: BotInput, now: number): Promise<void> {
  await serialisedTurn(host, input.from, async () => {
    // WA-NOFREE-1: no package, no bot, no menu, no AI agent (the inbound itself is already stored: reading stays open).
    if (!serviceOpen(host, now)) return; // no package or a suspended store: bot, menu, ordering and agent are all off (the inbound is stored; nothing answers)
    const agentOn = agentActive(host);
    const orderingOn = orderingActive(host);
    if (!agentOn && !orderingOn && !frontDeskActive(host)) return;
    if (handoffActive(host, input.from, now)) return; // a person has the conversation: the bot is silent
    await recordFunnel(host, { step: 'conversation', waId: input.from, now, skip: () => turnGone(host, input) });
    if (await runHoursGate(host, input, now) === 'stop') return;
    if (await runFrontDesk(host, input, now, { agentOn }) === 'handled') return;
    if (!agentOn && !orderingOn) return;
    if (agentOn && input.type === 'text' && input.text && !turnGone(host, input) && isHumanRequest(input.text)) {
      const lang = readAgentSettings(host.sql).language;
      return handoff(host, input, 'asked', lang === 'en' || (lang === 'auto' && isPlainEnglish(input.text)) ? 'en' : 'ar', now);
    }
    // A picture is the ordering bot's only at its payment-proof step; for the agent it is a message it cannot read, answered with one short note.
    if (agentOn && input.type === 'image' && !proofExpected(host, input.from)) return runAgentTurn(host, input, now);
    if (!ORDERING_TYPES.has(input.type)) return agentOn ? runAgentTurn(host, input, now) : undefined;
    if (orderingOn && (!agentOn || orderingEngaged(host, input, now))) return runBotTurnLocked(host, input, now);
    if (agentOn && agentConfig().copy) return runAgentTurn(host, input, now);
  });
}
