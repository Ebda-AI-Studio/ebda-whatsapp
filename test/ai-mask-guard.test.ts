import { describe, expect, it } from 'vitest';
import { maskForModel } from '../src/core/ai/mask';
import { guardReply } from '../src/core/ai/reply-guard';

describe('maskForModel (B6): buyer text is masked before it reaches the model', () => {
  it('masks phones in every written form, card-like numbers and e-mails', () => {
    expect(maskForModel('اتصل بيا على 01012345678')).toBe('اتصل بيا على [phone]');
    expect(maskForModel('رقمي +20 101 234 5678 او ٠١٠١٢٣٤٥٦٧٨')).toBe('رقمي [phone] او [phone]');
    expect(maskForModel('my card 4111 1111 1111 1111 exp 12/29')).toBe('my card [card] exp 12/29');
    expect(maskForModel('4111-1111-1111-1111')).toBe('[card]');
    expect(maskForModel('4111111111111111')).toBe('[card]');
    expect(maskForModel('mail me at Ahmed.Test+1@example.co.uk please')).toBe('mail me at [email] please');
  });
  it('leaves order numbers, prices and quantities alone', () => {
    const s = 'طلب 1001 بسعر 250.50 جنيه، عايز 3 قطع';
    expect(maskForModel(s)).toBe(s);
  });
});

describe('guardReply: a reply the merchant did not stand behind is refused', () => {
  const trusted = ['{"results":[{"id":"v1","name":"Rose","price":110,"currency":"EGP","link":"https://shop.example.com/p/rose"}]}', 'We ship in 2 days. Visit https://shop.example.com'];
  it('lets an honest reply through', () => {
    expect(guardReply('الوردة سعرها 110 جنيه: https://shop.example.com/p/rose', trusted)).toEqual({ ok: true });
    expect(guardReply('Rose is 110 EGP, shipping takes 2 days', trusted)).toEqual({ ok: true });
    expect(guardReply('أهلاً بيك! أقدر أساعدك إزاي؟', [])).toEqual({ ok: true });
  });
  it('refuses a URL that is not on the merchant allow-list', () => {
    expect(guardReply('ادخل على http://evil.example.net/login', trusted)).toEqual({ ok: false, reason: 'url' });
    expect(guardReply('open www.evil-pay.com now', trusted)).toEqual({ ok: false, reason: 'url' });
    expect(guardReply('wa.me/201000000000', trusted)).toEqual({ ok: false, reason: 'url' });
    expect(guardReply('shop.example.com.evil.io/x', trusted)).toEqual({ ok: false, reason: 'url' });
  });
  it('refuses a price that did not come from the catalogue', () => {
    expect(guardReply('الوردة بـ 50 جنيه بس', trusted)).toEqual({ ok: false, reason: 'price' });
    expect(guardReply('Rose costs $5', trusted)).toEqual({ ok: false, reason: 'price' });
    expect(guardReply('السعر ٩٩ ج.م', trusted)).toEqual({ ok: false, reason: 'price' });
  });
  it('refuses a refund, discount or free-shipping promise the merchant never configured', () => {
    expect(guardReply('هرجعلك فلوسك كلها', trusted)).toEqual({ ok: false, reason: 'promise' });
    expect(guardReply('You will get a full refund', trusted)).toEqual({ ok: false, reason: 'promise' });
    expect(guardReply('خصم 50% ليك انت', trusted)).toEqual({ ok: false, reason: 'promise' });
    expect(guardReply('free shipping on this order', trusted)).toEqual({ ok: false, reason: 'promise' });
  });
  it('allows a promise class the merchant wrote down themselves', () => {
    const t = [...trusted, 'Returns: full refund within 14 days of delivery.'];
    expect(guardReply('You can get a full refund within 14 days', t)).toEqual({ ok: true });
    expect(guardReply('هديلك خصم', t)).toEqual({ ok: false, reason: 'promise' }); // a different class
  });
});
