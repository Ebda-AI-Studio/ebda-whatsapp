import { graphStub } from './api';
import type { CatalogRow } from '../../src/core/store-bridge';
import type { GraphCall, GraphReply } from './graph';

export const CAT = '1234567890';
export const row = (retailerId: string, productId: string, over: Partial<CatalogRow> = {}): CatalogRow => ({
  retailerId, productId, title: `Item ${retailerId}`, titleAr: `منتج ${retailerId}`, description: 'd', priceMinor: 10_000, currency: 'EGP', availability: 'in_stock',
  imageUrl: `https://img.example/${retailerId}.jpg`, link: `https://shop.example/p/${productId}`, brand: null, ...over,
});

export type Meta = { commerce: { visible: boolean; cart: boolean }; batchStatus: (handle: string) => unknown };
/** What Meta says in a catalogue test; reset it per test with `freshMeta()`. */
export const meta: Meta = { commerce: { visible: false, cart: true }, batchStatus: () => ({}) };
export const freshMeta = () => {
  meta.commerce = { visible: false, cart: true };
  meta.batchStatus = () => ({ data: [{ status: 'finished', errors_total_count: 0, ids_of_invalid_requests: [] }] });
};
export const path = (c: GraphCall) => new URL(c.url).pathname.replace(/^\/v[\d.]+\//, '');

/** Graph as Meta answers it for the catalogue edges and sends. `metaIds` is what Meta already holds in the catalogue. */
export function graph(metaIds: string[] = [], over?: (c: GraphCall) => GraphReply | undefined, before?: (c: GraphCall) => Promise<void> | void) {
  let n = 0;
  return graphStub((c) => {
    const o = over?.(c);
    if (o) return o;
    const p = path(c);
    if (/^waba-[^/]+\/product_catalogs$/.test(p)) return { status: 200, json: { data: [{ id: CAT }] } };
    if (p === `${CAT}/items_batch`) return { status: 200, json: { handles: [`h${++n}`] } };
    if (p === `${CAT}/check_batch_request_status`) return { status: 200, json: meta.batchStatus(new URL(c.url).searchParams.get('handle')!) };
    if (p === `${CAT}/products`) return { status: 200, json: { data: metaIds.map((retailer_id) => ({ retailer_id })) } };
    if (/\/whatsapp_commerce_settings$/.test(p)) {
      if (c.method === 'POST') {
        const q = new URL(c.url).searchParams;
        meta.commerce = { visible: q.get('is_catalog_visible') === 'true', cart: q.get('is_cart_enabled') === 'true' };
        return { status: 200, json: { success: true } };
      }
      return { status: 200, json: { data: [{ is_cart_enabled: meta.commerce.cart, is_catalog_visible: meta.commerce.visible, id: 'x' }] } };
    }
    return { status: 200, json: { messages: [{ id: `wamid.out${++n}` }] } };
  }, undefined, before);
}
