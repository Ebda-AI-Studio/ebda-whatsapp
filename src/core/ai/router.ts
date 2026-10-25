/**
 * One decision per inbound message, taken inside the customer's turn lock: the ordering bot when the customer is mid-order
 * (or tapped one of its buttons, or sent a cart or a payment picture), otherwise the AI agent when it is switched on. Never both.
 */
import type { LinkHost } from '../store-link/host';
import { orderingActive, orderingEngaged, runBotTurnLocked, serialisedTurn, turnGone, type BotInput } from '../ordering/bot';
import { frontDeskActive, runFrontDesk, runHoursGate } from '../front-desk';
import { agentConfig } from './config';
import { agentActive, handoff, isHumanRequest, runAgentTurn } from './agent';
import { handoffActive } from './handoff';
import { readAgentSettings } from './settings';

/** Types the ordering bot understands; the agent alone also answers the rest with a short "text only" note. */
const ORDERING_TYPES = new Set(['text', 'interactive', 'order', 'image']);

export async function runTurn(host: LinkHost, input: BotInput, now: number): Promise<void> {
  await serialisedTurn(host, input.from, async () => {
    const agentOn = agentActive(host);
    const orderingOn = orderingActive(host);
    if (!agentOn && !orderingOn && !frontDeskActive(host)) return;
    if (handoffActive(host, input.from, now)) return; // a person has the conversation: the bot is silent
    if (await runHoursGate(host, input, now) === 'stop') return;
    if (await runFrontDesk(host, input, now, { agentOn }) === 'handled') return;
    if (!agentOn && !orderingOn) return;
    if (agentOn && input.type === 'text' && input.text && !turnGone(host, input) && isHumanRequest(input.text)) {
      const lang = readAgentSettings(host.sql).language;
      return handoff(host, input, 'asked', lang === 'en' || (lang === 'auto' && /[A-Za-z]/.test(input.text) && !/[؀-ۿ]/.test(input.text)) ? 'en' : 'ar', now);
    }
    if (!ORDERING_TYPES.has(input.type)) return agentOn ? runAgentTurn(host, input, now) : undefined;
    if (orderingOn && (!agentOn || orderingEngaged(host, input, now))) return runBotTurnLocked(host, input, now);
    if (agentOn && agentConfig().copy) return runAgentTurn(host, input, now);
  });
}
