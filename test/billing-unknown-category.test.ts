import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { Billing } from '../src/core/billing/engine';
import { PIASTERS, chat, setupBilling } from './helpers/billing';
import { workspace } from './helpers/workspace';

// WA-CATEGORY-1 (#114): a template whose category is unknown locally is priced as MARKETING (the dearest) until Meta confirms its category.
const W = (n: number) => `00000000-0000-4000-8000-0000000074${String(n).padStart(2, '0')}`;
const ghost = { kind: 'template', template: { name: 'ghost', language: 'ar', params: [] } } as never;
const known = { kind: 'template', template: { name: 'tpl-u', language: 'ar', params: [] } } as never;

describe('WA-CATEGORY-1 unknown template category', () => {
  it('an unknown template holds at the marketing rate; a known one keeps its own category', async () => {
    const ws = W(1);
    await setupBilling(ws);
    await chat(ws); // seeds tpl-m / tpl-u / tpl-a
    const r = await runInDurableObject(workspace(ws), (inst) => {
      const b = (inst as unknown as { billing: Billing }).billing;
      return { ghost: b.jobCategory(ghost), known: b.jobCategory(known), est: b.estimateMinor('201001234567', b.jobCategory(ghost), Date.now()).minor };
    });
    expect(r).toEqual({ ghost: 'marketing', known: 'utility', est: PIASTERS.marketing });
  });
});
