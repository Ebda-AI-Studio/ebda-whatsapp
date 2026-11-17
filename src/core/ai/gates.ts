/**
 * The router's "may the bot speak at all" decisions as pure predicates, so a path outside the router (an abandoned voice turn) applies the same ones:
 * a store with no package or a suspended one, a conversation a person has taken over, and closed shop hours that stop the bot.
 */
import { serviceAllowed } from '../billing/entitlements';
import { hoursAllowBot } from '../front-desk';
import { isSuspended } from '../numbers/health';
import type { LinkHost } from '../store-link/host';
import { handoffActive } from './handoff';

/** WA-NOFREE-1 + W2-OPS: no package or a suspended store means no bot, no menu, no agent. */
export const serviceOpen = (host: Pick<LinkHost, 'sql'>, now: number): boolean => serviceAllowed(host.sql, now) && !isSuspended(host.sql);

export const botMaySpeak = (host: LinkHost, waId: string, now: number): boolean => serviceOpen(host, now) && !handoffActive(host, waId, now) && hoursAllowBot(host, now);
