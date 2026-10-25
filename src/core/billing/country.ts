/** The market a message is billed in, from the recipient's calling code (digits, no +). Unknown codes bill as 'ROW' (rest of world). */
const CODES: Record<string, string> = {
  '20': 'EG', '966': 'SA', '971': 'AE', '965': 'KW', '974': 'QA', '973': 'BH', '968': 'OM', '962': 'JO', '961': 'LB', '964': 'IQ',
  '212': 'MA', '213': 'DZ', '216': 'TN', '218': 'LY', '249': 'SD', '967': 'YE', '963': 'SY', '970': 'PS', '90': 'TR', '44': 'GB',
  '49': 'DE', '33': 'FR', '39': 'IT', '34': 'ES', '31': 'NL', '91': 'IN', '92': 'PK', '62': 'ID', '234': 'NG', '27': 'ZA', '254': 'KE',
};
const BY_LENGTH = [3, 2] as const;

export function countryOf(waId: string): string {
  const digits = waId.replace(/\D/g, '');
  for (const n of BY_LENGTH) {
    const hit = CODES[digits.slice(0, n)];
    if (hit) return hit;
  }
  return digits.startsWith('1') ? 'US' : 'ROW';
}

/** A calling-code prefix for a market code (the inverse of `countryOf`), so an estimate can be priced from a market alone. */
export function countryToDigits(country: string): string {
  if (country === 'US') return '1';
  const hit = Object.entries(CODES).find(([, iso]) => iso === country);
  return hit ? hit[0] : '000';
}
