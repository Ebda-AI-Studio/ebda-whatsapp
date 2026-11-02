/**
 * Phone normalisation for every Ebda product. Canonical source: Ebda Chat's `normaliseE164` (audit CODE-10: two normalisers that
 * differ give one customer two buyer keys). Do not "improve" it in a consumer; change it here and re-run `vectors/phone.json`.
 */
const E164 = /^\+[1-9]\d{7,14}$/;
// LRM/RLM, ALM, embeddings/overrides and isolates that WhatsApp's RTL UI adds around numbers.
const BIDI_MARKS = /[‎‏؜‪-‮⁦-⁩]/g;

/** Arabic-Indic (U+0660-9) and Persian (U+06F0-9) digits turned into 0-9. */
export function asciiDigits(s: string): string {
  return s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** Egyptian fixed-line area codes (without the trunk 0) besides Cairo/Giza 2 and Alexandria 3 (Ruling PHONE-2). */
const EG_AREA_3 = new Set(['13', '15', '40', '45', '46', '47', '48', '50', '55', '57', '62', '64', '65', '66', '68', '69', '82', '84', '86', '88', '92', '93', '95', '96', '97']);

/**
 * Is `national` (trunk 0 + digits, nothing else) a valid Egyptian number? Mobile `01[0125]` + 8 digits; Cairo/Giza `02` + 8;
 * Alexandria `03` + 7; a governorate code (`EG_AREA_3`) + 7.
 */
export function isEgyptianNational(national: string): boolean {
  if (/^01[0125]\d{8}$/.test(national)) return true;
  if (/^02\d{8}$/.test(national)) return true;
  if (/^03\d{7}$/.test(national)) return true;
  const m = /^0(\d{2})\d{7}$/.exec(national);
  return !!m && EG_AREA_3.has(m[1]!);
}

/**
 * Normalises a phone number to E.164 (the buyerKey input in every suite product: shared vectors in `vectors/phone.json`).
 * Without a `+`/`00` prefix only VALID Egyptian numbers are accepted (Ruling PHONE-2): national `0…`, `20…` (12 digits) or a
 * 10-digit mobile typed without its 0, each checked against the Egyptian number plan. A UK `07911…` or a Saudi `050…` that is
 * not an Egyptian shape returns null rather than becoming +20; a foreign number must carry `+` or `00`.
 */
export function normaliseE164(input: string, defaultCountry: '20' = '20'): string | null {
  let s = asciiDigits(input.replace(BIDI_MARKS, '')).replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) {
    if (s.startsWith('0')) {
      if (!isEgyptianNational(s)) return null;
      s = `+${defaultCountry}${s.slice(1)}`;
    } else if (s.startsWith(defaultCountry) && s.length === 12) {
      if (!isEgyptianNational(`0${s.slice(2)}`)) return null;
      s = '+' + s;
    } else if (/^1\d{9}$/.test(s)) {
      if (!isEgyptianNational(`0${s}`)) return null;
      s = `+${defaultCountry}${s}`;
    } else return null;
  }
  // A trunk 0 kept after the country code (+20 0100…) is dropped.
  if (s.startsWith(`+${defaultCountry}0`)) s = `+${defaultCountry}${s.slice(defaultCountry.length + 2)}`;
  return E164.test(s) ? s : null;
}

export function isE164(s: string): boolean {
  return E164.test(s);
}
