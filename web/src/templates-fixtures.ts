import { vi } from 'vitest';
import type { TemplateDto } from '../../src/core/api/contract';
import type { TemplatesApi } from './data/source';

/** Test helpers for the Templates screens: a template DTO and a fake `TemplatesApi` whose calls are spies. */
export const tpl = (over: Partial<TemplateDto> = {}): TemplateDto => ({
  name: 'order_confirmation', language: 'ar', category: 'UTILITY', status: 'APPROVED', bodyText: 'أهلاً {{1}} طلبك اتسجّل.', paramCount: 1, rejectedReason: null,
  label: null, components: [{ type: 'BODY', text: 'أهلاً {{1}} طلبك اتسجّل.', example: { body_text: [['أحمد']] } }], updatedAt: Date.UTC(2026, 10, 13, 9, 0), editAllowance: { allowed: true }, ...over,
});

export function fakeApi(over: Partial<TemplatesApi> = {}): TemplatesApi {
  return {
    list: vi.fn(async () => ({ items: [tpl()], starterInstalled: true })),
    detail: vi.fn(async (name: string, language: string) => tpl({ name, language })),
    check: vi.fn(async () => ({ issues: [], payloadHash: 'a'.repeat(64) })),
    create: vi.fn(async (d) => ({ name: d.name, language: d.language, status: 'PENDING', category: d.category, categoryChanged: false })),
    edit: vi.fn(async () => ({ status: 'PENDING' })),
    remove: vi.fn(async () => undefined),
    sync: vi.fn(async () => ({ upserted: 3, removed: 1 })),
    installDefaults: vi.fn(async () => ({ submitted: ['a'], skipped: [], failed: [] })),
    ...over,
  };
}
