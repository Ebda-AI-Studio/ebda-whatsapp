import { isSuspended } from './numbers/health';
/**
 * The front desk: what answers a customer before the ordering bot and the AI agent do. The merchant's service menu (a list of
 * FAQ rows, "Order", "Our location", "Talk to a person"), the store location, and the business-hours gate live here. Every
 * switch off = this module does nothing and the bot and agent behave exactly as they did before it existed.
 *
 * A turn is replayable: sends have deterministic idempotency keys (`front:<message>:<n>`), so a re-run sends nothing twice.
 */
import { recordFunnel } from './bot-funnel';
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
  if (storeLink().copy === null || isSuspended(host.sql)) return false;
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
async function send(host: LinkHost, input: BotInput, now: number, out: BotMsg[], prefix = 'front'): Promise<boolean> {
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
    if (gone) return false;
    await host.deliver(built.job);
    if (i < out.length - 1 && host.sendGapMs > 0) await new Promise((r) => setTimeout(r, host.sendGapMs));
  }
  return true;
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

/** The away message has left: Meta accepted it (or a later status). Queued, claimed, deferred or failed = not on the wire. */
function awayOnTheWire(host: Pick<LinkHost, 'sql'>, key: string): boolean {
  const r = host.sql.exec<{ status: string }>('SELECT status FROM messages WHERE idempotency_key = ?', key).toArray()[0];
  return !!r && ['accepted', 'sent', 'delivered', 'read'].includes(r.status);
}

/** This customer's most recent away message exists but has not left yet (queued, claimed, deferred). */
function awayStillWaiting(host: Pick<LinkHost, 'sql'>, waId: string): boolean {
  const r = host.sql.exec<{ status: string }>(
    `SELECT m.status FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id
     WHERE ct.wa_id = ? AND m.direction = 'out' AND m.idempotency_key LIKE 'away:%' ORDER BY m.id DESC LIMIT 1`, waId,
  ).toArray()[0];
  return !!r && !['accepted', 'sent', 'delivered', 'read', 'failed'].includes(r.status);
}

/** Pure twin of runHoursGate's first and last decisions: false while the shop is closed and takes no orders then (the bot and agent send nothing but the away message). */
export function hoursAllowBot(host: Pick<LinkHost, 'sql'>, now: number): boolean {
  const hours = readSettings(host).hours;
  return !storeLink().copy || isOpen(hours, now) || hours.ordersWhileClosed;
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
    const sent = await send(host, input, now, [{ kind: 'text', text: hours.awayMessage[localeOfText(host, input)] }], 'away');
    // The customer may have been erased or said stop while the send was in flight: then nothing about them is written.
    if (!sent) return 'stop';
    host.storage.transactionSync(() => { if (!turnGone(host, input)) putState(host, stateKey, period); });
    // "We are closed" must be the customer's first reply. If its send was deferred (throttle, wallet wait) or another path holds its
    // claim, it goes out later from the scheduler: nothing else may be sent in this turn, or the bot/agent answer would overtake it.
    if (!awayOnTheWire(host, `away:${input.messageId}:0`)) return 'stop';
  } else if (!hours.ordersWhileClosed) {
    return 'stop'; // already told this period: stay quiet instead of repeating it
  } else if (awayStillWaiting(host, input.from)) {
    return 'stop'; // told this period, but that away message has not left yet: nothing may overtake it
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

  /** One menu list to the customer; counted as the `menu` step when it really went out. */
  const sendMenu = async (locale: Locale): Promise<void> => {
    if (await send(host, input, now, [menuList(host, locale)])) await recordFunnel(host, { step: 'menu', waId: input.from, now, skip: () => turnGone(host, input) });
  };
  const tap = menuOn && input.reply?.kind === 'list' ? ROW.exec(input.reply.id) : null;
  if (tap) {
    const locale = tap[1] as Locale;
    if (tap[2] === 'order') {
      if (!orderingActive(host)) { await sendMenu(locale); return 'handled'; }
      await runBotTurnLocked(host, input, now, { restart: true });
      return 'handled';
    }
    if (tap[2] === 'human') {
      const ok = host.storage.transactionSync(() => {
        if (turnGone(host, input)) return false;
        markHandoff(host, input.from, 'asked', now);
        return true;
      });
      if (ok) {
        await recordFunnel(host, { step: 'handoff', waId: input.from, now, skip: () => turnGone(host, input) });
        await send(host, input, now, [{ kind: 'text', text: copy.menu.handedOff[locale] }]);
      }
      return 'handled';
    }
    if (tap[2] === 'loc') {
      if (hasLocation) await send(host, input, now, locationMessages(host)); else await sendMenu(locale);
      return 'handled';
    }
    const item = tap[3] ? readSettings(host).menu.items.find((i) => i.id === tap[3]) : undefined;
    if (item) await send(host, input, now, [{ kind: 'text', text: item.answer[locale] }]); else await sendMenu(locale);
    return 'handled';
  }

  if (input.type !== 'text' || !input.text || input.reply || input.order) return 'pass';
  const word = normaliseText(input.text);
  const open = (): Promise<'handled'> => sendMenu(localeOfText(host, input)).then(() => 'handled' as const);
  if (menuOn && normIn(copy.menu.menuWords).has(word)) return open();
  if (hasLocation && !awaitingAddress(host, input.from, now) && normIn(copy.menu.locationWords).has(word)) { await send(host, input, now, locationMessages(host)); return 'handled'; }
  // A half-finished order only passes to the ordering bot while ordering is on; otherwise the plain menu path below answers.
  if (!menuOn || (midOrder(host, input.from, now) && orderingActive(host))) return 'pass';
  if (normIn(copy.menu.greetingWords).has(word)) return open();
  // Anything else while idle: the menu answers unless the agent can (it answers free text) or the text is an ordering keyword.
  if (!ctx.agentOn && !(orderingActive(host) && orderingEngaged(host, input, now))) return open();
  return 'pass';
}
