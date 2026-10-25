/**
 * The front desk: what answers a customer before the ordering bot and the AI agent do. The merchant's service menu (a list of
 * FAQ rows, "Order", "Our location", "Talk to a person"), the store location, and the business-hours gate live here. Every
 * switch off = this module does nothing and the bot and agent behave exactly as they did before it existed.
 *
 * A turn is replayable: sends have deterministic idempotency keys (`front:<message>:<n>`), so a re-run sends nothing twice.
 */
import { isOpen, nextOpenAt } from './front-desk-hours';
import { markHandoff } from './ai/handoff';
import type { Locale } from './ordering/copy';
import { orderingActive, orderingEngaged, runBotTurnLocked, toJob, turnGone, type BotInput, type BotMsg } from './ordering/bot';
import type { LinkHost } from './store-link/host';
import { getState, putState, readSettings } from './store-link/settings';
import { storeLink } from './store-link';
import { normaliseText } from './text-normalise';

const ROW = /^menu:(ar|en):(order|human|loc|faq:([a-z0-9-]+))$/;
const MAX_ROWS = 10;
/** A bot session this fresh and not idle means the customer is mid-order: the ordering bot owns free text. */
const SESSION_FRESH_MS = 30 * 60_000;

const normIn = (words: readonly string[]) => new Set(words.map(normaliseText));

/** True when the merchant has a usable menu: switched on, with at least one row of their own, and copy registered. */
export function menuActive(host: Pick<LinkHost, 'sql'>): boolean {
  const m = readSettings(host).menu;
  return storeLink().copy !== null && m.enabled && m.items.length > 0;
}

/** Any front-desk feature is on: the inbound message needs a turn even when neither the ordering bot nor the agent is. */
export function frontDeskActive(host: Pick<LinkHost, 'sql'>): boolean {
  if (storeLink().copy === null) return false;
  const s = readSettings(host);
  return menuActive(host) || s.hours.enabled || s.location !== null;
}

/** The front desk answers every message itself right now (a menu is on, or the shop is closed): the generic auto reply would double it. */
export function frontDeskOwnsReplies(host: Pick<LinkHost, 'sql'>, now: number): boolean {
  if (menuActive(host)) return true;
  const hours = readSettings(host).hours;
  return storeLink().copy !== null && hours.enabled && !isOpen(hours, now);
}

function midOrder(host: Pick<LinkHost, 'sql'>, from: string, now: number): boolean {
  const row = host.sql.exec<{ state: string; updated_at: number }>('SELECT state, updated_at FROM bot_sessions WHERE wa_id = ?', from).toArray()[0];
  return !!row && row.state !== 'idle' && now - row.updated_at < SESSION_FRESH_MS;
}

/** The bot is waiting for a typed delivery address: the next free text is that address, whatever it says. */
function awaitingAddress(host: Pick<LinkHost, 'sql'>, from: string, now: number): boolean {
  const row = host.sql.exec<{ state: string; updated_at: number }>('SELECT state, updated_at FROM bot_sessions WHERE wa_id = ?', from).toArray()[0];
  return row?.state === 'awaiting_address' && now - row.updated_at < SESSION_FRESH_MS;
}

function localeOfText(host: Pick<LinkHost, 'sql'>, input: BotInput): Locale {
  if (input.text && /[؀-ۿ]/.test(input.text)) return 'ar';
  if (input.text && /[A-Za-z]/.test(input.text)) return 'en';
  const row = host.sql.exec<{ locale: string }>('SELECT locale FROM bot_sessions WHERE wa_id = ?', input.from).toArray()[0];
  return row?.locale === 'en' ? 'en' : 'ar';
}

/** Stores and sends the messages of this turn, in order. Mirrors the ordering bot's flush (same erasure and opt-out guards). */
async function send(host: LinkHost, input: BotInput, now: number, out: BotMsg[], prefix = 'front'): Promise<void> {
  for (let i = 0; i < out.length; i++) {
    const key = `${prefix}:${input.messageId}:${i}`;
    const built = toJob(host, input.from, input.phoneNumberId, key, out[i]!);
    const gone = host.storage.transactionSync(() => {
      if (turnGone(host, input)) return true;
      if (host.sql.exec('SELECT 1 FROM messages WHERE idempotency_key = ?', key).toArray().length) return false;
      const { conversationId } = host.ensureConversation(input.from, now);
      host.insertOutbound(conversationId, { type: built.type, preview: built.preview, body: built.preview, key, author: 'bot' }, now);
      return false;
    });
    if (gone) return;
    await host.deliver(built.job);
    if (i < out.length - 1 && host.sendGapMs > 0) await new Promise((r) => setTimeout(r, host.sendGapMs));
  }
}

function locationMessages(host: Pick<LinkHost, 'sql'>): BotMsg[] {
  const l = readSettings(host).location!;
  return [{ kind: 'location', latitude: l.latitude, longitude: l.longitude, name: l.name, address: l.address }, { kind: 'text', text: `https://maps.google.com/?q=${l.latitude},${l.longitude}` }];
}

function menuList(host: LinkHost, locale: Locale): BotMsg {
  const copy = storeLink().copy!.menu;
  const settings = readSettings(host);
  const rows: { id: string; title: string }[] = [];
  if (orderingActive(host)) rows.push({ id: `menu:${locale}:order`, title: copy.orderRow[locale] });
  const tail: { id: string; title: string }[] = [];
  if (settings.location) tail.push({ id: `menu:${locale}:loc`, title: copy.locationRow[locale] });
  tail.push({ id: `menu:${locale}:human`, title: copy.humanRow[locale] });
  // Meta allows 10 rows: the fixed rows always fit and the merchant's items fill what is left, in their order.
  const room = MAX_ROWS - rows.length - tail.length;
  for (const item of settings.menu.items.slice(0, room)) rows.push({ id: `menu:${locale}:faq:${item.id}`, title: item.title[locale] });
  return { kind: 'list', body: copy.body[locale], button: copy.button[locale], rows: [...rows, ...tail] };
}

/**
 * Business hours. While the shop is closed, the first message of the closed period gets the merchant's away message (once per
 * customer per period: the period is named by the moment the shop next opens). 'stop' = the away message replaces the bot and agent.
 */
export async function runHoursGate(host: LinkHost, input: BotInput, now: number): Promise<'continue' | 'stop'> {
  const hours = readSettings(host).hours;
  if (!storeLink().copy || isOpen(hours, now)) return 'continue';
  const period = String(nextOpenAt(hours, now) ?? 'never');
  const stateKey = `away:${input.from}`;
  const mine = host.sql.exec('SELECT 1 FROM messages WHERE idempotency_key = ?', `away:${input.messageId}:0`).toArray().length > 0;
  if (getState(host, stateKey) !== period || mine) {
    if (turnGone(host, input)) return 'stop';
    await send(host, input, now, [{ kind: 'text', text: hours.awayMessage[localeOfText(host, input)] }], 'away');
    putState(host, stateKey, period);
  } else if (!hours.ordersWhileClosed) {
    return 'stop'; // already told this period: stay quiet instead of repeating it
  }
  return hours.ordersWhileClosed ? 'continue' : 'stop';
}

/**
 * Returns 'handled' when the front desk answered (the router stops), 'pass' to let the ordering bot or the agent take the message.
 * The caller holds the customer's turn lock.
 */
export async function runFrontDesk(host: LinkHost, input: BotInput, now: number, ctx: { agentOn: boolean }): Promise<'handled' | 'pass'> {
  const copy = storeLink().copy;
  const menuOn = menuActive(host);
  const hasLocation = readSettings(host).location !== null;
  if (!copy || (!menuOn && !hasLocation)) return 'pass';
  if (turnGone(host, input)) return 'handled';

  const tap = menuOn && input.reply?.kind === 'list' ? ROW.exec(input.reply.id) : null;
  if (tap) {
    const locale = tap[1] as Locale;
    if (tap[2] === 'order') {
      if (!orderingActive(host)) { await send(host, input, now, [menuList(host, locale)]); return 'handled'; }
      await runBotTurnLocked(host, input, now, { restart: true });
      return 'handled';
    }
    if (tap[2] === 'human') {
      const ok = host.storage.transactionSync(() => {
        if (turnGone(host, input)) return false;
        markHandoff(host, input.from, 'asked', now);
        return true;
      });
      if (ok) await send(host, input, now, [{ kind: 'text', text: copy.menu.handedOff[locale] }]);
      return 'handled';
    }
    if (tap[2] === 'loc') {
      await send(host, input, now, hasLocation ? locationMessages(host) : [menuList(host, locale)]);
      return 'handled';
    }
    const item = tap[3] ? readSettings(host).menu.items.find((i) => i.id === tap[3]) : undefined;
    await send(host, input, now, [item ? { kind: 'text', text: item.answer[locale] } : menuList(host, locale)]);
    return 'handled';
  }

  if (input.type !== 'text' || !input.text || input.reply || input.order) return 'pass';
  const word = normaliseText(input.text);
  const open = (): Promise<'handled'> => send(host, input, now, [menuList(host, localeOfText(host, input))]).then(() => 'handled' as const);
  if (menuOn && normIn(copy.menu.menuWords).has(word)) return open();
  if (hasLocation && !awaitingAddress(host, input.from, now) && normIn(copy.menu.locationWords).has(word)) { await send(host, input, now, locationMessages(host)); return 'handled'; }
  if (!menuOn || midOrder(host, input.from, now)) return 'pass';
  if (normIn(copy.menu.greetingWords).has(word)) return open();
  // Anything else while idle: the menu answers unless the agent can (it answers free text) or the text is an ordering keyword.
  if (!ctx.agentOn && !orderingEngaged(host, input, now)) return open();
  return 'pass';
}
