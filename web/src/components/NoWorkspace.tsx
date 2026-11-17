import { Sparkles } from 'lucide-react';
import { BRAND } from '@brand';
import type { Lang, Strings } from '../i18n';
import { billingUrl } from './UpgradeCard';

/**
 * A store with no Chat workspace is its OWN state, not a failed load and not an empty inbox: nothing was loaded because there is nothing to load.
 * The one action is the Store plan page for that store (the repo has no separate activation route: Chat is switched on from the store's plan/billing page).
 */
export function NoWorkspace({ t, lang, storeId, storeName }: { t: Strings; lang: Lang; storeId: string | undefined; storeName: string }) {
  const product = lang === 'ar' && BRAND.productNameAr ? BRAND.productNameAr : BRAND.productName;
  const href = billingUrl(storeId);
  return (
    <main className="screen no-workspace">
      <div className="state" role="status" aria-label={t.noWsTitle(product)}>
        <span className="state-icon" aria-hidden><Sparkles size={22} /></span>
        <p className="state-title">{t.noWsTitle(product)}</p>
        <p className="state-body">{t.noWsBody(storeName, product)}</p>
        {href && <a className="btn primary" href={href} target="_blank" rel="noopener">{t.noWsCta(product)}</a>}
      </div>
    </main>
  );
}
