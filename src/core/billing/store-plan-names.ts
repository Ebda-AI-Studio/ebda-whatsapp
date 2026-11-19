/**
 * The Store's plan names, one name per plan (CHAT-QA-13). The Store sells these plans (the Store repo, packages/shared/src/schemas/plan-limits.ts) and sends
 * only the `planCode` in `store.plan_changed`; Chat shows the plan by the Store's own name and never invents its own. A code this table does not know
 * is shown as the code itself (never a guessed name), and `test/store-plan-names.test.ts` pins the codes the Store sells today.
 * Chat's own paid packages (Starter / Growth / Pro, bought in Chat) are a different thing and are always labelled "Chat package".
 */
export const STORE_PLAN_NAMES: Readonly<Record<string, { ar: string; en: string }>> = {
  free: { ar: 'مجاني', en: 'Free' },
  basic: { ar: 'الأساسية', en: 'Basic' },
  growth: { ar: 'النمو', en: 'Growth' },
  business: { ar: 'الأعمال', en: 'Business' },
  pro: { ar: 'احترافي', en: 'Pro' },
  comped: { ar: 'مجاني بمنحة', en: 'Comped' },
  founding_free: { ar: 'مؤسس (مجاني)', en: 'Founding (free)' },
};

export function storePlanNames(code: string): { code: string; nameAr: string; nameEn: string } {
  const n = STORE_PLAN_NAMES[code];
  return { code, nameAr: n?.ar ?? code, nameEn: n?.en ?? code };
}
