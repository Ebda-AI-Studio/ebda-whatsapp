import { describe, expect, it } from 'vitest';
import { rejectionAdvice } from '../src/core/template-advice';
import fixture from './fixtures/template-reasons.json';

describe('rejectionAdvice', () => {
  it('INVALID_FORMAT is Arabic first and tells the merchant to fix braces and variables', () => {
    const a = rejectionAdvice('INVALID_FORMAT', 'REJECTED')!;
    expect(a.kind).toBe('format');
    expect(a.ar).toMatch(/[؀-ۿ]/);
    expect(a.ar).toMatch(/متغيّر/);
    expect(a.ar).toMatch(/\{\{/);
    expect(a.en).toMatch(/variable/i);
  });
  it.each(fixture.reasons)('the captured reason $code maps to $kind with both languages', ({ code, kind }) => {
    const a = rejectionAdvice(code, 'REJECTED')!;
    expect(a.kind).toBe(kind);
    expect(a.ar.length).toBeGreaterThan(20);
    expect(a.en.length).toBeGreaterThan(20);
  });
  it('maps the four documented review themes by wording when the code is unfamiliar', () => {
    expect(rejectionAdvice('Parameter format is wrong', 'REJECTED')!.kind).toBe('format');
    expect(rejectionAdvice('Message too long', 'REJECTED')!.kind).toBe('length');
    expect(rejectionAdvice('Too many emojis', 'REJECTED')!.kind).toBe('length');
    expect(rejectionAdvice('Duplicate template content', 'REJECTED')!.kind).toBe('duplicate');
    expect(rejectionAdvice('Violates commerce policy', 'REJECTED')!.kind).toBe('policy');
  });
  it('an unknown code gets the generic advice and is never echoed back (a reason could carry merchant text)', () => {
    const secret = 'أهلاً أحمد رقم طلبك 1001 السري';
    const a = rejectionAdvice(secret, 'REJECTED')!;
    expect(a.kind).toBe('unknown');
    expect(a.ar).not.toContain('أحمد');
    expect(a.ar).not.toContain('1001');
    expect(a.en).not.toContain('1001');
  });
  it('a rejected template with no reason (null or NONE) still gets the generic advice', () => {
    expect(rejectionAdvice(null, 'REJECTED')!.kind).toBe('unknown');
    expect(rejectionAdvice('NONE', 'REJECTED')!.kind).toBe('unknown');
  });
  it('PAUSED and DISABLED have their own plain advice; healthy statuses have none', () => {
    expect(rejectionAdvice(null, 'PAUSED')!.ar).toMatch(/مؤقتًا/);
    expect(rejectionAdvice(null, 'DISABLED')!.ar).toMatch(/متعطّل/);
    for (const s of ['APPROVED', 'PENDING', 'PENDING_DELETION']) expect(rejectionAdvice('INVALID_FORMAT', s)).toBeNull();
  });
});

describe('knownReason', () => {
  it('knows the documented codes and the wording themes, and not an unfamiliar enum', async () => {
    const { knownReason } = await import('../src/core/template-advice');
    for (const r of fixture.reasons) expect(knownReason(r.code), r.code).toBe(true);
    expect(knownReason('Parameter format is wrong')).toBe(true);
    expect(knownReason('BRAND_NEW_META_CODE')).toBe(false);
    expect(knownReason(null)).toBe(true); // nothing to capture
  });
});
