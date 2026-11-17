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
