import type { WebBrand } from '../types';

export const BRAND: WebBrand = {
  id: 'ebda',
  productName: 'Ebda Chat',
  productNameAr: 'ابدأ شات',
  signInProduct: 'chat',
  // Ruling AR-STUDIO-NAME-1: the studio is «ابدأ ستوديو» (no alef) in short UI lockups.
  gate: { studio: { ar: 'ابدأ ستوديو', en: 'Ebda AI Studio' }, product: { ar: 'ابدأ شات', en: 'Ebda Chat' } },
  mark: { src: '/brand/symbol-gold.svg', alt: 'Ebda AI Studio', width: 30, height: 36 },
  appleTouchIcon: '/brand/apple-touch-icon.png',
  accountsUrl: 'https://accounts.ebda.app',
  // Guides are published on help.ebda.app from docs/help by the Store session; one slug per guide file.
  // The suite help site's WhatsApp section: Arabic at the root, English under /en, trailing slash (help.ebda.app routing).
  helpUrl: (lang, slug) => `https://help.ebda.app${lang === 'en' ? '/en' : ''}/whatsapp/${slug}/`,
  storeName: 'Ebda Store',
  // WA-SUPPORT-1 (Ahmad): the Store's public contact address; pinned to the Store's brand constant in vendor/brand/store-support-email.json.
  supportEmail: 'ahlan@ebda.app',
};
