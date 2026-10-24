const E164 = /^\+[1-9]\d{7,14}$/;

function asciiDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Normalises a phone number to E.164. National numbers (leading 0) take `defaultCountry` (Egypt).
 * Returns null when the result is not a plausible E.164 number.
 */
export function normaliseE164(input: string, defaultCountry: '20' = '20'): string | null {
  let s = asciiDigits(input).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    if (s.startsWith('0')) s = `+${defaultCountry}${s.slice(1)}`;
    else if (s.startsWith(defaultCountry) && s.length === 12) s = '+' + s;
    else s = '+' + s;
  }
  return E164.test(s) ? s : null;
}

export function isE164(s: string): boolean {
  return E164.test(s);
}
