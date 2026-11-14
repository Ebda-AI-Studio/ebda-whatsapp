import type { CatalogStatusDto } from '../api/contract';
import { readCommerce } from './catalog-commerce';
import { LAST_ERROR_KEY, LAST_SYNC_KEY } from './catalog';
import type { LinkHost } from './host';
import { getState, readSettings } from './settings';

const EXCLUDED_SHOWN = 20;

/** What the merchant sees: is the catalogue connected, what is in it, what was left out and why, the shop button, the last problem. Reads only this workspace's own state. */
export function catalogStatus(host: LinkHost): CatalogStatusDto {
  const last = getState(host, LAST_SYNC_KEY);
  const catalogId = readSettings(host).catalogId;
  const count = (status: string) => host.sql.exec<{ n: number }>('SELECT count(*) AS n FROM catalog_items WHERE status = ?', status).one().n;
  const commerce = catalogId ? readCommerce(host) : null;
  const error = getState(host, LAST_ERROR_KEY);
  return {
    catalogId,
    lastSyncAt: last ? Number(last) : null,
    items: { synced: count('synced'), excluded: count('excluded'), rejected: count('rejected') },
    leftOut: host.sql.exec<{ retailer_id: string; reason: string | null; status: string }>("SELECT retailer_id, reason, status FROM catalog_items WHERE status != 'synced' ORDER BY updated_at DESC LIMIT ?", EXCLUDED_SHOWN).toArray().map((r) => ({ retailerId: r.retailer_id, reason: r.reason ?? r.status })),
    commerce: commerce ? { catalogVisible: commerce.catalogVisible, cartEnabled: commerce.cartEnabled, failed: commerce.failed } : null,
    error: error === 'missing_permission' || error === 'sync_failed' ? error : null,
    syncing: !!getState(host, 'catalog.pass'),
    pending: host.sql.exec<{ n: number }>('SELECT count(*) AS n FROM catalog_dirty').one().n,
  };
}
