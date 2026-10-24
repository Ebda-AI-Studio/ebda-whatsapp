import { z } from 'zod';
import type { TemplateComponent } from './meta/client';

const button = z.object({ type: z.string(), text: z.string().optional(), url: z.string().optional() }).loose();
/** Meta's stored template components (what GET /{waba}/message_templates returns). Permissive: Meta adds fields often. */
export const componentSchema = z.object({
  type: z.string(),
  format: z.string().optional(),
  text: z.string().optional(),
  buttons: z.array(button).optional(),
}).loose();
export const componentsSchema = z.array(componentSchema);
export type StoredComponent = z.infer<typeof componentSchema>;

const MEDIA_HEADERS = ['IMAGE', 'VIDEO', 'DOCUMENT'] as const;
const MAX_PARAM_CHARS = 1024;

/** Highest numeric placeholder ({{1}}, {{2}}…) in `text`; 0 when there is none. */
export function placeholderCount(text: string | undefined): number {
  let max = 0;
  for (const m of (text ?? '').matchAll(/\{\{\s*(\d+)\s*\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

const find = (components: StoredComponent[], type: string) => components.find((c) => c.type.toUpperCase() === type);

/**
 * Authentication templates carry Meta's fixed text and a copy-code button; a send supplies just the code. Decided by
 * Meta's template CATEGORY, never by the button shape (Meta returns copy-code buttons as type URL, not OTP).
 */
const isOtp = (category: string) => category.toUpperCase() === 'AUTHENTICATION';
/** Index of the copy-code button among the template's buttons (the code goes there as well as in the body). */
const otpButtonIndex = (components: StoredComponent[]) => Math.max(0, (find(components, 'BUTTONS')?.buttons ?? []).findIndex((b) => ['OTP', 'URL'].includes(b.type.toUpperCase())));
/** What the inbox shows for an OTP send: the code must never be stored or displayed. */
export const OTP_MASK = '••••••';

/** Total parameters a send must supply, in order: header, body, then each URL button that has a placeholder. */
export function paramCount(components: StoredComponent[], category: string): number {
  if (isOtp(category)) return 1;
  const header = find(components, 'HEADER');
  let n = 0;
  if (header) {
    const f = (header.format ?? 'TEXT').toUpperCase();
    n += f === 'TEXT' ? placeholderCount(header.text) : (MEDIA_HEADERS as readonly string[]).includes(f) ? 1 : 0;
  }
  n += placeholderCount(find(components, 'BODY')?.text);
  for (const b of find(components, 'BUTTONS')?.buttons ?? []) if (b.type.toUpperCase() === 'URL' && placeholderCount(b.url) > 0) n++;
  return n;
}

export function bodyTextOf(components: StoredComponent[]): string {
  return find(components, 'BODY')?.text ?? '';
}

export type RenderResult = { ok: true; components: TemplateComponent[]; text: string } | { ok: false; message: string };

const badText = (s: string) => s.length === 0 || s.length > MAX_PARAM_CHARS || /[\n\t]/.test(s) || / {4,}/.test(s);

/** Validates `params` against the stored template and builds the Graph `components` array plus the text shown in the inbox. */
export function renderTemplate(stored: StoredComponent[], params: string[], category: string): RenderResult {
  const expected = paramCount(stored, category);
  if (params.length !== expected) return { ok: false, message: `template needs ${expected} parameters, got ${params.length}` };
  if (isOtp(category)) {
    const code = params[0]!;
    if (!/^[A-Za-z0-9]{1,15}$/.test(code)) return { ok: false, message: 'an OTP code is 1 to 15 letters or digits' };
    return {
      ok: true,
      text: OTP_MASK,
      components: [
        { type: 'body', parameters: [{ type: 'text', text: code }] },
        { type: 'button', sub_type: 'url', index: String(otpButtonIndex(stored)), parameters: [{ type: 'text', text: code }] },
      ],
    };
  }
  const header = find(stored, 'HEADER');
  const headerFormat = (header?.format ?? 'TEXT').toUpperCase();
  if (header && headerFormat !== 'TEXT' && !(MEDIA_HEADERS as readonly string[]).includes(headerFormat)) {
    return { ok: false, message: `header format ${headerFormat} is not supported` };
  }
  const out: TemplateComponent[] = [];
  let i = 0;
  if (header) {
    if (headerFormat === 'TEXT') {
      const n = placeholderCount(header.text);
      if (n > 0) {
        const mine = params.slice(i, i + n);
        i += n;
        if (mine.some(badText)) return { ok: false, message: 'a header parameter is empty, too long or contains a newline/tab' };
        out.push({ type: 'header', parameters: mine.map((text) => ({ type: 'text', text })) });
      }
    } else {
      const link = params[i++]!;
      if (!/^https:\/\/[^\s]+$/.test(link)) return { ok: false, message: 'a media header needs an https link' };
      const kind = headerFormat.toLowerCase();
      out.push({ type: 'header', parameters: [{ type: kind, [kind as 'image']: { link } }] });
    }
  }
  const bodyText = find(stored, 'BODY')?.text ?? '';
  const nb = placeholderCount(bodyText);
  const bodyParams = params.slice(i, i + nb);
  i += nb;
  if (bodyParams.some(badText)) return { ok: false, message: 'a body parameter is empty, too long or contains a newline/tab' };
  if (nb > 0) out.push({ type: 'body', parameters: bodyParams.map((text) => ({ type: 'text', text })) });
  const buttons = find(stored, 'BUTTONS')?.buttons ?? [];
  buttons.forEach((b, index) => {
    if (b.type.toUpperCase() !== 'URL' || placeholderCount(b.url) === 0) return;
    out.push({ type: 'button', sub_type: 'url', index: String(index), parameters: [{ type: 'text', text: params[i++]! }] });
  });
  const urlParams = out.filter((c) => c.type === 'button').flatMap((c) => c.parameters);
  if (urlParams.some((p) => !p.text || /\s/.test(p.text) || p.text.length > 2000)) return { ok: false, message: 'a URL button parameter is empty or contains whitespace' };
  const text = bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_m, n: string) => bodyParams[Number(n) - 1] ?? '');
  return { ok: true, components: out, text };
}
