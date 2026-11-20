import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';
import { shareHead } from './brands/share-head';
import type { WebBrand } from './brands/types';

// The brand pack is chosen at build time: BRAND=<id> npm run build:web (default: ebda). An unknown brand fails the build.
const brand = process.env.BRAND ?? 'ebda';
const brandDir = join(import.meta.dirname, 'brands', brand);
if (!existsSync(join(brandDir, 'brand.ts'))) throw new Error(`BRAND "${brand}" has no web/brands/${brand}/brand.ts`);

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    {
      // Stamps which brand this build is for: the white-label deploy and scripts/verify-prod.mjs refuse a page built for another one.
      name: 'brand-stamp',
      async generateBundle() {
        // A brand on its own OIDC provider also stamps the issuer, so the deploy kit can prove the CSP and the Worker's config name the same one.
        const { BRAND } = (await import(join(brandDir, 'brand.ts'))) as { BRAND: { oidc?: { issuer: string } | null } };
        this.emitFile({ type: 'asset', fileName: 'brand.json', source: JSON.stringify({ brand, ...(BRAND.oidc ? { oidcIssuer: BRAND.oidc.issuer } : {}) }) });
      },
    },
    {
      name: 'brand-html',
      async transformIndexHtml(html) {
        const { BRAND } = (await import(join(brandDir, 'brand.ts'))) as { BRAND: WebBrand };
        return html
          .replaceAll('%PRODUCT_NAME%', BRAND.productNameAr ? `${BRAND.productNameAr} | ${BRAND.productName}` : BRAND.productName)
          .replace('%APPLE_TOUCH%', BRAND.appleTouchIcon ? `<link rel="apple-touch-icon" href="${BRAND.appleTouchIcon}" />` : '')
          // A function, so a `$` in the copy is never read as a replacement pattern.
          .replace('%SHARE_HEAD%', () => shareHead(BRAND));
      },
    },
  ],
  // Each brand ships its own static files: mark, favicon and _headers (its CSP names its own sign-in host).
  publicDir: join(brandDir, 'public'),
  resolve: { alias: { '@brand': join(brandDir, 'brand.ts'), '@brand-tokens': join(brandDir, 'tokens.css') } },
  build: {
    outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false,
    // CHAT-QA-8: Vite inlined the small @fontsource subsets as `url(data:font/...)`, and the page CSP says `font-src 'self'`, so the browser's
    // 6 data: font loads were blocked on every first visit. Fonts are always emitted as files (same origin); other small assets may still inline.
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
  },
});
