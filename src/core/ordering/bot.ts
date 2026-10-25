/**
 * Ordering in chat: browse the Store's catalog, build a cart (or take one sent from Meta's catalog), pick COD, a payment
 * link or InstaPay, give an address, and place the order through the Store bridge. The Store owns orders, stock, prices
 * and payment state; this only asks.
 *
 * Rules (ported from the old bot's state machine, see docs/store-link.md): an image burst, then the list; pagination
 * is encoded in row ids (no server-side page state); there is no terminal state (any message, and the restart words,
 * always lead somewhere); names follow the customer's locale; 150 ms between sends; inside the 24 h window only.
 * A turn is replayable: sends have deterministic idempotency keys and the session is saved last, so a crash re-runs
 * the turn without sending anything twice.
 */
import { z } from 'zod';
import { buyerKey } from '../buyer-key';
import type { InboundOrder, InboundReply } from '../meta/webhook-schema';
import { isE164 } from '../phone';
import type { SendJob } from '../send-queue';
import type { Address, Buyer, CatalogRow, ChatPaymentMethod, OrderLine, StoreBridge, StoreProfile } from '../store-bridge';
import { bridgeFor, storeLink } from '../store-link';
import type { LinkHost } from '../store-link/host';
import { upsertOrder } from '../store-link/order-store';
import { recordOrderAfterErase } from '../store-link/orders';
import { isLinked, readSettings } from '../store-link/settings';
import { normaliseText } from '../text-normalise';
import type { Locale, OrderingCopy } from './copy';
import { parseMinor } from './money';
import { signProofUrl } from './proof-url';

export const BOT_PAGE = 9;
/** A customer has this long after placing an InstaPay order to send the receipt. */
export const PROOF_WINDOW_MS = 48 * 60 * 60 * 1000;
const MAX_CART_LINES = 20;
const MAX_LINE_QTY = 99;
const SCAN_PAGES = 10;
const MAX_ROW_ID = 190;

// ---- input and session ------------------------------------------------------------------------------------------------

export const botInputSchema = z.object({
  messageId: z.number().int(),
  wamid: z.string(),
  from: z.string().min(1),
  phoneNumberId: z.string().min(1),
  profileName: z.string().nullable(),
  type: z.string(),
  text: z.string().nullable(),
  reply: z.object({ kind: z.enum(['button', 'list']), id: z.string(), title: z.string() }).nullable(),
  order: z.object({ catalogId: z.string().optional(), note: z.string().optional(), items: z.array(z.object({ retailerId: z.string(), quantity: z.number().int(), price: z.string(), currency: z.string() })) }).nullable(),
});
export type BotInput = z.infer<typeof botInputSchema>;

/** The slice of an inbound message the bot needs, as stored on its scheduled task. */
export function botInputFrom(m: { wamid: string; from: string; type: string; text?: string; reply?: InboundReply; order?: InboundOrder; profileName?: string }, messageId: number, phoneNumberId: string): BotInput {
  return { messageId, wamid: m.wamid, from: m.from, phoneNumberId, profileName: m.profileName ?? null, type: m.type, text: m.text ? m.text.slice(0, 1024) : null, reply: m.reply ?? null, order: m.order ?? null };
}

type Line = { variantId: string; title: string; priceMinor: number; currency: string; quantity: number };
type RowInfo = { title: string; priceMinor: number; currency: string; inStock: boolean };
const sessionData = z.object({
  cart: z.array(z.object({ variantId: z.string(), title: z.string(), priceMinor: z.number().int(), currency: z.string(), quantity: z.number().int() })).default([]),
  rows: z.record(z.string(), z.object({ title: z.string(), priceMinor: z.number().int(), currency: z.string(), inStock: z.boolean() })).default({}),
  pageCursor: z.string().nullable().default(null),
  selected: z.string().nullable().default(null),
  payment: z.enum(['cod', 'link', 'instapay']).nullable().default(null),
  orderKey: z.string().nullable().default(null),
  proofOrderId: z.string().nullable().default(null),
  lastMessageId: z.number().int().default(0),
});
type Data = z.infer<typeof sessionData>;
const STATES = ['idle', 'browsing', 'choosing_qty', 'cart', 'choosing_payment', 'choosing_address', 'awaiting_address', 'awaiting_proof'] as const;
type State = (typeof STATES)[number];
type Session = { state: State; locale: Locale; data: Data; fresh: boolean };

// ---- outbound messages -------------------------------------------------------------------------------------------------

export type BotMsg =
  | { kind: 'text'; text: string }
  | { kind: 'image'; link: string; caption: string }
  | { kind: 'buttons'; body: string; buttons: { id: string; title: string }[] }
  | { kind: 'location'; latitude: number; longitude: number; name: string; address: string }
  | { kind: 'list'; body: string; button: string; rows: { id: string; title: string; description?: string }[] };

const cut = (s: string, n: number) => (Array.from(s).length <= n ? s : `${Array.from(s).slice(0, n - 1).join('')}…`);

export function toJob(host: LinkHost, to: string, pn: string, key: string, m: BotMsg): { job: SendJob; type: string; preview: string } {
  const base = { workspaceId: host.workspaceId, phoneNumberId: pn, to, idempotencyKey: key };
  switch (m.kind) {
    case 'text': return { job: { ...base, kind: 'text', text: cut(m.text, 4096) }, type: 'text', preview: m.text };
    case 'image': return { job: { ...base, kind: 'image_link', imageLink: { link: m.link, caption: cut(m.caption, 1024) } }, type: 'image', preview: m.caption };
    case 'location': return { job: { ...base, kind: 'location', location: { latitude: m.latitude, longitude: m.longitude, name: cut(m.name, 100), address: cut(m.address, 300) } }, type: 'location', preview: m.name };
    case 'buttons': return { job: { ...base, kind: 'interactive', interactive: { body: cut(m.body, 1024), buttons: m.buttons.slice(0, 3).map((b) => ({ id: b.id, title: cut(b.title, 20) })) } }, type: 'interactive', preview: m.body };
    case 'list': return { job: { ...base, kind: 'list', list: { body: cut(m.body, 1024), button: cut(m.button, 20), rows: m.rows.slice(0, 10).map((r) => ({ id: r.id, title: cut(r.title, 24), ...(r.description ? { description: cut(r.description, 72) } : {}) })) } }, type: 'interactive', preview: m.body };
  }
}

// ---- aborting a turn ---------------------------------------------------------------------------------------------------

class TurnAborted extends Error {}

/** The customer was erased while this turn was running: the inbound message is gone or its tombstone exists. */
function erasedOrGone(host: LinkHost, input: BotInput): boolean {
  return !host.sql.exec('SELECT 1 FROM messages WHERE id = ?', input.messageId).toArray().length
    || host.sql.exec('SELECT 1 FROM erased_keys WHERE key = ?', `reply:${input.wamid}`).toArray().length > 0;
}

/**
 * The customer said stop AFTER sending the message this turn answers: the pending answer is cancelled. (A customer who opted
 * out EARLIER and writes in again gets a plain service answer: Ruling in the ledger, 4.4 Final.)
 */
function optedOutSince(host: LinkHost, input: BotInput): boolean {
  const r = host.sql.exec<{ opted_out_at: number | null; created_at: number }>(
    'SELECT ct.opted_out_at, m.created_at FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN contacts ct ON ct.id = c.contact_id WHERE m.id = ?', input.messageId,
  ).toArray()[0];
  return !!r && r.opted_out_at !== null && r.opted_out_at >= r.created_at;
}

/** True when the customer was erased or said stop after sending this message: nothing more may be written or sent for it. */
export function turnGone(host: LinkHost, input: BotInput): boolean {
  return erasedOrGone(host, input) || optedOutSince(host, input);
}

/** Called after every await that precedes a write: stops the turn without writing when the customer is gone or opted out. */
function alive(t: Turn): void {
  if (turnGone(t.host, t.input)) throw new TurnAborted();
}

// ---- the turn ----------------------------------------------------------------------------------------------------------

type Turn = {
  host: LinkHost; copy: OrderingCopy; bridge: StoreBridge; ws: string; input: BotInput; now: number;
  session: Session; out: BotMsg[]; profile?: StoreProfile | null; buyer?: Buyer | null;
};

const loc = <T extends Record<Locale, string>>(t: Turn, l: T): string => l[t.session.locale];
const say = (t: Turn, text: string): void => {
  t.out.push({ kind: 'text', text });
};

const queues = new Map<string, Promise<unknown>>();
/** Turns of one customer (the ordering bot's and the AI agent's alike) run one at a time, in arrival order. */
export const serialisedTurn = <T>(host: Pick<LinkHost, 'workspaceId'>, from: string, run: () => Promise<T>): Promise<T> => serialised(`${host.workspaceId}:${from}`, run);
function serialised<T>(key: string, run: () => Promise<T>): Promise<T> {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(run);
  queues.set(key, next);
  void next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => undefined);
  return next;
}

/** The bot answers only while the Store link is on: a Store bound, copy registered, store linked and the switch on. */
export function orderingActive(host: Pick<LinkHost, 'sql' | 'env'>): boolean {
  return bridgeFor(host.env) !== null && storeLink().copy !== null && isLinked(host) && readSettings(host).orderingBot;
}

function loadSession(host: LinkHost, waId: string): Session {
  const row = host.sql.exec<{ state: string; locale: string; data: string }>('SELECT state, locale, data FROM bot_sessions WHERE wa_id = ?', waId).toArray()[0];
  if (row) {
    const data = sessionData.safeParse(JSON.parse(row.data));
    if (data.success && (STATES as readonly string[]).includes(row.state)) return { state: row.state as State, locale: row.locale === 'en' ? 'en' : 'ar', data: data.data, fresh: false };
  }
  return { state: 'idle', locale: 'ar', data: sessionData.parse({}), fresh: true };
}

function saveSession(t: Turn): void {
  t.session.data.lastMessageId = t.input.messageId;
  t.host.sql.exec(
    'INSERT INTO bot_sessions (wa_id, state, locale, data, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(wa_id) DO UPDATE SET state = excluded.state, locale = excluded.locale, data = excluded.data, updated_at = excluded.updated_at',
    t.input.from, t.session.state, t.session.locale, JSON.stringify(t.session.data), t.now,
  );
}

export async function runBotTurn(host: LinkHost, input: BotInput, now: number): Promise<void> {
  await serialisedTurn(host, input.from, () => runBotTurnLocked(host, input, now));
}

/** A session this old is a forgotten browse, not a conversation in progress: the agent may answer instead. */
export const ORDERING_STALE_MS = 30 * 60_000;

/**
 * Does the ordering bot own this message? Yes while the customer is mid-order (a recent session that is not idle), for
 * everything that is not free text (list/button taps, a Meta cart, a payment picture) and for its keywords.
 */
export function orderingEngaged(host: Pick<LinkHost, 'sql'>, input: BotInput, now: number): boolean {
  if (input.type !== 'text' || input.reply || input.order) return true;
  const row = host.sql.exec<{ state: string; updated_at: number }>('SELECT state, updated_at FROM bot_sessions WHERE wa_id = ?', input.from).toArray()[0];
  if (row && row.state !== 'idle' && now - row.updated_at < ORDERING_STALE_MS) return true;
  const copy = storeLink().copy;
  const word = input.text ? normaliseText(input.text) : '';
  if (!copy || !word) return false;
  return normIn(copy.restartWords).has(word) || normIn(copy.ordersWords).has(word) || (['ar', 'en'] as const).some((l) => normIn(copy.languageWords[l]).has(word));
}

/** The ordering turn itself; the caller holds the customer's turn lock (`serialisedTurn`). `restart` opens the catalog regardless of the message (the AI agent hands over with it). */
export async function runBotTurnLocked(host: LinkHost, input: BotInput, now: number, opts: { restart?: boolean } = {}): Promise<void> {
  const copy = storeLink().copy;
  const bridge = bridgeFor(host.env);
  if (!copy || !bridge || !orderingActive(host)) return;
  const session = loadSession(host, input.from);
  if (session.data.lastMessageId >= input.messageId) return; // already applied (a replayed task)
  const t: Turn = { host, copy, bridge, ws: host.workspaceId, input, now, session, out: [] };
  try {
    alive(t);
    if (session.fresh) {
      const p = await profile(t);
      if (p) session.locale = p.locale;
    }
    await (opts.restart ? restart(t) : dispatch(t));
    alive(t);
    await flush(t);
    alive(t);
    saveSession(t);
  } catch (err) {
    if (!(err instanceof TurnAborted)) throw err;
    // erased or opted out meanwhile: nothing is written, nothing more is sent
  }
}

async function profile(t: Turn): Promise<StoreProfile | null> {
  if (t.profile !== undefined) return t.profile;
  const r = await t.bridge.getStoreProfile(t.ws);
  t.profile = r.ok ? r.value : null;
  return t.profile;
}

async function buyerOf(t: Turn): Promise<Buyer | null> {
  if (t.buyer !== undefined) return t.buyer;
  const secret = storeLink().buyerSecret(t.host.env);
  const e164 = `+${t.input.from}`;
  if (!secret || !isE164(e164)) {
    console.error(JSON.stringify({ alert: 'bot_buyer_key_unavailable', workspace: t.ws, why: secret ? 'bad_number' : 'no_secret' }));
    t.buyer = null;
    return null;
  }
  t.buyer = { buyerKey: await buyerKey(secret, e164), phoneE164: e164, name: t.input.profileName ? cut(t.input.profileName, 60) : null, locale: t.session.locale };
  return t.buyer;
}

/** Stores and sends the turn's messages in order. A replayed turn skips what exists and re-delivers what never left. */
async function flush(t: Turn): Promise<void> {
  const { host } = t;
  for (let i = 0; i < t.out.length; i++) {
    const key = `bot:${t.input.messageId}:${i}`;
    const built = toJob(host, t.input.from, t.input.phoneNumberId, key, t.out[i]!);
    host.storage.transactionSync(() => {
      alive(t); // never re-create a contact that was erased since the last send
      if (host.sql.exec('SELECT 1 FROM messages WHERE idempotency_key = ?', key).toArray().length) return;
      const { conversationId } = host.ensureConversation(t.input.from, t.now);
      host.insertOutbound(conversationId, { type: built.type, preview: built.preview, body: built.preview, key, author: 'bot' }, t.now);
    });
    await host.deliver(built.job);
    if (i < t.out.length - 1 && host.sendGapMs > 0) await new Promise((r) => setTimeout(r, host.sendGapMs));
  }
}

// ---- routing -----------------------------------------------------------------------------------------------------------

const normIn = (words: readonly string[]) => new Set(words.map(normaliseText));

async function dispatch(t: Turn): Promise<void> {
  const { input: i, copy } = t;
  const word = i.type === 'text' && i.text ? normaliseText(i.text) : '';
  if (word) {
    if (normIn(copy.restartWords).has(word)) return restart(t);
    if (normIn(copy.ordersWords).has(word)) return showOrders(t);
    for (const l of ['ar', 'en'] as const) if (normIn(copy.languageWords[l]).has(word)) { t.session.locale = l; return restart(t); }
  }
  if (i.order) return receiveCart(t);
  if (i.type === 'image') return receiveImage(t);
  const id = i.reply?.id;
  if (id) {
    if (id.startsWith('v:')) return pick(t, id.slice(2));
    if (id.startsWith('more:')) return browse(t, id.slice(5), false);
    if (id.startsWith('q:') && t.session.state === 'choosing_qty') return quantity(t, Number(id.slice(2)));
    if (id === 'cart:checkout') return checkout(t);
    if (id === 'cart:more') return browse(t, null, false);
    if (id === 'cart:clear') { t.session.data.cart = []; t.session.data.orderKey = null; return browse(t, null, true); }
    if (id.startsWith('pay:') && t.session.state === 'choosing_payment') return choosePayment(t, id.slice(4));
    if (id.startsWith('addr:') && t.session.state === 'choosing_address') return chooseAddress(t, id.slice(5));
  }
  switch (t.session.state) {
    case 'choosing_qty': {
      const n = i.type === 'text' && i.text ? parseQty(i.text) : null;
      if (n) return quantity(t, n);
      break;
    }
    case 'awaiting_address':
      if (i.type === 'text' && i.text && i.text.trim().length >= 3) return placeWithText(t, i.text.trim());
      break;
    case 'idle':
    case 'browsing':
      return browse(t, null, t.session.state === 'idle');
    default:
  }
  say(t, loc(t, t.copy.t.useButtons));
  return reprompt(t);
}

/** The customer typed a number: accepted as a quantity. Arabic digits are normalised first. */
function parseQty(text: string): number | null {
  const n = Number(normaliseText(text));
  return Number.isInteger(n) && n >= 1 && n <= MAX_LINE_QTY ? n : null;
}

async function reprompt(t: Turn): Promise<void> {
  switch (t.session.state) {
    case 'choosing_qty': return askQuantity(t);
    case 'cart': return cartSummary(t);
    case 'choosing_payment': return askPayment(t);
    case 'choosing_address': return askAddress(t);
    case 'awaiting_address': return say(t, loc(t, t.copy.t.askAddress));
    case 'awaiting_proof': return say(t, loc(t, t.copy.t.awaitingReceipt));
    default: return browse(t, null, false);
  }
}

async function restart(t: Turn): Promise<void> {
  t.session.data.cart = [];
  t.session.data.selected = null;
  t.session.data.payment = null;
  t.session.data.orderKey = null;
  return browse(t, null, true);
}

// ---- browsing ----------------------------------------------------------------------------------------------------------

const nameOf = (t: Turn, r: Pick<CatalogRow, 'title' | 'titleAr'>) => (t.session.locale === 'ar' && r.titleAr ? r.titleAr : r.title);
const money = (t: Turn, minor: number, currency: string) => t.copy.money(minor, currency, t.session.locale);

async function unavailable(t: Turn): Promise<void> {
  say(t, loc(t, t.copy.t.storeUnavailable));
}

/** An image per product, then the list. Row ids carry what the next tap needs (`v:<variant>`, `more:<cursor>`). */
async function browse(t: Turn, cursor: string | null, greet: boolean): Promise<void> {
  const res = await t.bridge.listCatalog(t.ws, cursor, BOT_PAGE);
  if (!res.ok) return unavailable(t);
  if (greet) {
    const p = await profile(t);
    t.out.push({ kind: 'text', text: t.copy.t.greeting(p?.name ?? '', t.session.locale) });
  }
  const items = res.value.items;
  if (!items.length) {
    say(t, loc(t, t.copy.t.emptyCatalog));
    t.session.state = 'idle';
    return;
  }
  const rows: Record<string, RowInfo> = {};
  for (const r of items) {
    const name = nameOf(t, r);
    rows[r.retailerId] = { title: name, priceMinor: r.priceMinor, currency: r.currency, inStock: r.availability === 'in_stock' };
    if (r.imageUrl && /^https:\/\/\S+$/.test(r.imageUrl)) t.out.push({ kind: 'image', link: r.imageUrl, caption: `${name}\n${money(t, r.priceMinor, r.currency)}` });
  }
  const listRows = items.map((r) => ({
    id: `v:${r.retailerId}`,
    title: nameOf(t, r),
    description: `${money(t, r.priceMinor, r.currency)}${r.availability === 'in_stock' ? '' : ` · ${loc(t, t.copy.t.outOfStockTag)}`}`,
  })).filter((r) => r.id.length <= MAX_ROW_ID);
  const next = res.value.nextCursor;
  if (next && `more:${next}`.length <= MAX_ROW_ID) listRows.push({ id: `more:${next}`, title: loc(t, t.copy.t.moreRow), description: '' });
  t.out.push({ kind: 'list', body: loc(t, t.copy.t.browseBody), button: loc(t, t.copy.t.browseButton), rows: listRows.map((r) => (r.description ? r : { id: r.id, title: r.title })) });
  t.session.data.rows = rows;
  t.session.data.pageCursor = cursor;
  t.session.state = 'browsing';
}

/** The row for a variant: from the page the customer is looking at, else found by walking the catalog (an older list). */
async function rowFor(t: Turn, variantId: string): Promise<RowInfo | null> {
  const known = t.session.data.rows[variantId] ?? t.session.data.cart.find((l) => l.variantId === variantId);
  if (known) return 'inStock' in known ? known : { title: known.title, priceMinor: known.priceMinor, currency: known.currency, inStock: true };
  let cursor: string | null = null;
  for (let p = 0; p < SCAN_PAGES; p++) {
    const res = await t.bridge.listCatalog(t.ws, cursor, 100);
    if (!res.ok) return null;
    const hit = res.value.items.find((r) => r.retailerId === variantId);
    if (hit) return { title: nameOf(t, hit), priceMinor: hit.priceMinor, currency: hit.currency, inStock: hit.availability === 'in_stock' };
    cursor = res.value.nextCursor;
    if (!cursor) break;
  }
  return null;
}

async function pick(t: Turn, variantId: string): Promise<void> {
  const row = await rowFor(t, variantId);
  if (!row) {
    say(t, loc(t, t.copy.t.useButtons));
    return browse(t, null, false);
  }
  if (!row.inStock) {
    t.out.push({ kind: 'text', text: t.copy.t.outOfStock([row.title], t.session.locale) });
    return browse(t, t.session.data.pageCursor, false);
  }
  t.session.data.rows[variantId] = row;
  t.session.data.selected = variantId;
  t.session.state = 'choosing_qty';
  return askQuantity(t);
}

function askQuantity(t: Turn): void {
  const id = t.session.data.selected;
  const row = id ? t.session.data.rows[id] : undefined;
  if (!id || !row) {
    t.session.state = 'idle';
    return;
  }
  t.out.push({ kind: 'buttons', body: t.copy.t.askQuantity(row.title, t.session.locale), buttons: [1, 2, 3].map((n) => ({ id: `q:${n}`, title: String(n) })) });
}

async function quantity(t: Turn, n: number): Promise<void> {
  const id = t.session.data.selected;
  const row = id ? t.session.data.rows[id] : undefined;
  if (!id || !row || !Number.isInteger(n) || n < 1 || n > MAX_LINE_QTY) return browse(t, null, false);
  const cart = t.session.data.cart;
  const have = cart.find((l) => l.variantId === id);
  if (have) have.quantity = Math.min(MAX_LINE_QTY, have.quantity + n);
  else if (cart.length < MAX_CART_LINES) cart.push({ variantId: id, title: row.title, priceMinor: row.priceMinor, currency: row.currency, quantity: n });
  t.session.data.selected = null;
  t.session.data.orderKey = null; // a changed cart is a new order attempt
  return cartSummary(t);
}

// ---- cart --------------------------------------------------------------------------------------------------------------

const subtotal = (cart: Line[]) => cart.reduce((n, l) => n + l.priceMinor * l.quantity, 0);

function cartSummary(t: Turn): void {
  const cart = t.session.data.cart;
  if (!cart.length) {
    say(t, loc(t, t.copy.t.cartEmpty));
    t.session.state = 'idle';
    return;
  }
  t.out.push({
    kind: 'buttons',
    body: t.copy.t.cartSummary(cart.map((l) => ({ title: l.title, quantity: l.quantity })), money(t, subtotal(cart), cart[0]!.currency), t.session.locale),
    buttons: [{ id: 'cart:checkout', title: loc(t, t.copy.t.cartButtons.checkout) }, { id: 'cart:more', title: loc(t, t.copy.t.cartButtons.addMore) }, { id: 'cart:clear', title: loc(t, t.copy.t.cartButtons.clear) }],
  });
  t.session.state = 'cart';
}

/** A cart sent from Meta's catalog replaces ours. Prices are Meta's, shown as an estimate: the Store re-prices the order. */
async function receiveCart(t: Turn): Promise<void> {
  const order = t.input.order!;
  const cart: Line[] = [];
  for (const it of order.items.slice(0, MAX_CART_LINES)) {
    const price = parseMinor(it.price);
    if (price === null || !it.retailerId) continue;
    const known = t.session.data.rows[it.retailerId] ?? t.session.data.cart.find((l) => l.variantId === it.retailerId);
    cart.push({ variantId: it.retailerId, title: known?.title ?? it.retailerId, priceMinor: price, currency: it.currency || 'EGP', quantity: Math.max(1, Math.min(MAX_LINE_QTY, it.quantity)) });
  }
  t.session.data.cart = cart;
  t.session.data.orderKey = null;
  return cartSummary(t);
}

// ---- checkout ----------------------------------------------------------------------------------------------------------

async function checkout(t: Turn): Promise<void> {
  if (!t.session.data.cart.length) return cartSummary(t);
  const p = await profile(t);
  if (!p) return unavailable(t);
  const methods = p.paymentMethods;
  if (!methods.length) {
    say(t, loc(t, t.copy.t.orderFailed));
    return;
  }
  t.session.data.orderKey ??= crypto.randomUUID();
  if (methods.length === 1) {
    t.session.data.payment = methods[0]!;
    return askAddress(t);
  }
  t.session.state = 'choosing_payment';
  return askPayment(t);
}

async function askPayment(t: Turn): Promise<void> {
  const p = await profile(t);
  const methods = p?.paymentMethods ?? [];
  t.out.push({ kind: 'buttons', body: loc(t, t.copy.t.choosePayment), buttons: methods.slice(0, 3).map((m) => ({ id: `pay:${m}`, title: loc(t, t.copy.t.paymentTitles[m]) })) });
}

async function choosePayment(t: Turn, id: string): Promise<void> {
  const p = await profile(t);
  const m = id as ChatPaymentMethod;
  if (!p || !p.paymentMethods.includes(m)) return askPayment(t);
  t.session.data.payment = m;
  return askAddress(t);
}

async function askAddress(t: Turn): Promise<void> {
  const buyer = await buyerOf(t);
  if (!buyer) return unavailable(t);
  const res = await t.bridge.getCustomerAddresses(t.ws, buyer.buyerKey);
  const saved: Address[] = res.ok ? res.value.items.slice(0, 9) : [];
  if (!saved.length) {
    say(t, loc(t, t.copy.t.askAddress));
    t.session.state = 'awaiting_address';
    return;
  }
  const rows = saved.map((a) => ({ id: `addr:${a.id}`, title: a.label ?? `${a.area}`, description: `${a.street}, ${a.area}` }));
  rows.push({ id: 'addr:new', title: loc(t, t.copy.t.newAddressRow), description: '' });
  t.out.push({ kind: 'list', body: loc(t, t.copy.t.chooseAddress), button: loc(t, t.copy.t.addressesButton), rows: rows.map((r) => (r.description ? r : { id: r.id, title: r.title })) });
  t.session.state = 'choosing_address';
}

async function chooseAddress(t: Turn, id: string): Promise<void> {
  if (id === 'new') {
    say(t, loc(t, t.copy.t.askAddress));
    t.session.state = 'awaiting_address';
    return;
  }
  return placeOrder(t, { addressId: id });
}

async function placeWithText(t: Turn, text: string): Promise<void> {
  const parts = text.split(/[,،]/).map((s) => s.trim()).filter(Boolean);
  const area = cut(parts[0] ?? text, 120);
  const street = cut(parts.slice(1).join(', ') || area, 240);
  const buyer = await buyerOf(t);
  if (buyer) {
    alive(t);
    const saved = await t.bridge.saveCustomerAddress(t.ws, buyer.buyerKey, { area, street });
    if (saved.ok) return placeOrder(t, { addressId: saved.value.address.id });
  }
  return placeOrder(t, { address: { area, street } });
}

async function placeOrder(t: Turn, where: { addressId: string } | { address: { area: string; street: string } }): Promise<void> {
  const d = t.session.data;
  const method = d.payment;
  const buyer = await buyerOf(t);
  if (!method || !buyer || !d.cart.length) return cartSummary(t);
  const items: OrderLine[] = d.cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity }));
  // One key per order attempt: a retry after a timeout reaches the same order instead of creating a second one.
  d.orderKey ??= crypto.randomUUID();
  alive(t); // never ask the Store to create an order for a customer who was erased or has just said stop
  const res = await t.bridge.createOrderFromChat(t.ws, { items, buyer, ...where, paymentMethod: method, idempotencyKey: `bot:${t.ws}:${d.orderKey}` });
  if (!res.ok) {
    if ((res.reason === 'out_of_stock' || res.reason === 'not_found') && res.outOfStock?.length) {
      const gone = new Set(res.outOfStock);
      const names = d.cart.filter((l) => gone.has(l.variantId)).map((l) => l.title);
      d.cart = d.cart.filter((l) => !gone.has(l.variantId));
      d.orderKey = null;
      t.out.push({ kind: 'text', text: t.copy.t.outOfStock(names.length ? names : [...gone], t.session.locale) });
      return cartSummary(t);
    }
    if (res.reason === 'payment_method_disabled') {
      t.session.state = 'choosing_payment';
      return askPayment(t);
    }
    say(t, loc(t, res.reason === 'unavailable' || res.reason === 'not_linked' ? t.copy.t.storeUnavailable : t.copy.t.orderFailed));
    return;
  }
  const o = res.value;
  if (erasedOrGone(t.host, t.input)) {
    // The Store created an order for a customer erased while the call was in flight: keep only the order id and the hashed key
    // so the Store can be told to erase or cancel it, and never drop it silently.
    t.host.storage.transactionSync(() => recordOrderAfterErase(t.host, { orderId: o.orderId, buyerKey: buyer.buyerKey }, t.now));
    await t.host.arm();
    throw new TurnAborted();
  }
  const total = o.totalMinor ?? subtotal(d.cart);
  const currency = o.currency ?? d.cart[0]!.currency;
  upsertOrder(t.host, { orderId: o.orderId, orderNumber: o.orderNumber, waId: t.input.from, buyerKey: buyer.buyerKey, paymentMethod: method, status: 'created', totalMinor: total, currency, locale: t.session.locale }, t.now);
  const L = t.session.locale;
  d.cart = [];
  d.selected = null;
  d.orderKey = null;
  d.payment = null;
  t.session.state = 'idle'; // never terminal: the next message starts a new order
  if (method === 'cod') {
    t.out.push({ kind: 'text', text: t.copy.t.codPlaced(o.orderNumber, money(t, total, currency), L) });
  } else if (method === 'link') {
    const url = await paymentUrl(t, o);
    t.out.push({ kind: 'text', text: url ? t.copy.t.linkPlaced(o.orderNumber, url, L) : loc(t, t.copy.t.storeUnavailable) });
  } else if (o.instapay) {
    t.host.sql.exec('UPDATE store_orders SET proof_deadline_at = ? WHERE order_id = ?', t.now + PROOF_WINDOW_MS, o.orderId);
    t.out.push({ kind: 'text', text: t.copy.t.instapayPlaced(o.orderNumber, o.instapay.ipa, money(t, o.instapay.amountMinor, currency), o.instapay.reference, L) });
    t.session.state = 'awaiting_proof';
    d.proofOrderId = o.orderId;
  } else {
    say(t, loc(t, t.copy.t.orderFailed));
  }
}

/** The payment page for a "pay online" order: the order's own link, else the Store's, else a checkout link for the same cart. */
async function paymentUrl(t: Turn, o: { orderId: string; paymentUrl: string | null }): Promise<string | null> {
  if (o.paymentUrl) return o.paymentUrl;
  const link = await t.bridge.getPaymentLink(t.ws, o.orderId);
  if (link.ok) return link.value.url;
  const buyer = await buyerOf(t);
  if (!buyer) return null;
  const checkout = await t.bridge.createCheckoutLink(t.ws, { items: t.session.data.cart.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), buyer });
  return checkout.ok ? checkout.value.checkoutUrl : null;
}

// ---- payment receipt ---------------------------------------------------------------------------------------------------

/**
 * A picture while an InstaPay order waits for its transfer: forwarded to the Store once (the order stays
 * pending_payment until the Store itself confirms the money). Pictures at any other time are ignored.
 */
async function receiveImage(t: Turn): Promise<void> {
  const { host, input: i } = t;
  const order = host.sql.exec<{ order_id: string; order_number: string | null; status: string | null; proof_wamid: string | null; proof_deadline_at: number | null }>(
    "SELECT order_id, order_number, status, proof_wamid, proof_deadline_at FROM store_orders WHERE wa_id = ? AND payment_method = 'instapay' ORDER BY updated_at DESC LIMIT 1", i.from,
  ).toArray()[0];
  if (!order || ['cancelled', 'refunded', 'returned'].includes(order.status ?? '')) return;
  if (order.proof_wamid || order.status === 'paid' || order.status === 'delivered') {
    say(t, loc(t, t.copy.t.proofAlready));
    return;
  }
  if (order.proof_deadline_at !== null && order.proof_deadline_at < t.now) {
    say(t, loc(t, t.copy.t.proofExpired));
    return;
  }
  const media = host.sql.exec<{ media_r2_key: string | null; media_mime: string | null }>('SELECT media_r2_key, media_mime FROM messages WHERE id = ?', i.messageId).toArray()[0];
  if (!media?.media_r2_key) throw new Error('payment screenshot is not stored yet'); // the media download task is still running: retry
  if (!media.media_mime?.startsWith('image/')) {
    say(t, loc(t, t.copy.t.awaitingReceipt));
    return;
  }
  alive(t);
  const claimed = host.sql.exec('UPDATE store_orders SET proof_wamid = ?, proof_at = ? WHERE order_id = ? AND proof_wamid IS NULL', i.wamid, t.now, order.order_id).rowsWritten > 0;
  if (!claimed) {
    say(t, loc(t, t.copy.t.proofAlready));
    return;
  }
  const release = () => host.sql.exec('UPDATE store_orders SET proof_wamid = NULL, proof_at = NULL WHERE order_id = ? AND proof_wamid = ?', order.order_id, i.wamid);
  const proof = storeLink().proof(host.env);
  if (!proof) {
    release();
    console.error(JSON.stringify({ alert: 'proof_url_not_configured', workspace: t.ws }));
    throw new Error('payment screenshot links are not configured');
  }
  const url = await signProofUrl({ baseUrl: proof.baseUrl, secret: proof.secret, workspaceId: t.ws, messageId: i.messageId, now: t.now });
  try {
    alive(t);
  } catch (e) {
    release();
    throw e;
  }
  const res = await t.bridge.attachPaymentProof(t.ws, order.order_id, url);
  if (!res.ok) {
    release();
    if (res.reason === 'unavailable') throw new Error('store unavailable');
    say(t, loc(t, t.copy.t.orderFailed));
    return;
  }
  say(t, loc(t, t.copy.t.proofReceived));
  t.session.state = 'idle';
  t.session.data.proofOrderId = null;
}

// ---- "my orders" -------------------------------------------------------------------------------------------------------

async function showOrders(t: Turn): Promise<void> {
  const buyer = await buyerOf(t);
  if (!buyer) return unavailable(t);
  const res = await t.bridge.listCustomerOrders(t.ws, buyer.buyerKey, 5);
  if (!res.ok) return unavailable(t);
  if (!res.value.items.length) return say(t, loc(t, t.copy.t.noOrders));
  const lines = res.value.items.map((o) => t.copy.t.orderLine(o.orderNumber, t.copy.t.orderStatusNames[o.status]?.[t.session.locale] ?? o.status, t.session.locale));
  say(t, `${loc(t, t.copy.t.ordersHeader)}\n${lines.join('\n')}`);
}
