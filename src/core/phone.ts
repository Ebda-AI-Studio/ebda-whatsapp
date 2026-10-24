const E164 = /^\+[1-9]\d{7,14}$/;
// LRM/RLM, ALM, embeddings/overrides and isolates that WhatsApp's RTL UI adds around numbers.
const BIDI_MARKS = /[‎‏؜‪-‮⁦-⁩]/g;

function asciiDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Normalises a phone number to E.164. Without a `+`/`00` prefix only Egyptian forms are accepted:
 * national `0…`, `20…` (12 digits) or a 10-digit mobile typed without its leading 0. Anything else returns null
 * rather than guessing a country.
 */
export function normaliseE164(input: string, defaultCountry: '20' = '20'): string | null {
  let s = asciiDigits(input.replace(BIDI_MARKS, '')).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    if (s.startsWith('0')) s = `+${defaultCountry}${s.slice(1)}`;
    else if (s.startsWith(defaultCountry) && s.length === 12) s = '+' + s;
    else if (/^1\d{9}$/.test(s)) s = `+${defaultCountry}${s}`;
    else return null;
  }
  // A trunk 0 kept after the country code (+20 0100…) is dropped.
  if (s.startsWith(`+${defaultCountry}0`)) s = `+${defaultCountry}${s.slice(defaultCountry.length + 2)}`;
  return E164.test(s) ? s : null;
}

export function isE164(s: string): boolean {
  return E164.test(s);
}
