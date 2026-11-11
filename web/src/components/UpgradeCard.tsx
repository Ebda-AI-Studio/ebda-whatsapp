import { Sparkles } from 'lucide-react';
import { BRAND } from '@brand';

/** Where a store owner changes the package: the Store admin billing page, or null when the brand has no linked store. */
export function billingUrl(storeId: string | undefined): string | null {
  const origin = BRAND.storeAdminUrl;
  return origin && storeId ? `${origin.replace(/\/$/, '')}/stores/${encodeURIComponent(storeId)}/billing` : null;
}

/**
 * The upgrade card (foundation component rule "upgrade card"): a plan limit is a next step, never an error. Icon, what the
 * package allows in a sentence, then ONE action that opens the Store billing page. Same anatomy as the admin refusal card.
 */
export function UpgradeCard({ title, body, cta, href }: { title: string; body: string; cta: string; href: string | null }) {
  return (
    <aside className="upgrade" aria-label={title}>
      <span className="state-icon" aria-hidden><Sparkles size={22} /></span>
      <div className="upgrade-text">
        <p className="state-title">{title}</p>
        <p className="state-body">{body}</p>
      </div>
      {href && <a className="btn primary" href={href} target="_blank" rel="noopener">{cta}</a>}
    </aside>
  );
}
