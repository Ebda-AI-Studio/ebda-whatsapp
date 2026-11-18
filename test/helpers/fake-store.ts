import { mintedKey, mintedRoles } from './issuer';
import type {
  Address, BridgeFailure, CustomerProfile, SearchOptions, StorePolicies, MemberRole, StoreMember, BridgeOrderSummary, BridgeResult, Buyer, CatalogRow, ChatPaymentMethod, CodOutcome, NewAddress, OrderCreated, OrderLine, RecommendationRequest, StoreBridge, StoreProfile,
} from '../../src/core/store-bridge';

type Order = {
  orderId: string; orderNumber: string; buyerKey: string; status: BridgeOrderSummary['status']; paymentMethod: ChatPaymentMethod;
  lines: OrderLine[]; totalMinor: number; currency: string; at: number; proofs: string[]; codOutcome: CodOutcome | null; instapayReference: string | null;
};

export const FAKE_STORE_ID = '11111111-1111-4111-8111-111111111111';

const row = (variant: string, product: string, title: string, priceMinor: number, availability: CatalogRow['availability'] = 'in_stock'): CatalogRow => ({
  retailerId: variant, productId: product, title, titleAr: `${title} (ع)`, description: `${title} description`, priceMinor, currency: 'EGP', availability,
  imageUrl: `https://img.example/${variant}.jpg`, link: `https://shop.example/p/${product}`, brand: 'Brand',
});

export type FakeStoreOptions = { linked?: boolean; paymentMethods?: ChatPaymentMethod[]; catalog?: CatalogRow[]; stock?: Record<string, number> };

/**
 * An in-memory Store that obeys the contract: every call is keyed by store id and refused for an unlinked store,
 * stock is checked and reserved at order time, createOrderFromChat is idempotent on its key, an InstaPay order stays
 * `pending_payment`, and a COD outcome is applied once. `calls` records every method call (arguments included).
 */
export class FakeStore implements StoreBridge {
  readonly calls: { method: string; args: unknown[] }[] = [];
  readonly orders = new Map<string, Order>();
  /** Shipments by order number, as the bridge carries them today: a status and a tracking link only (no courier, no estimate). */
  readonly shipments = new Map<string, { status: string; trackingUrl: string | null }>();
  readonly addresses = new Map<string, Address[]>();
  readonly byKey = new Map<string, string>();
  catalog: CatalogRow[];
  stock: Record<string, number>;
  linked: boolean;
  paymentMethods: ChatPaymentMethod[];
  /** Fail the next call of this method with this reason (then clear). */
  failNext = new Map<string, BridgeFailure>();
  /** Delay every call by this many ms, so overlapping runs can interleave like a real service binding. */
  latencyMs = 0;
  /** When set, every call waits (after recording itself in `calls`) until this returns true: lets a test act mid-call without guessing with a sleep. Polled on the fake's own timer. */
  holdUntil: (() => boolean) | undefined;
  private seq = 1000;

  /** `storeId` '*' accepts any store id (tests that use one fake across many workspaces). */
  constructor(readonly storeId: string = FAKE_STORE_ID, opts: FakeStoreOptions = {}) {
    this.linked = opts.linked ?? true;
    this.paymentMethods = opts.paymentMethods ?? ['cod', 'link', 'instapay'];
    this.catalog = opts.catalog ?? Array.from({ length: 23 }, (_, i) => row(`v${i + 1}`, `p${i + 1}`, `Item ${i + 1}`, 10_000 + i * 500));
    this.stock = opts.stock ?? Object.fromEntries(this.catalog.map((c) => [c.retailerId, 50]));
  }

  /** `degraded` on the search answer: the Store skipped the meaning leg (Store ruling CHAT-AGENT-6). */
  searchDegraded = false;
  /** What `searchProducts` answers (the Store's ranked search): default = rows whose title contains a query word, in catalogue order, cheaper than the ceiling. A test may replace it (meaning search, Franco). */
  searchImpl: (query: string, opts: SearchOptions) => CatalogRow[] = (query, opts) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hit = (c: CatalogRow) => {
      const hay = `${c.title} ${c.titleAr ?? ''}`.toLowerCase();
      const tokens = hay.split(/\s+/);
      return words.length > 0 && words.every((w) => tokens.includes(w) || (w.length > 3 && hay.includes(w)));
    };
    return this.catalog.filter(hit).filter((c) => opts.maxPriceMinor === undefined || c.priceMinor <= opts.maxPriceMinor).slice(0, opts.limit);
  };
  /** The merchant's declared policies (a test sets `null` fields or empty shipping to prove the agent does not invent). */
  policies: StorePolicies = {
    name: 'متجر الاختبار', nameAr: 'متجر الاختبار', currency: 'EGP', locale: 'ar', paymentMethods: ['cod', 'link', 'instapay'], instapay: true,
    cod: { available: true, fixedFeeMinor: 2500, percentBps: null },
    shipping: { zones: [{ name: 'Cairo', nameAr: 'القاهرة', areas: ['Maadi'], feeMinor: 6000, freeOverMinor: 100_000, etaDaysMin: 1, etaDaysMax: 2 }], governorates: [{ governorate: 'Giza', governorateAr: 'الجيزة', feeMinor: 7000, feeMaxMinor: 7000, freeOverMinor: null }] },
    returns: { windowDays: 14, feesPaidBy: 'customer' }, hours: 'السبت للخميس 10ص - 10م', location: { address: '9 Road 233, Maadi', addressAr: null, mapsUrl: null },
  };
  /** Customer profiles by E.164 phone (the proof). An absent phone answers `null`, like the Store. */
  readonly profiles = new Map<string, CustomerProfile>();

  /** Store membership by store id: userId -> member. Tests set it with `setMembers`; an unknown store has no members. */
  readonly members = new Map<string, Map<string, StoreMember>>();
  setMembers(storeId: string, list: { userId: string; role: MemberRole; displayName?: string; addedAt?: string }[]) {
    this.members.set(storeId, new Map(list.map((m, i) => [m.userId, { userId: m.userId, role: m.role, displayName: m.displayName ?? `Member ${i + 1}`, addedAt: m.addedAt ?? new Date(1_700_000_000_000 + i * 1000).toISOString() }])));
  }

  /** Membership answers like the Store: the bare value, a thrown FORBIDDEN for a non-owner asker; `failNext` makes the call unavailable. */
  async listStoreMembers(storeId: string, asUserId: string): Promise<BridgeResult<{ items: StoreMember[] }>> {
    this.calls.push({ method: 'listStoreMembers', args: [storeId, asUserId] });
    if (this.failNext.delete('listStoreMembers')) return { ok: false, reason: 'unavailable' };
    const all = this.members.get(storeId);
    if (all?.get(asUserId)?.role !== 'owner') return { ok: false, reason: 'invalid', message: 'FORBIDDEN' };
    return { ok: true, value: { items: [...all.values()] } };
  }
  async memberRole(storeId: string, userId: string): Promise<BridgeResult<{ role: MemberRole | null }>> {
    this.calls.push({ method: 'memberRole', args: [storeId, userId] });
    if (this.failNext.delete('memberRole')) return { ok: false, reason: 'unavailable' };
    const team = this.members.get(storeId);
    if (!team) return { ok: true, value: { role: (() => { const r = mintedRoles.get(mintedKey(storeId, userId)); return r?.has('owner') ? 'owner' as const : r?.has('staff') ? 'staff' as const : null; })() } }; // no team set for this store: the Store knows whoever the test signed in
    return { ok: true, value: { role: team.get(userId)?.role ?? null } };
  }

  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
  lastCall(method: string): unknown[] {
    return this.calls.filter((c) => c.method === method).at(-1)?.args ?? [];
  }

  private async gate<T>(method: string, storeId: string, args: unknown[], run: () => BridgeResult<T>): Promise<BridgeResult<T>> {
    this.calls.push({ method, args });
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    while (this.holdUntil && !this.holdUntil()) await new Promise((r) => setTimeout(r, 5));
    const injected = this.failNext.get(method);
    if (injected) {
      this.failNext.delete(method);
      return { ok: false, reason: injected };
    }
    if ((this.storeId !== '*' && storeId !== this.storeId) || !this.linked) return { ok: false, reason: 'not_linked' };
    return run();
  }

  getStoreProfile(storeId: string) {
    return this.gate<StoreProfile>('getStoreProfile', storeId, [storeId], () => ({
      ok: true,
      value: {
        name: 'متجر الاختبار', logoUrl: null, locale: 'ar', currency: 'EGP', paymentMethods: this.paymentMethods, codEnabled: this.paymentMethods.includes('cod'),
        instapay: this.paymentMethods.includes('instapay') ? { ipa: 'shop@instapay', displayName: 'Test Shop' } : null,
      },
    }));
  }

  listCatalog(storeId: string, cursor: string | null, limit: number) {
    return this.gate('listCatalog', storeId, [storeId, cursor, limit], () => {
      const start = cursor ? Number(cursor) : 0;
      if (!Number.isInteger(start) || start < 0) return { ok: false, reason: 'invalid' };
      const items = this.catalog.slice(start, start + Math.min(limit, 100)).map((c) => ({ ...c, availability: (this.stock[c.retailerId] ?? 0) > 0 ? ('in_stock' as const) : ('out_of_stock' as const) }));
      const next = start + items.length;
      return { ok: true, value: { items, nextCursor: next < this.catalog.length ? String(next) : null } };
    });
  }

  /** Like the real bridge (`catalogByIds`): the ids are RETAILER ids (a variant id, or the product id of a simple product); a product id of a variant product matches nothing. */
  getProducts(storeId: string, productIds: string[]) {
    // The real bridge schema caps an id at 64 characters and refuses the WHOLE call for one longer (schemas.ts getProducts).
    return this.gate('getProducts', storeId, [storeId, productIds], () => productIds.some((id) => id.length > 64) ? { ok: false, reason: 'invalid' } : ({ ok: true, value: { items: this.catalog.filter((c) => productIds.includes(c.retailerId)).map((c) => ({ ...c, availability: (this.stock[c.retailerId] ?? 0) > 0 ? ('in_stock' as const) : ('out_of_stock' as const) })) } }));
  }

  searchProducts(storeId: string, query: string, opts: SearchOptions) {
    return this.gate('searchProducts', storeId, [storeId, query, opts], () => ({ ok: true, value: { items: this.searchImpl(query, opts).map((c) => ({ ...c, availability: (this.stock[c.retailerId] ?? 0) > 0 ? ('in_stock' as const) : ('out_of_stock' as const) })), degraded: this.searchDegraded } }));
  }

  getStorePolicies(storeId: string) {
    return this.gate<StorePolicies>('getStorePolicies', storeId, [storeId], () => ({ ok: true, value: this.policies }));
  }

  getCustomerProfile(storeId: string, phoneE164: string) {
    return this.gate<CustomerProfile | null>('getCustomerProfile', storeId, [storeId, phoneE164], () => ({ ok: true, value: this.profiles.get(phoneE164) ?? null }));
  }

  /** Recommendation seeds -> retailer ids the engine would return (set by a test). `hidden` = inactive / non-public / other-store products the real Store re-read drops. */
  recs: Record<string, string[]> = {};
  hidden = new Set<string>();
  /** Like the Store: re-read live, so out-of-stock, hidden and over-budget rows never come back; an unknown order or a wrong buyer key is `not_found`. */
  getRecommendations(storeId: string, req: RecommendationRequest) {
    return this.gate('getRecommendations', storeId, [storeId, req], () => {
      let seeds = req.seedIds;
      if (req.orderNumber !== undefined) {
        const o = [...this.orders.values()].find((x) => x.orderNumber === req.orderNumber && x.buyerKey === req.buyerKey);
        if (!o) return { ok: false, reason: 'not_found' };
        seeds = o.lines.map((l) => l.variantId);
      }
      const ids = [...new Set(seeds.flatMap((s) => this.recs[s] ?? []))].filter((id) => !seeds.includes(id) && !this.hidden.has(id));
      const items = ids.map((id) => this.catalog.find((c) => c.retailerId === id)).filter((c): c is CatalogRow => !!c && (this.stock[c.retailerId] ?? 0) > 0 && (req.maxPriceMinor === undefined || c.priceMinor <= req.maxPriceMinor));
      return { ok: true, value: { items: items.slice(0, req.limit).map((c) => ({ ...c, availability: 'in_stock' as const })) } };
    });
  }

  createCheckoutLink(storeId: string, req: { items: OrderLine[]; buyer: Buyer }) {
    return this.gate('createCheckoutLink', storeId, [storeId, req], () => {
      const total = this.price(req.items);
      if (total === null) return { ok: false, reason: 'not_found' };
      return { ok: true, value: { checkoutUrl: `https://shop.example/cart/from-wa?t=${req.items.length}`, summary: { itemsCount: req.items.length, totalMinor: total, currency: 'EGP' } } };
    });
  }

  private price(items: OrderLine[]): number | null {
    let total = 0;
    for (const l of items) {
      const c = this.catalog.find((x) => x.retailerId === l.variantId);
      if (!c) return null;
      total += c.priceMinor * l.quantity;
    }
    return total;
  }

  createOrderFromChat(storeId: string, req: { items: OrderLine[]; buyer: Buyer; addressId?: string; address?: NewAddress; paymentMethod: ChatPaymentMethod; idempotencyKey: string }) {
    return this.gate<OrderCreated>('createOrderFromChat', storeId, [storeId, req], () => {
      const seen = this.byKey.get(req.idempotencyKey);
      if (seen) return { ok: true, value: this.created(this.orders.get(seen)!) };
      if (!this.paymentMethods.includes(req.paymentMethod)) return { ok: false, reason: 'payment_method_disabled' };
      const missing = req.items.filter((l) => !this.catalog.some((c) => c.retailerId === l.variantId));
      if (missing.length) return { ok: false, reason: 'not_found', outOfStock: missing.map((m) => m.variantId) };
      const short = req.items.filter((l) => (this.stock[l.variantId] ?? 0) < l.quantity);
      if (short.length) return { ok: false, reason: 'out_of_stock', outOfStock: short.map((l) => l.variantId) };
      for (const l of req.items) this.stock[l.variantId]! -= l.quantity;
      const n = ++this.seq;
      const o: Order = {
        orderId: `ord-${n}`, orderNumber: String(n), buyerKey: req.buyer.buyerKey, paymentMethod: req.paymentMethod, lines: req.items, totalMinor: this.price(req.items)!, currency: 'EGP',
        status: req.paymentMethod === 'cod' ? 'pending_confirmation' : 'pending_payment', at: Date.now(), proofs: [], codOutcome: null,
        instapayReference: req.paymentMethod === 'instapay' ? `IP-${n}` : null,
      };
      this.orders.set(o.orderId, o);
      this.byKey.set(req.idempotencyKey, o.orderId);
      return { ok: true, value: this.created(o) };
    });
  }

  private created(o: Order): OrderCreated {
    return {
      orderId: o.orderId, orderNumber: o.orderNumber, totalMinor: o.totalMinor, currency: o.currency,
      paymentUrl: o.paymentMethod === 'link' ? `https://pay.example/${o.orderId}` : null,
      instapay: o.paymentMethod === 'instapay' ? { ipa: 'shop@instapay', amountMinor: o.totalMinor, reference: o.instapayReference! } : null,
    };
  }

  getPaymentLink(storeId: string, orderId: string) {
    return this.gate('getPaymentLink', storeId, [storeId, orderId], () => (this.orders.has(orderId) ? { ok: true, value: { url: `https://pay.example/${orderId}`, expiresAt: '2099-01-01T00:00:00.000Z' } } : { ok: false, reason: 'not_found' }));
  }

  recordCodOutcome(storeId: string, req: { orderId: string; outcome: CodOutcome; at: string; idempotencyKey: string }) {
    return this.gate('recordCodOutcome', storeId, [storeId, req], () => {
      const o = this.orders.get(req.orderId);
      if (!o) return { ok: false, reason: 'not_found' };
      if (o.codOutcome === null) {
        o.codOutcome = req.outcome;
        if (req.outcome === 'confirmed') o.status = 'confirmed';
        if (req.outcome === 'refused') o.status = 'refused';
      }
      return { ok: true, value: { orderNumber: o.orderNumber } };
    });
  }

  attachPaymentProof(storeId: string, orderId: string, mediaUrl: string) {
    return this.gate<Record<string, never>>('attachPaymentProof', storeId, [storeId, orderId, mediaUrl], () => {
      const o = this.orders.get(orderId);
      if (!o) return { ok: false, reason: 'not_found' };
      o.proofs.push(mediaUrl); // the order stays pending_payment: only the Store flips it
      return { ok: true, value: {} };
    });
  }

  getCustomerAddresses(storeId: string, buyerKey: string) {
    return this.gate('getCustomerAddresses', storeId, [storeId, buyerKey], () => ({ ok: true, value: { items: this.addresses.get(buyerKey) ?? [] } }));
  }

  saveCustomerAddress(storeId: string, buyerKey: string, address: NewAddress) {
    return this.gate('saveCustomerAddress', storeId, [storeId, buyerKey, address], () => {
      const a: Address = { id: `addr-${(this.addresses.get(buyerKey)?.length ?? 0) + 1}`, label: address.label ?? null, area: address.area, street: address.street };
      this.addresses.set(buyerKey, [...(this.addresses.get(buyerKey) ?? []), a]);
      return { ok: true, value: { address: a } };
    });
  }

  getOrderStatus(storeId: string, orderNumber: string, buyerKey: string) {
    return this.gate('getOrderStatus', storeId, [storeId, orderNumber, buyerKey], () => {
      const o = [...this.orders.values()].find((x) => x.orderNumber === orderNumber && x.buyerKey === buyerKey);
      return o ? { ok: true, value: { orderNumber, status: o.status, paymentMethod: o.paymentMethod, shipment: this.shipments.get(orderNumber) ?? null } } : { ok: false, reason: 'not_found' };
    });
  }

  listCustomerOrders(storeId: string, buyerKey: string, limit: number) {
    return this.gate('listCustomerOrders', storeId, [storeId, buyerKey, limit], () => ({
      ok: true,
      value: {
        items: [...this.orders.values()].filter((o) => o.buyerKey === buyerKey).sort((a, b) => b.at - a.at).slice(0, limit).map((o) => ({
          orderId: o.orderId, orderNumber: o.orderNumber, status: o.status, totalMinor: o.totalMinor, currency: o.currency, paymentMethod: o.paymentMethod, itemsCount: o.lines.length, at: o.at,
        })),
      },
    }));
  }

  /** Test helper: the Store records the InstaPay transfer (what a manual check or a gateway would do). */
  markPaid(orderId: string): void {
    this.orders.get(orderId)!.status = 'confirmed';
  }
}
