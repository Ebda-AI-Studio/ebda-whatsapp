import type { DraftButton, TemplateDraft } from '../template-draft';

/**
 * Meta's template limits, verified 2026-11-14 against Meta's official docs:
 * components https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/components.md
 * authentication expiry (code_expiration_minutes "Minimum 1, maximum 90") https://developers.facebook.com/docs/whatsapp/business-management-api/authentication-templates
 * review themes https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review.md
 * Anything Meta did not state (promotional wording, variable density) is a WARNING, never a blocker.
 */
export const META_LIMITS = {
  NAME_MAX: 512, BODY_MAX: 1024, HEADER_TEXT_MAX: 60, HEADER_VARS_MAX: 1, FOOTER_MAX: 60, BUTTONS_MAX: 10, QR_MAX: 10, QR_TEXT_MAX: 25,
  URL_MAX: 2, URL_TEXT_MAX: 25, URL_LEN_MAX: 2000, PHONE_MAX: 1, PHONE_TEXT_MAX: 25, PHONE_NUM_MAX: 20, COPY_EXAMPLE_MAX: 20, OTP_PARAM_MAX: 15,
  AUTH_EXPIRY_MIN: 1, AUTH_EXPIRY_MAX: 90,
} as const;

export const RULE_CODES = [
  'name_format', 'body_missing', 'body_too_long', 'variable_at_edge', 'variable_gap', 'braces_mismatch', 'example_missing', 'example_bad_chars',
  'header_too_long', 'header_vars', 'footer_too_long', 'footer_variable', 'buttons_too_many', 'qr_too_many', 'urls_too_many', 'phones_too_many',
  'copy_too_many', 'button_text_too_long', 'url_too_long', 'url_variable_position', 'qr_groups', 'phone_number_length', 'copy_example_too_long',
  'auth_forbidden_content', 'auth_expiry_range', 'category_looks_promotional', 'duplicate_body',
] as const;
export type RuleCode = (typeof RULE_CODES)[number];
export type RuleField = 'name' | 'header' | 'body' | 'footer' | 'buttons' | 'category' | 'examples';
export type RuleIssue = { code: RuleCode; severity: 'error' | 'warning'; field: RuleField; params?: Record<string, string | number> };
export type ExistingTemplate = { name: string; language: string; bodyText: string; footer: string | null };

const VAR = /\{\{\s*(\d+)\s*\}\}/g;
const varsOf = (s: string) => [...s.matchAll(VAR)].map((m) => Number(m[1]));
const err = (code: RuleCode, field: RuleField, params?: RuleIssue['params']): RuleIssue => ({ code, severity: 'error', field, ...(params ? { params } : {}) });
const warn = (code: RuleCode, field: RuleField, params?: RuleIssue['params']): RuleIssue => ({ code, severity: 'warning', field, ...(params ? { params } : {}) });
const len = (s: string) => [...s].length;

function nameRules(d: TemplateDraft): RuleIssue[] {
  return /^[a-z0-9_]+$/.test(d.name) && d.name.length <= META_LIMITS.NAME_MAX ? [] : [err('name_format', 'name')];
}

function bodyRules(d: TemplateDraft): RuleIssue[] {
  if (d.category === 'AUTHENTICATION') return [];
  const t = d.body.text;
  const out: RuleIssue[] = [];
  if (t.trim() === '') return [err('body_missing', 'body')];
  if (len(t) > META_LIMITS.BODY_MAX) out.push(err('body_too_long', 'body', { max: META_LIMITS.BODY_MAX }));
  if (/[{}]/.test(t.replace(VAR, ''))) out.push(err('braces_mismatch', 'body'));
  const v = varsOf(t);
  if (v.length > 0) {
    const trimmed = t.trim();
    if (/^\{\{\s*\d+\s*\}\}/.test(trimmed) || /\{\{\s*\d+\s*\}\}$/.test(trimmed)) out.push(err('variable_at_edge', 'body'));
    const max = Math.max(...v);
    const distinct = new Set(v);
    for (let i = 1; i <= max; i++) if (!distinct.has(i)) { out.push(err('variable_gap', 'body', { index: i })); break; }
    for (let i = 1; i <= max; i++) {
      const ex = d.body.examples[i - 1];
      if (ex === undefined || ex.trim() === '') out.push(err('example_missing', 'examples', { index: i }));
      else if (/[#$%]/.test(ex)) out.push(err('example_bad_chars', 'examples', { index: i }));
    }
  }
  return out;
}

function headerRules(d: TemplateDraft): RuleIssue[] {
  if (!d.header || d.category === 'AUTHENTICATION') return [];
  const out: RuleIssue[] = [];
  if (len(d.header.text) > META_LIMITS.HEADER_TEXT_MAX) out.push(err('header_too_long', 'header', { max: META_LIMITS.HEADER_TEXT_MAX }));
  const v = varsOf(d.header.text);
  if (v.length > META_LIMITS.HEADER_VARS_MAX) out.push(err('header_vars', 'header', { max: META_LIMITS.HEADER_VARS_MAX }));
  else if (v.length === 1 && (d.header.example ?? '').trim() === '') out.push(err('example_missing', 'examples', { index: 1 }));
  else if (v.length === 1 && /[#$%]/.test(d.header.example ?? '')) out.push(err('example_bad_chars', 'examples', { index: 1 }));
  return out;
}

function footerRules(d: TemplateDraft): RuleIssue[] {
  if (!d.footer || d.category === 'AUTHENTICATION') return [];
  const out: RuleIssue[] = [];
  if (len(d.footer) > META_LIMITS.FOOTER_MAX) out.push(err('footer_too_long', 'footer', { max: META_LIMITS.FOOTER_MAX }));
  if (/\{\{/.test(d.footer)) out.push(err('footer_variable', 'footer'));
  return out;
}

function buttonRules(d: TemplateDraft): RuleIssue[] {
  if (d.category === 'AUTHENTICATION') return [];
  const b = d.buttons;
  const out: RuleIssue[] = [];
  const count = (t: DraftButton['type']) => b.filter((x) => x.type === t).length;
  if (b.length > META_LIMITS.BUTTONS_MAX) out.push(err('buttons_too_many', 'buttons', { max: META_LIMITS.BUTTONS_MAX }));
  if (count('QUICK_REPLY') > META_LIMITS.QR_MAX) out.push(err('qr_too_many', 'buttons', { max: META_LIMITS.QR_MAX }));
  if (count('URL') > META_LIMITS.URL_MAX) out.push(err('urls_too_many', 'buttons', { max: META_LIMITS.URL_MAX }));
  if (count('PHONE_NUMBER') > META_LIMITS.PHONE_MAX) out.push(err('phones_too_many', 'buttons', { max: META_LIMITS.PHONE_MAX }));
  if (count('COPY_CODE') > 1) out.push(err('copy_too_many', 'buttons', { max: 1 }));
  for (const x of b) {
    if (x.type !== 'COPY_CODE' && len(x.text) > META_LIMITS.QR_TEXT_MAX) { out.push(err('button_text_too_long', 'buttons', { max: META_LIMITS.QR_TEXT_MAX })); break; }
  }
  for (const x of b) {
    if (x.type === 'URL') {
      if (len(x.url) > META_LIMITS.URL_LEN_MAX) out.push(err('url_too_long', 'buttons', { max: META_LIMITS.URL_LEN_MAX }));
      if (/\{\{/.test(x.url)) {
        if (!/^[^{}]*\{\{1\}\}$/.test(x.url)) out.push(err('url_variable_position', 'buttons'));
        else if ((x.example ?? '').trim() === '') out.push(err('example_missing', 'examples', { index: 1 }));
      }
    }
    if (x.type === 'PHONE_NUMBER' && len(x.phone) > META_LIMITS.PHONE_NUM_MAX) out.push(err('phone_number_length', 'buttons', { max: META_LIMITS.PHONE_NUM_MAX }));
    if (x.type === 'COPY_CODE' && len(x.example) > META_LIMITS.COPY_EXAMPLE_MAX) out.push(err('copy_example_too_long', 'buttons', { max: META_LIMITS.COPY_EXAMPLE_MAX }));
  }
  // Meta wants quick replies and the other types in TWO contiguous groups: more than one switch between kinds is a rejection.
  let switches = 0;
  for (let i = 1; i < b.length; i++) if ((b[i]!.type === 'QUICK_REPLY') !== (b[i - 1]!.type === 'QUICK_REPLY')) switches++;
  if (switches > 1) out.push(err('qr_groups', 'buttons'));
  return out;
}

const URL_OR_EMOJI = /https?:\/\/|www\.|\p{Extended_Pictographic}/u;
function authRules(d: TemplateDraft): RuleIssue[] {
  if (d.category !== 'AUTHENTICATION') return [];
  const out: RuleIssue[] = [];
  const texts = [d.header?.text, d.body.text, d.footer, ...d.buttons.map((x) => (x.type === 'COPY_CODE' ? x.example : x.text))].filter((x): x is string => !!x);
  if (texts.some((x) => URL_OR_EMOJI.test(x))) out.push(err('auth_forbidden_content', 'body'));
  const m = d.auth?.expiryMinutes;
  if (m != null && (!Number.isInteger(m) || m < META_LIMITS.AUTH_EXPIRY_MIN || m > META_LIMITS.AUTH_EXPIRY_MAX)) out.push(err('auth_expiry_range', 'category', { min: META_LIMITS.AUTH_EXPIRY_MIN, max: META_LIMITS.AUTH_EXPIRY_MAX }));
  return out;
}

const PROMO = /خصم|عرض|تخفيض|%\s*off|\bsale\b|\bdiscount\b/i;
function promoRules(d: TemplateDraft): RuleIssue[] {
  if (d.category !== 'UTILITY') return [];
  return PROMO.test([d.header?.text, d.body.text, d.footer].filter(Boolean).join(' ')) ? [warn('category_looks_promotional', 'category')] : [];
}

function duplicateRules(d: TemplateDraft, existing: ExistingTemplate[]): RuleIssue[] {
  if (d.category === 'AUTHENTICATION') return [];
  const same = existing.some((e) => !(e.name === d.name && e.language === d.language) && e.bodyText === d.body.text && (e.footer ?? null) === (d.footer ?? null));
  return same ? [err('duplicate_body', 'body')] : [];
}

/** Everything Meta's documented rules let us tell the merchant BEFORE submitting. Errors block; warnings are advice. */
export function checkTemplate(d: TemplateDraft, existing: ExistingTemplate[] = []): RuleIssue[] {
  return [...nameRules(d), ...bodyRules(d), ...headerRules(d), ...footerRules(d), ...buttonRules(d), ...authRules(d), ...promoRules(d), ...duplicateRules(d, existing)];
}
