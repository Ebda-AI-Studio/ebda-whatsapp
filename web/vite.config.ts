import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { defineConfig } from 'vite';

// The brand pack is chosen at build time: BRAND=<id> npm run build:web (default: ebda). An unknown brand fails the build.
const brand = process.env.BRAND ?? 'ebda';
const brandDir = join(import.meta.dirname, 'brands', brand);
if (!existsSync(join(brandDir, 'brand.ts'))) throw new Error(`BRAND "${brand}" has no web/brands/${brand}/brand.ts`);

export default defineConfig({
  root: import.meta.dirname,
  plugins: [
    react(),
    {
      name: 'brand-html',
      async transformIndexHtml(html) {
        const { BRAND } = (await import(join(brandDir, 'brand.ts'))) as { BRAND: { productName: string; appleTouchIcon: string | null } };
        return html
          .replaceAll('%PRODUCT_NAME%', BRAND.productName)
          .replace('%APPLE_TOUCH%', BRAND.appleTouchIcon ? `<link rel="apple-touch-icon" href="${BRAND.appleTouchIcon}" />` : '');
      },
    },
  ],
  // Each brand ships its own static files: mark, favicon and _headers (its CSP names its own sign-in host).
  publicDir: join(brandDir, 'public'),
  resolve: { alias: { '@brand': join(brandDir, 'brand.ts'), '@brand-tokens': join(brandDir, 'tokens.css') } },
  build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', sourcemap: false },
});
