import { getCommerceSettings, isPermissionFailure, setCommerceSettings, type CatalogApiResult } from '../meta/catalog-api';
import { graphTokenFor } from '../numbers/token';
import { alert } from '../observability';
import type { LinkHost } from './host';
import { getState, putState } from './settings';

/**
 * The shop button and the cart on the business number (`whatsapp_commerce_settings`). Meta's default hides the catalogue button, so a connected
 * catalogue shows nothing in the profile until this is set (Ruling WA-CAT-3): it is switched on automatically, and the merchant may turn it off.
 */
export type CommerceState = { catalogVisible: boolean; cartEnabled: boolean; at: number; failed: 'missing_permission' | 'meta_error' | null };
const STATE_KEY = 'catalog.commerce';
const WANT_KEY = 'catalog.commerce_want';
/** Re-read at most this often by the nightly pass: someone may have changed it in the WhatsApp Business app. */
export const COMMERCE_RECHECK_MS = 24 * 3_600_000;

type Want = { catalogVisible: boolean; cartEnabled: boolean };
const DEFAULT_WANT: Want = { catalogVisible: true, cartEnabled: true };

export function readWant(host: Pick<LinkHost, 'sql'>): Want {
  try {
    const v = JSON.parse(getState(host, WANT_KEY) ?? 'null') as Partial<Want> | null;
    return v && typeof v.catalogVisible === 'boolean' && typeof v.cartEnabled === 'boolean' ? { catalogVisible: v.catalogVisible, cartEnabled: v.cartEnabled } : DEFAULT_WANT;
  } catch {
    return DEFAULT_WANT;
  }
}

export function readCommerce(host: Pick<LinkHost, 'sql'>): CommerceState | null {
  try {
    const v = JSON.parse(getState(host, STATE_KEY) ?? 'null') as CommerceState | null;
    return v && typeof v.at === 'number' ? v : null;
  } catch {
    return null;
  }
}

const record = (host: LinkHost, s: CommerceState): CommerceState => {
  putState(host, STATE_KEY, JSON.stringify(s));
  return s;
};

/** The workspace's active numbers on the WABA the catalogue was verified against. */
async function numbersOf(host: LinkHost, wabaId: string): Promise<string[]> {
  const r = await host.env.DB.prepare("SELECT phone_number_id FROM phone_numbers WHERE workspace_id = ? AND waba_id = ? AND status = 'active'").bind(host.workspaceId, wabaId).all<{ phone_number_id: string }>();
  return r.results.map((x) => x.phone_number_id);
}

function failed(host: LinkHost, r: Extract<CatalogApiResult<unknown>, { ok: false }>, want: Want): CommerceState {
  const perm = isPermissionFailure(r);
  if (perm) alert('catalog_permission_missing', { workspace: host.workspaceId, code: r.code ?? null, step: 'commerce_settings' });
  return record(host, { ...want, at: Date.now(), failed: perm ? 'missing_permission' : 'meta_error' });
}

/**
 * Brings every active number of the catalogue's WABA to the wanted state (read first, write only on a difference).
 * `fresh` writes without the freshness check (a merchant's own change). Never throws: the outcome is the stored state.
 */
export async function ensureCommerce(host: LinkHost, auth: { token: string; graphVersion: string }, opts: { fresh?: boolean; want?: Want } = {}): Promise<CommerceState | null> {
  const wabaId = getState(host, 'catalog.waba');
  if (!wabaId) return null;
  if (opts.want) putState(host, WANT_KEY, JSON.stringify(opts.want));
  const want = opts.want ?? readWant(host);
  const have = readCommerce(host);
  if (!opts.fresh && have && !have.failed && have.catalogVisible === want.catalogVisible && have.cartEnabled === want.cartEnabled && Date.now() - have.at < COMMERCE_RECHECK_MS) return have;
  const numbers = await numbersOf(host, wabaId);
  if (!numbers.length) return null;
  const edge = { token: auth.token, graphVersion: auth.graphVersion };
  for (const phoneNumberId of numbers) {
    const now = await getCommerceSettings({ ...edge, phoneNumberId });
    if (!now.ok) return failed(host, now, want);
    if (now.value.catalogVisible === want.catalogVisible && now.value.cartEnabled === want.cartEnabled) continue;
    const set = await setCommerceSettings({ ...edge, phoneNumberId, ...want });
    if (!set.ok) return failed(host, set, want);
  }
  return record(host, { ...want, at: Date.now(), failed: null });
}

/** A token for the verified WABA, for the merchant's own change. Null = no catalogue verified yet. */
export async function commerceAuth(host: LinkHost): Promise<{ token: string; graphVersion: string } | null> {
  const wabaId = getState(host, 'catalog.waba');
  if (!wabaId) return null;
  return { token: await graphTokenFor(host.env, { wabaId }), graphVersion: host.env.META_GRAPH_VERSION };
}
