import type { CatalogRow, StorePolicies } from '../../src/core/store-bridge';
import { FakeStore } from '../helpers/fake-store';
import { BUYER_KEY_1, PHONE_1 } from '../helpers/store-link';
import type { StorePreset } from './golden-cases';

/** A small Egyptian fashion-and-gifts catalogue (prices in EGP; v8 is out of stock). */
const ITEMS: [string, string, string, number][] = [
  ['v1', 'Red evening dress', 'فستان سهرة أحمر', 850], ['v2', 'Blue casual dress', 'فستان كاجوال أزرق', 450], ['v3', 'Brown leather bag', 'شنطة جلد بني', 620], ['v4', 'Men leather wallet', 'محفظة رجالي جلد', 300],
  ['v5', 'Classic watch', 'ساعة يد كلاسيك', 1200], ['v6', 'Women perfume gift set', 'عطر هدية للسيدات', 550], ['v7', 'Silk scarf', 'إيشارب حرير', 250], ['v8', 'Running shoes', 'حذاء رياضي', 700],
  ['v9', 'Silver necklace', 'سلسلة فضة', 380], ['v10', 'Chocolate gift box', 'بوكس هدية شوكولاتة', 200], ['v11', 'Cotton t-shirt', 'تي شيرت قطن', 180], ['v12', 'Denim jacket', 'جاكيت جينز', 520],
];
export const eg = (id: string, en: string, ar: string, egp: number): CatalogRow => ({ retailerId: id, productId: `p-${id}`, title: en, titleAr: ar, description: null, priceMinor: egp * 100, currency: 'EGP', availability: 'in_stock', imageUrl: null, link: `https://shop.example/p/${id}`, brand: null });
export const EG_CATALOG: CatalogRow[] = ITEMS.map(([id, en, ar, egp]) => eg(id, en, ar, egp));

/** Words a shopper says that the Store's search maps to products (the Store's own synonym/meaning leg, in miniature). It does NOT understand Franco-Arabic: the agent must translate. */
const SYN: Record<string, string[]> = {
  هدية: ['هدية', 'عطر', 'بوكس', 'سلسلة', 'إيشارب', 'gift', 'perfume', 'box', 'necklace', 'scarf'], هدايا: ['هدية', 'عطر', 'بوكس', 'سلسلة'], gift: ['هدية', 'عطر', 'بوكس', 'سلسلة', 'إيشارب', 'gift', 'perfume', 'box', 'necklace', 'scarf'],
  dress: ['فستان', 'dress'], فساتين: ['فستان'], فستان: ['فستان'], bag: ['شنطة', 'bag'], شنطة: ['شنطة'], wallet: ['محفظة', 'wallet'], محفظة: ['محفظة'], scarf: ['إيشارب', 'scarf'], scarves: ['إيشارب', 'scarf'], إيشارب: ['إيشارب'],
  watch: ['ساعة', 'watch'], ساعة: ['ساعة'], جاكيت: ['جاكيت'], jacket: ['جاكيت', 'jacket'], حذاء: ['حذاء'], shoes: ['حذاء', 'shoes'],
};
const fold = (s: string) => s.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
export function evalSearch(catalog: CatalogRow[], query: string, opts: { maxPriceMinor?: number; limit: number }): CatalogRow[] {
  const words = query.split(/[\s,؟?!.]+/).filter((w) => w.length > 1);
  const terms = new Set(words.flatMap((w) => [w, ...(SYN[w] ?? SYN[w.toLowerCase()] ?? [])]).map(fold));
  return catalog
    .map((r) => ({ r, n: [...terms].filter((t) => fold(`${r.title} ${r.titleAr ?? ''}`).includes(t)).length }))
    .filter((x) => x.n > 0 && (opts.maxPriceMinor === undefined || x.r.priceMinor <= opts.maxPriceMinor))
    .sort((a, b) => b.n - a.n)
    .slice(0, opts.limit)
    .map((x) => x.r);
}

const POLICIES: StorePolicies = {
  name: 'Dar Mona', nameAr: 'دار منى', currency: 'EGP', locale: 'ar', paymentMethods: ['cod', 'link', 'instapay'], instapay: true,
  cod: { available: true, fixedFeeMinor: null, percentBps: null },
  shipping: {
    zones: [{ name: 'Cairo', nameAr: 'القاهرة', areas: ['Maadi', 'Nasr City', 'Heliopolis'], feeMinor: 6000, freeOverMinor: 100_000, etaDaysMin: 1, etaDaysMax: 2 }],
    governorates: [{ governorate: 'Giza', governorateAr: 'الجيزة', feeMinor: 7000, feeMaxMinor: 7000, freeOverMinor: null }],
  },
  returns: { windowDays: 14, feesPaidBy: 'customer' }, hours: 'السبت للخميس من 10 الصبح لـ 10 بالليل', location: { address: '9 Road 233, Maadi', addressAr: 'المعادي، شارع 233 رقم 9', mapsUrl: null },
};

/** Puts a fake Store in the state a case calls for. */
export function applyPreset(fake: FakeStore, preset: StorePreset): void {
  fake.catalog = EG_CATALOG.map((r) => ({ ...r }));
  fake.stock = Object.fromEntries(EG_CATALOG.map((r) => [r.retailerId, r.retailerId === 'v8' ? 0 : 20]));
  fake.searchImpl = (q, o) => evalSearch(fake.catalog, q, o);
  fake.policies = { ...POLICIES };
  if (preset === 'noShipping') fake.policies = { ...POLICIES, shipping: { zones: [], governorates: [] } };
  if (preset === 'noPolicies') fake.policies = { ...POLICIES, shipping: { zones: [], governorates: [] }, returns: { windowDays: null, feesPaidBy: null }, hours: null, location: null };
  if (preset === 'orders')
    fake.orders.set('ord-1001', { orderId: 'ord-1001', orderNumber: '1001', buyerKey: BUYER_KEY_1, status: 'shipped', paymentMethod: 'cod', lines: [{ variantId: 'v1', quantity: 1 }], totalMinor: 85_000, currency: 'EGP', at: Date.now() - 3 * 86_400_000, proofs: [], codOutcome: 'confirmed', instapayReference: null });
  if (preset === 'returning') {
    fake.addresses.set(BUYER_KEY_1, [{ id: 'a1', label: 'البيت', area: 'المعادي', street: '9 شارع 233' }]);
    fake.profiles.set(PHONE_1, {
      firstName: 'منى', preferredLocale: 'ar',
      defaultAddress: { id: 'a1', label: 'البيت', area: 'المعادي', street: '9 شارع 233', governorate: 'القاهرة', buildingNumber: '4', notes: null },
      recentOrders: [{ orderNumber: 'EB-900', status: 'delivered', totalMinor: 85_000, currency: 'EGP', at: 1_762_000_000_000, items: [{ name: 'فستان احمر - M', quantity: 1 }] }],
    });
  }
}
