import type { WebBrand } from './types';

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const attr = (s: string) => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);

/**
 * The tags a shared link is read from (a chat preview, a search result): description, canonical, Open Graph, the large card and one
 * JSON-LD block. Built once per brand at build time (web/vite.config.ts puts it where web/index.html says %SHARE_HEAD%), because the page
 * itself is an empty shell until the script runs and a link preview never runs it. A brand with no `share` gets nothing: a client's page
 * must not carry another company's description or address.
 */
export function shareHead(brand: Pick<WebBrand, 'share'>): string {
  const s = brand.share;
  if (!s) return '';
  const image = new URL(s.image.path, s.url).href;
  const meta = (key: 'name' | 'property', k: string, v: string) => `<meta ${key}="${k}" content="${attr(v)}" />`;
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'WebApplication',
    name: s.name,
    ...(s.alternateName ? { alternateName: s.alternateName } : {}),
    url: s.url,
    description: s.description,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    inLanguage: s.languages,
    image,
    publisher: { '@type': 'Organization', name: s.publisher.name, url: s.publisher.url },
  };
  return [
    meta('name', 'description', s.description),
    `<link rel="canonical" href="${attr(s.url)}" />`,
    meta('property', 'og:type', 'website'),
    meta('property', 'og:site_name', s.name),
    meta('property', 'og:title', s.title),
    meta('property', 'og:description', s.description),
    meta('property', 'og:url', s.url),
    meta('property', 'og:locale', s.locale),
    ...(s.alternateLocale ? [meta('property', 'og:locale:alternate', s.alternateLocale)] : []),
    meta('property', 'og:image', image),
    meta('property', 'og:image:type', 'image/png'),
    meta('property', 'og:image:width', String(s.image.width)),
    meta('property', 'og:image:height', String(s.image.height)),
    meta('property', 'og:image:alt', s.image.alt),
    meta('name', 'twitter:card', 'summary_large_image'),
    meta('name', 'twitter:title', s.title),
    meta('name', 'twitter:description', s.description),
    meta('name', 'twitter:image', image),
    meta('name', 'twitter:image:alt', s.image.alt),
    // A data block, not a script the page runs; `<` is written as an escape so no value can close the element early.
    `<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`,
  ].join('\n    ');
}
