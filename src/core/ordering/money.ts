/** Money is integer minor units (piasters) everywhere; these two functions are the only places text meets it. */

/** 75000 -> "750", 75050 -> "750.50". */
export function plainAmount(minor: number): string {
  const sign = minor < 0 ? '-' : '';
  const abs = Math.abs(minor);
  const major = Math.floor(abs / 100);
  const rest = abs % 100;
  return rest === 0 ? `${sign}${major}` : `${sign}${major}.${String(rest).padStart(2, '0')}`;
}

/** "750", "750.5", "750.50" or a number -> 75000 / 75050; null for anything else (no float arithmetic on money). */
export function parseMinor(value: string | number): number | null {
  const m = /^(\d{1,9})(?:\.(\d{1,2})\d*)?$/.exec(String(value).trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'));
}
