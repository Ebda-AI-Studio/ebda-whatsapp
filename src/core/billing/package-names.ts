/**
 * Chat package display names are BY SIZE, never tiers (Ahmad 2026-11-19): the size is what the package actually meters, its monthly AI credits, and
 * one credit is one AI reply (see docs/billing.md). So a package is "Chat 1,500 AI replies" / «شات 1500 رد ذكي», and its yearly twin adds "(yearly)" / «سنوي».
 * The names Starter / Growth / Pro collided with the Store's plan names, so no Chat package display name may contain them (`test/package-names.test.ts`).
 * Ids and prices are untouched: the id (`starter`, `growth-yearly`, ...) is an internal code, only the display text derives from the credits.
 * Digits follow DIGITS-1: Western digits in Arabic too, grouped only from 10,000 (the same rule as the web `num()`); English always groups.
 */
const AR = new Intl.NumberFormat('ar-EG-u-nu-latn', { useGrouping: false });
const AR_GROUPED = new Intl.NumberFormat('ar-EG-u-nu-latn', { useGrouping: true });
const EN = new Intl.NumberFormat('en-US');

export type ChatPackageName = { nameAr: string; nameEn: string };

export function chatPackageName(aiCredits: number, periodMonths: number): ChatPackageName {
  const yearly = periodMonths === 12;
  return {
    nameEn: `Chat ${EN.format(aiCredits)} AI replies${yearly ? ' (yearly)' : ''}`,
    nameAr: `شات ${(aiCredits >= 10_000 ? AR_GROUPED : AR).format(aiCredits)} رد ذكي${yearly ? ' سنوي' : ''}`,
  };
}
