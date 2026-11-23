import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { listPackages } from '../src/core/billing/package-orders';
import { chatPackageName } from '../src/core/billing/package-names';

// Ahmad 2026-11-19: Chat packages are named BY SIZE (monthly AI replies), never Starter / Growth / Pro (they collide with the Store's plan names).
const TIER = /\b(starter|growth|pro|basic|business|professional)\b/i;
const ARABIC_INDIC = /[٠-٩۰-۹]/;

describe('chatPackageName', () => {
  it('names a package by its monthly AI replies, with a yearly twin, Western digits in Arabic (DIGITS-1)', () => {
    expect(chatPackageName(300, 1)).toEqual({ nameEn: 'Chat 300 AI replies', nameAr: 'شات 300 رد ذكي' });
    expect(chatPackageName(1500, 1)).toEqual({ nameEn: 'Chat 1,500 AI replies', nameAr: 'شات 1500 رد ذكي' });
    expect(chatPackageName(5000, 12)).toEqual({ nameEn: 'Chat 5,000 AI replies (yearly)', nameAr: 'شات 5000 رد ذكي سنوي' });
    expect(chatPackageName(12000, 1).nameAr).toBe('شات 12,000 رد ذكي'); // grouped only from 10,000, like the web num()
    for (const n of [chatPackageName(300, 12), chatPackageName(12000, 12)]) expect(n.nameAr).not.toMatch(ARABIC_INDIC);
  });
});

describe('every Chat package a merchant can see', () => {
  it('the seeded D1 rows carry size names, never a tier name, and match what the app derives', async () => {
    const rows = (await env.DB.prepare("SELECT id, name, ai_credits, period_months FROM packages WHERE id IN ('starter','growth','pro','starter-yearly','growth-yearly','pro-yearly')").all<{ id: string; name: string; ai_credits: number; period_months: number }>()).results;
    expect(rows).toHaveLength(6); // the ids are the unchanged internal codes
    for (const r of rows) {
      expect(r.name, r.id).not.toMatch(TIER);
      expect(r.name, r.id).toBe(chatPackageName(r.ai_credits, r.period_months).nameEn);
    }
  });

  it('GET packages (the list a merchant buys from) returns size names in both languages and no tier word, ids and prices unchanged', async () => {
    const items = await listPackages(env);
    const by = new Map(items.map((p) => [p.id, p]));
    expect(by.get('growth')).toMatchObject({ priceMinor: 149000, aiCredits: 1500, nameEn: 'Chat 1,500 AI replies', nameAr: 'شات 1500 رد ذكي' });
    expect(by.get('pro-yearly')).toMatchObject({ priceMinor: 3141000, nameEn: 'Chat 5,000 AI replies (yearly)', nameAr: 'شات 5000 رد ذكي سنوي' });
    for (const p of items.filter((x) => ['starter', 'growth', 'pro', 'starter-yearly', 'growth-yearly', 'pro-yearly'].includes(x.id))) {
      for (const n of [p.name, p.nameAr!, p.nameEn!]) { expect(n, p.id).not.toMatch(TIER); expect(n).not.toMatch(ARABIC_INDIC); }
    }
  });
});
