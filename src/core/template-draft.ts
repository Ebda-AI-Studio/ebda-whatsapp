import type { StoredComponent } from './templates';

/** What the Templates screen and the Smart Layer edit. One shape, turned into Meta's components by `toMetaComponents`. */
export type DraftButton =
  | { type: 'QUICK_REPLY'; text: string }
  | { type: 'URL'; text: string; url: string; example?: string }
  | { type: 'PHONE_NUMBER'; text: string; phone: string }
  | { type: 'COPY_CODE'; example: string };

export type TemplateDraft = {
  name: string;
  label: string;
  /** `ar` / `en` for new templates; a template made in WhatsApp Manager can carry another Meta language code and still opens for edit. */
  language: string;
  category: 'UTILITY' | 'MARKETING' | 'AUTHENTICATION';
  header: { text: string; example?: string } | null;
  body: { text: string; examples: string[] };
  footer: string | null;
  buttons: DraftButton[];
  auth?: { expiryMinutes: number | null; securityRecommendation: boolean };
};

const OTP_BUTTON_TEXT = { ar: 'نسخ الكود', en: 'Copy code' } as const;
const hasVar = (s: string) => /\{\{\s*\d+\s*\}\}/.test(s);

/** Meta's `components` for a draft. AUTHENTICATION is Meta's fixed form (no body text), exactly like the shipped `otp_code` default. */
export function toMetaComponents(d: TemplateDraft): unknown[] {
  if (d.category === 'AUTHENTICATION') {
    const footer = d.auth?.expiryMinutes != null ? [{ type: 'FOOTER', code_expiration_minutes: d.auth.expiryMinutes }] : [];
    return [
      { type: 'BODY', add_security_recommendation: d.auth?.securityRecommendation ?? false },
      ...footer,
      { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: OTP_BUTTON_TEXT[d.language.startsWith('ar') ? 'ar' : 'en'] }] },
    ];
  }
  const out: unknown[] = [];
  if (d.header) out.push({ type: 'HEADER', format: 'TEXT', text: d.header.text, ...(hasVar(d.header.text) && d.header.example !== undefined ? { example: { header_text: [d.header.example] } } : {}) });
  out.push({ type: 'BODY', text: d.body.text, ...(hasVar(d.body.text) ? { example: { body_text: [d.body.examples] } } : {}) });
  if (d.footer) out.push({ type: 'FOOTER', text: d.footer });
  if (d.buttons.length > 0) {
    out.push({
      type: 'BUTTONS',
      buttons: d.buttons.map((b) => {
        switch (b.type) {
          case 'QUICK_REPLY': return { type: 'QUICK_REPLY', text: b.text };
          case 'URL': return { type: 'URL', text: b.text, url: b.url, ...(b.example !== undefined ? { example: [b.example] } : {}) };
          case 'PHONE_NUMBER': return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone };
          case 'COPY_CODE': return { type: 'COPY_CODE', example: b.example };
        }
      }),
    });
  }
  return out;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The draft behind a stored template (what Meta returned), so the editor can open it. Fields we do not model are dropped. */
export function fromStoredComponents(c: StoredComponent[], meta: { name: string; language: string; category: string; label: string | null }): TemplateDraft {
  const find = (t: string) => c.find((x) => x.type.toUpperCase() === t);
  const category = (['UTILITY', 'MARKETING', 'AUTHENTICATION'].includes(meta.category) ? meta.category : 'UTILITY') as TemplateDraft['category'];
  const base = { name: meta.name, label: meta.label ?? meta.name, language: meta.language, category };
  if (category === 'AUTHENTICATION') {
    const expiry = (find('FOOTER') as { code_expiration_minutes?: unknown } | undefined)?.code_expiration_minutes;
    const sec = (find('BODY') as { add_security_recommendation?: unknown } | undefined)?.add_security_recommendation;
    return { ...base, header: null, body: { text: '', examples: [] }, footer: null, buttons: [], auth: { expiryMinutes: typeof expiry === 'number' ? expiry : null, securityRecommendation: sec === true } };
  }
  const h = find('HEADER') as (StoredComponent & { example?: { header_text?: unknown[] } }) | undefined;
  const b = find('BODY') as (StoredComponent & { example?: { body_text?: unknown[][] } }) | undefined;
  const header = h && (h.format ?? 'TEXT').toUpperCase() === 'TEXT' ? { text: str(h.text), ...(h.example?.header_text?.[0] !== undefined ? { example: str(h.example.header_text[0]) } : {}) } : null;
  const buttons: DraftButton[] = [];
  for (const x of find('BUTTONS')?.buttons ?? []) {
    const t = str(x.type).toUpperCase();
    const bx = x as Record<string, unknown>;
    if (t === 'QUICK_REPLY') buttons.push({ type: 'QUICK_REPLY', text: str(bx.text) });
    else if (t === 'URL') buttons.push({ type: 'URL', text: str(bx.text), url: str(bx.url), ...(Array.isArray(bx.example) && bx.example.length > 0 ? { example: str(bx.example[0]) } : {}) });
    else if (t === 'PHONE_NUMBER') buttons.push({ type: 'PHONE_NUMBER', text: str(bx.text), phone: str(bx.phone_number) });
    else if (t === 'COPY_CODE') buttons.push({ type: 'COPY_CODE', example: str(bx.example) });
  }
  return { ...base, header, body: { text: str(b?.text), examples: (b?.example?.body_text?.[0] ?? []).map(str) }, footer: find('FOOTER')?.text ?? null, buttons };
}

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonical(x)]));
  return v;
};

/** Hex SHA-256 of the draft's canonical JSON (keys sorted). What the merchant (or the assistant) confirmed is what gets submitted. */
export async function payloadHash(d: TemplateDraft): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(canonical(d)));
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((x) => x.toString(16).padStart(2, '0')).join('');
}
