import { describe, expect, it } from 'vitest';
import { META_LIMITS, RULE_CODES, checkTemplate, type RuleCode } from '../src/core/meta/template-rules';
import { ruleMessage } from '../src/core/meta/template-rule-copy';
import type { TemplateDraft } from '../src/core/template-draft';

const base = (over: Partial<TemplateDraft> = {}): TemplateDraft => ({
  name: 'shipping_update', label: 'تحديث الشحن', language: 'ar', category: 'UTILITY', header: null,
  body: { text: 'أهلاً {{1}}، طلبك رقم {{2}} خرج للشحن وهيوصلك خلال {{3}}.', examples: ['أحمد', '1001', 'يومين'] },
  footer: null, buttons: [], ...over,
});
const codes = (d: TemplateDraft, existing?: Parameters<typeof checkTemplate>[1]) => checkTemplate(d, existing).map((i) => i.code);
const body = (text: string, examples: string[] = []) => base({ body: { text, examples } });

describe('checkTemplate', () => {
  it('a clean Egyptian Arabic shipping template has no issues', () => expect(checkTemplate(base())).toEqual([]));

  it('body starting with a variable is an error', () => {
    const i = checkTemplate(body('{{1}} شكراً على طلبك', ['أحمد'])).find((x) => x.code === 'variable_at_edge');
    expect(i).toMatchObject({ severity: 'error', field: 'body' });
  });
  it('body ending with a variable is an error', () => expect(codes(body('طلبك رقم {{1}}', ['1001']))).toContain('variable_at_edge'));
  it('non-sequential variables ({{1}},{{3}}) are variable_gap', () => expect(codes(body('أهلاً {{1}} طلبك {{3}} خرج.', ['أ', 'ب', 'ج']))).toContain('variable_gap'));
  it('a variable without an example is example_missing with its index', () => {
    const i = checkTemplate(body('أهلاً {{1}} طلبك {{2}} خرج.', ['أحمد'])).find((x) => x.code === 'example_missing');
    expect(i).toMatchObject({ field: 'examples', params: { index: 2 } });
  });
  it('unbalanced braces are braces_mismatch', () => expect(codes(body('أهلاً {{1} طلبك خرج.', ['أ']))).toContain('braces_mismatch'));
  it('body over 1024 fails, 1024 passes', () => {
    const mk = (n: number) => body(`أ${'ب'.repeat(n - 2)}.`);
    expect(codes(mk(1025))).toContain('body_too_long');
    expect(codes(mk(META_LIMITS.BODY_MAX))).not.toContain('body_too_long');
  });
  it('an empty body is body_missing for non-auth', () => expect(codes(body('   '))).toContain('body_missing'));

  it('header 61 chars fails, 60 passes; two header variables fail', () => {
    const h = (n: number) => base({ header: { text: 'ه'.repeat(n) } });
    expect(codes(h(61))).toContain('header_too_long');
    expect(codes(h(60))).not.toContain('header_too_long');
    expect(codes(base({ header: { text: 'طلب {{1}} من {{2}}', example: 'x' } }))).toContain('header_vars');
  });
  it('a header variable needs its example', () => expect(codes(base({ header: { text: 'طلب {{1}}' } }))).toContain('example_missing'));
  it('footer with a variable fails and over 60 fails', () => {
    expect(codes(base({ footer: 'شكراً {{1}}' }))).toContain('footer_variable');
    expect(codes(base({ footer: 'ف'.repeat(61) }))).toContain('footer_too_long');
  });
  it('# $ % inside an example is example_bad_chars', () => expect(codes(body('أهلاً {{1}} طلبك خرج.', ['10%']))).toContain('example_bad_chars'));

  const qr = (n: number) => ({ type: 'QUICK_REPLY' as const, text: `رد ${n}` });
  const url = (n: number, u = `https://shop.example/${n}`) => ({ type: 'URL' as const, text: `رابط ${n}`, url: u });
  it('buttons: 11 total fails', () => expect(codes(base({ buttons: Array.from({ length: 11 }, (_, i) => qr(i)) }))).toContain('buttons_too_many'));
  it('3 URL buttons fail', () => expect(codes(base({ buttons: [url(1), url(2), url(3)] }))).toContain('urls_too_many'));
  it('a quick reply between two URLs is qr_groups', () => expect(codes(base({ buttons: [url(1), qr(1), url(2)] }))).toContain('qr_groups'));
  it('two contiguous groups are fine', () => expect(codes(base({ buttons: [qr(1), qr(2), url(1)] }))).not.toContain('qr_groups'));
  it('button text 26 chars fails, 25 passes', () => {
    expect(codes(base({ buttons: [{ type: 'QUICK_REPLY', text: 'ب'.repeat(26) }] }))).toContain('button_text_too_long');
    expect(codes(base({ buttons: [{ type: 'QUICK_REPLY', text: 'ب'.repeat(25) }] }))).not.toContain('button_text_too_long');
  });
  it('a url variable not at the end is url_variable_position', () => {
    expect(codes(base({ buttons: [url(1, 'https://shop.example/{{1}}/track')] }))).toContain('url_variable_position');
    expect(codes(base({ buttons: [{ ...url(1, 'https://shop.example/t/{{1}}'), example: 'https://shop.example/t/abc' }] }))).not.toContain('url_variable_position');
  });
  it('a url with a variable needs an example', () => expect(codes(base({ buttons: [url(1, 'https://shop.example/t/{{1}}')] }))).toContain('example_missing'));
  it('two phone buttons and an over-long number fail', () => {
    const ph = { type: 'PHONE_NUMBER' as const, text: 'اتصل بينا', phone: '+201000000000' };
    expect(codes(base({ buttons: [ph, ph] }))).toContain('phones_too_many');
    expect(codes(base({ buttons: [{ ...ph, phone: '+2010000000000000000000' }] }))).toContain('phone_number_length');
  });

  it('AUTHENTICATION with a url or an emoji is auth_forbidden_content', () => {
    const auth = (footer: string | null) => base({ category: 'AUTHENTICATION', body: { text: '', examples: [] }, footer, auth: { expiryMinutes: 10, securityRecommendation: true } });
    expect(codes(auth(null))).toEqual([]);
    expect(codes(auth('زوروا https://x.example'))).toContain('auth_forbidden_content');
    expect(codes(auth('شكراً 😀'))).toContain('auth_forbidden_content');
  });
  it('AUTHENTICATION expiry outside 1..90 is an error (Meta: minimum 1, maximum 90)', () => {
    const auth = (m: number | null) => base({ category: 'AUTHENTICATION', body: { text: '', examples: [] }, auth: { expiryMinutes: m, securityRecommendation: false } });
    expect(codes(auth(0))).toContain('auth_expiry_range');
    expect(codes(auth(91))).toContain('auth_expiry_range');
    expect(codes(auth(90))).not.toContain('auth_expiry_range');
    expect(codes(auth(null))).not.toContain('auth_expiry_range');
  });

  it('a promotional-looking UTILITY body is a WARNING suggesting MARKETING', () => {
    const i = checkTemplate(body('أهلاً {{1}}، عندنا خصم على طلبك رقم {{2}} النهارده.', ['أحمد', '1001'])).find((x) => x.code === 'category_looks_promotional');
    expect(i).toMatchObject({ severity: 'warning', field: 'category' });
    expect(codes({ ...body('أهلاً {{1}}، عندنا خصم {{2}} النهارده.', ['أ', 'ب']), category: 'MARKETING' })).not.toContain('category_looks_promotional');
  });
  it('a duplicate body+footer of another template is an error (not for AUTHENTICATION, not for itself)', () => {
    const d = base();
    const dup = { name: 'other_one', language: 'ar', bodyText: d.body.text, footer: null };
    expect(codes(d, [dup])).toContain('duplicate_body');
    expect(codes(d, [{ ...dup, name: d.name }])).not.toContain('duplicate_body');
  });
  it('name Bad Name! is name_format', () => expect(codes(base({ name: 'Bad Name!' }))).toContain('name_format'));

  it('every RuleCode has an Arabic and an English message', () => {
    for (const code of RULE_CODES as readonly RuleCode[]) {
      const issue = { code, severity: 'error' as const, field: 'body' as const, params: { index: 2, max: 10, min: 1 } };
      for (const lang of ['ar', 'en'] as const) expect(ruleMessage(issue, lang).length, `${code}/${lang}`).toBeGreaterThan(10);
      expect(ruleMessage(issue, 'ar')).toMatch(/[؀-ۿ]/);
    }
  });
});
