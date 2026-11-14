import { describe, expect, it } from 'vitest';
import { EBDA_DEFAULT_TEMPLATES } from '../src/addons/ebda/templates';
import { fromStoredComponents, payloadHash, toMetaComponents, type TemplateDraft } from '../src/core/template-draft';
import type { StoredComponent } from '../src/core/templates';

const shipping: TemplateDraft = {
  name: 'shipping_update', label: 'تحديث الشحن', language: 'ar', category: 'UTILITY', header: null,
  body: { text: 'أهلاً {{1}}، طلبك رقم {{2}} خرج للشحن 🚚 وهيوصلك خلال {{3}}.', examples: ['أحمد', '1001', 'يومين'] },
  footer: null, buttons: [],
};
const rich: TemplateDraft = {
  name: 'order_help', label: 'مساعدة الطلب', language: 'ar', category: 'UTILITY', header: { text: 'طلب {{1}}', example: '1001' },
  body: { text: 'أهلاً {{1}}، محتاج مساعدة في طلبك؟', examples: ['أحمد'] }, footer: 'ابدأ لخدمة العملاء',
  buttons: [{ type: 'QUICK_REPLY', text: 'أيوه' }, { type: 'URL', text: 'تابع الطلب', url: 'https://shop.example/t/{{1}}', example: 'https://shop.example/t/abc' }, { type: 'PHONE_NUMBER', text: 'اتصل بينا', phone: '+201000000000' }],
};
const auth: TemplateDraft = {
  name: 'otp_code', label: 'كود التحقق', language: 'ar', category: 'AUTHENTICATION', header: null, body: { text: '', examples: [] }, footer: null, buttons: [],
  auth: { expiryMinutes: 10, securityRecommendation: true },
};

describe('toMetaComponents', () => {
  it('builds exactly the components of the shipped shipping_update default', () => {
    const seed = EBDA_DEFAULT_TEMPLATES[2]!;
    expect(seed.name).toBe('shipping_update');
    expect(toMetaComponents(shipping)).toEqual(seed.components);
  });
  it('builds the authentication components of the shipped otp_code default', () => {
    expect(toMetaComponents(auth)).toEqual(EBDA_DEFAULT_TEMPLATES[3]!.components);
  });
  it('puts positional examples where Meta wants them', () => {
    const c = toMetaComponents(rich) as StoredComponent[];
    expect(c[0]).toEqual({ type: 'HEADER', format: 'TEXT', text: 'طلب {{1}}', example: { header_text: ['1001'] } });
    expect(c[1]).toMatchObject({ type: 'BODY', example: { body_text: [['أحمد']] } });
    expect(c[2]).toEqual({ type: 'FOOTER', text: 'ابدأ لخدمة العملاء' });
    expect((c[3] as { buttons: unknown[] }).buttons[1]).toEqual({ type: 'URL', text: 'تابع الطلب', url: 'https://shop.example/t/{{1}}', example: ['https://shop.example/t/abc'] });
  });
});

describe('fromStoredComponents', () => {
  const meta = (d: TemplateDraft) => ({ name: d.name, language: d.language, category: d.category, label: d.label });
  it.each([['utility with buttons', rich], ['plain utility', shipping], ['authentication', auth]])('round-trips %s', (_n, d) => {
    expect(fromStoredComponents(toMetaComponents(d) as StoredComponent[], meta(d))).toEqual(d);
  });
});

describe('payloadHash', () => {
  it('is identical for key-reordered drafts', async () => {
    const reordered = JSON.parse(JSON.stringify(Object.fromEntries(Object.entries(shipping).reverse()))) as TemplateDraft;
    expect(await payloadHash(reordered)).toBe(await payloadHash(shipping));
    expect(await payloadHash(shipping)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('differs when one example changes', async () => {
    const changed = { ...shipping, body: { ...shipping.body, examples: ['أحمد', '1002', 'يومين'] } };
    expect(await payloadHash(changed)).not.toBe(await payloadHash(shipping));
  });
});
