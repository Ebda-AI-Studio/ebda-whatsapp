/** Design tokens of the Ebda brand, mirrored from `tokens.css` (a unit test keeps the two equal and rejects any orange hue). */
export const TOKENS = {
  night: '#0A0B0C',
  gold: '#B08D57',
  lift: '#CBA873',
  cream: '#FAF8F3',
  appIconRadius: '22.37%',
} as const;

/** Hue (degrees) and saturation (0-1) of a `#rrggbb` colour. */
export function hueSat(hex: string): { hue: number; sat: number } {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0 };
  const l = (max + min) / 2;
  const sat = d / (1 - Math.abs(2 * l - 1));
  let h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { hue: h, sat };
}

/** Orange = hue 20-40 degrees with high saturation (>0.8). Brass/antique gold (hue ~38, sat ~0.35) is metal, not orange (Ruling METAL-1). */
export function isOrange(hex: string): boolean {
  const { hue, sat } = hueSat(hex);
  return hue >= 20 && hue <= 40 && sat > 0.8;
}
