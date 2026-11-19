/** Ruling CHAT-AGENT-2 (revised, review I4): a declared policy can be STATED (free shipping with its declared threshold, a return window with its declared days) without the merchant switching the promise flag on; money-back promises stay refused. */
import { describe, expect, it } from 'vitest';
import { guardReply, Trusted } from '../src/core/ai/reply-guard';

const mk = (declared: { freeOver?: number[]; returnDays?: number | null } = {}) => {
  const t = new Trusted();
  t.addText('Shipping zone Cairo: 60 EGP, free over 1000 EGP');
  t.setDeclared({ freeOver: declared.freeOver ?? [], returnDays: declared.returnDays ?? null });
  return t;
};
const verdict = (reply: string, d?: Parameters<typeof mk>[0]) => guardReply(reply, mk(d)).ok;

describe('free shipping only with the declared threshold', () => {
  it('passes with the declared amount, in Arabic and English', () => {
    expect(verdict('الشحن مجاني فوق 1000 جنيه', { freeOver: [1000] })).toBe(true);
    expect(verdict('شحن مجاني للطلبات فوق 1000 جنيه', { freeOver: [1000] })).toBe(true);
    expect(verdict('Free shipping over 1000 EGP', { freeOver: [1000] })).toBe(true);
  });
  it('a threshold the merchant did not declare is refused (price or promise)', () => {
    expect(verdict('الشحن مجاني فوق 500 جنيه', { freeOver: [1000] })).toBe(false);
  });
  it('free shipping with no amount is refused, declared threshold or not', () => {
    expect(verdict('الشحن مجاني', { freeOver: [1000] })).toBe(false);
    expect(verdict('Free shipping on everything', { freeOver: [1000] })).toBe(false);
  });
  it('nothing declared: refused even with an amount', () => {
    expect(verdict('الشحن مجاني فوق 1000 جنيه')).toBe(false);
  });
  it('a free gift or "free of charge" is not a shipping statement and stays refused', () => {
    expect(verdict('هديه مجانيه مع الطلب فوق 1000 جنيه', { freeOver: [1000] })).toBe(false);
    expect(verdict('الشحن مجاني فوق 1000 جنيه ومعاه هديه مجانيه', { freeOver: [1000] })).toBe(false);
  });
});

describe('returns only with the declared window', () => {
  it('passes with the declared days', () => {
    expect(verdict('ينفع استرجاع خلال 14 يوم', { returnDays: 14 })).toBe(true);
    expect(verdict('الاسترجاع متاح خلال ١٤ يوم', { returnDays: 14 })).toBe(true);
    expect(verdict('Returns are accepted within 14 days', { returnDays: 14 })).toBe(true);
  });
  it('a different number of days, or none, is refused', () => {
    expect(verdict('ينفع استرجاع خلال 30 يوم', { returnDays: 14 })).toBe(false);
    expect(verdict('ينفع استرجاع', { returnDays: 14 })).toBe(false);
  });
  it('no window declared: refused', () => {
    expect(verdict('ينفع استرجاع خلال 14 يوم', { returnDays: null })).toBe(false);
  });
  it('a store with no returns: only an explicit negation passes', () => {
    expect(verdict('للأسف مفيش استرجاع', { returnDays: 0 })).toBe(true);
    expect(verdict('We do not accept returns', { returnDays: 0 })).toBe(true);
    expect(verdict('ينفع استرجاع', { returnDays: 0 })).toBe(false);
  });
  it('money-back promises stay refused even with a declared window', () => {
    for (const r of ['هرجعلك فلوسك خلال 14 يوم', 'هنرجع الفلوس خلال 14 يوم', 'you get a refund within 14 days', 'money back in 14 days', 'استرجاع الفلوس خلال 14 يوم', 'ارجاع المبلغ خلال 14 يوم'])
      expect(verdict(r, { returnDays: 14 }), r).toBe(false);
  });
  it('the policy flag still allows everything as before', () => {
    const t = new Trusted();
    t.setPolicy({ refund: true, discount: false, freeDelivery: true, exchange: false, guarantee: false });
    expect(guardReply('هرجعلك فلوسك والشحن مجاني', t).ok).toBe(true);
  });
});

// ship-ar-1 (live golden eval, 2026-11-19): "وممكن توصل مجانًا لو قيمة الطلب أكتر من 1000 جنيه" with a DECLARED 1000 threshold was refused as a promise. The diacritic was never the cause (normaliseText already strips
// tashkeel and tatweel, asserted below): the bare adverb "مجانا" after a shipping VERB sat outside the shipping phrases, so it read as "something else free". A declared threshold is a fact, not a promise.
describe('free shipping stated with a verb + adverb ("توصل مجانًا"), diacritics and tatweel', () => {
  it('passes with the declared threshold, whatever the diacritics or tatweel', () => {
    for (const w of ['مجانًا', 'مجانا', 'مَجّانًا', 'مجـانا']) {
      expect(verdict(`وممكن توصل ${w} لو قيمة الطلب أكتر من 1000 جنيه`, { freeOver: [1000] }), w).toBe(true);
    }
    expect(verdict('الطلب بيوصل مجانًا لو فوق 1000 جنيه', { freeOver: [1000] })).toBe(true);
    expect(verdict('Orders over 1000 EGP ship free', { freeOver: [1000] })).toBe(true);
    expect(verdict('الشحن للقاهرة 60 جنيه، ولو قيمة الطلب فوق 1000 جنيه الشحن يبقى مجاني', { freeOver: [1000] })).toBe(true); // the exact reply the live eval refused in the second run
  });
  it('is still refused with no declared free shipping, with a wrong amount, or with no amount', () => {
    expect(verdict('وممكن توصل مجانًا لو قيمة الطلب أكتر من 1000 جنيه')).toBe(false);
    expect(verdict('وممكن توصل مجانًا لو قيمة الطلب أكتر من 500 جنيه', { freeOver: [1000] })).toBe(false);
    expect(verdict('وممكن توصل مجانًا', { freeOver: [1000] })).toBe(false);
    expect(verdict('Orders over 1000 EGP ship free')).toBe(false); // "ship free" is now a recognised free-delivery promise (it was a blind spot), refused unless declared
  });
  it('a free GIFT or any other free thing stays refused, and a diacritic-decorated invented promise stays refused', () => {
    expect(verdict('هدية مجانًا مع الطلب فوق 1000 جنيه', { freeOver: [1000] })).toBe(false);
    expect(verdict('توصل مجانًا وكمان هدية مجانًا لو فوق 1000 جنيه', { freeOver: [1000] })).toBe(false);
    expect(verdict('الشحن هدية مجانية لو فوق 1000 جنيه', { freeOver: [1000] })).toBe(false); // a gift word inside the window
    expect(verdict('الشحن للقاهرة 60 جنيه وهدية مجانا لو فوق 1000 جنيه', { freeOver: [1000] })).toBe(false); // the free word is the gift's, outside the window
    expect(verdict('هنرجّعلك الفُلوس كلها', { freeOver: [1000] })).toBe(false);
    expect(verdict('فيه خَصْمٌ عشرين في المية لو الطلب فوق 1000 جنيه', { freeOver: [1000] })).toBe(false);
    expect(verdict('ضَمَانٌ سنة على المنتج', { freeOver: [1000] })).toBe(false);
  });
});
