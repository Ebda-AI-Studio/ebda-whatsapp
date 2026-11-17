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

/**
 * Design language v1 (ruling DS-FONT-1 + docs: design/DESIGN.md). One family for every Ebda surface; merchant storefront
 * looks keep their own fonts. Plex Sans Arabic carries Arabic AND Latin (same face, uniform tabular digits).
 */
export const FONT = {
  family: 'IBM Plex Sans Arabic',
  stack: '"IBM Plex Sans Arabic", system-ui, -apple-system, "Segoe UI", sans-serif',
  weights: [400, 500, 600, 700],
  subsets: ['arabic', 'latin'],
} as const;

/** Type scale: px and the [latin, arabic] leading in px. Arabic needs more leading (marks and ascenders); never letter-spacing on Arabic. */
export const TYPE = {
  caption: { px: 12, leading: [16, 20] },
  ui: { px: 14, leading: [20, 24] },
  body: { px: 16, leading: [24, 28] },
  titleSm: { px: 18, leading: [24, 30] },
  title: { px: 20, leading: [28, 32] },
  kpi: { px: 24, leading: [32, 36] },
  display: { px: 30, leading: [36, 44] },
} as const;

/** 4px base. */
export const SPACE = [4, 8, 12, 16, 24, 32, 48] as const;

/** Radii in px: control (buttons, inputs, nav items, tabs), surface (cards, popovers, modals), pill. */
export const RADIUS = { control: 12, surface: 14, pill: 9999 } as const;

/** Interactive control heights in px. md is 44 on phones. */
export const CONTROL = { sm: 32, md: 40, mdPhone: 44, lg: 44 } as const;
export const NAV = {
  sidebar: 44,
  tab: 40,
  tabPhone: 44,
  rail: 40,
  bottom: 56,
} as const;

/** Elevation: 0 flat hairline (default), 1 cards, 2 menus and popovers, 3 modals and sheets. No coloured shadows. */
export const ELEVATION = [
  'none',
  '0 1px 2px 0 rgb(0 0 0 / 0.03)',
  '0 4px 6px -1px rgb(0 0 0 / 0.05), 0 2px 4px -2px rgb(0 0 0 / 0.03)',
  '0 20px 25px -5px rgb(0 0 0 / 0.06), 0 8px 10px -6px rgb(0 0 0 / 0.03)',
] as const;

/** Motion: ms and the one easing. Slides mirror in RTL; reduced-motion removes them. */
export const MOTION = {
  fast: 150,
  base: 200,
  slow: 300,
  ease: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

/** z-index ladder. */
export const Z = {
  sticky: 10,
  header: 20,
  bottomBar: 30,
  drawer: 40,
  modal: 50,
  toast: 60,
} as const;
