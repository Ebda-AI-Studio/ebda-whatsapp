import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';

// wrangler.jsonc allows comments; strip line comments before parsing.
const cfg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, ''));

it('serves the inbox SPA from web/dist; an unknown path is NOT answered with the shell (WA-404-1: the Worker 404s it)', () => {
  expect(cfg.assets).toMatchObject({ directory: 'web/dist', binding: 'ASSETS', not_found_handling: 'none' });
});

it('keeps the API, Meta webhook, the card provider\'s webhook (/kashier/*), health and tracked links (/t/*) on the Worker', () => {
  // /kashier/* must be here: otherwise the SPA fallback answers the provider's POST with HTML and no payment is ever confirmed (iceberg C1).
  expect(cfg.assets.run_worker_first).toEqual(['/api/*', '/meta/*', '/kashier/*', '/health', '/t/*']);
});

it('serves the SPA with security headers: CSP limited to itself and the identity host, no framing, HSTS, nosniff', () => {
  const headers = readFileSync(join(import.meta.dirname, '..', 'web', 'brands', 'ebda', 'public', '_headers'), 'utf8');
  expect(headers).toMatch(/^\/\*$/m);
  const csp = /Content-Security-Policy: (.+)$/m.exec(headers)?.[1] ?? '';
  expect(csp).toContain("default-src 'self'");
  // Scripts: the page's own, Meta's signup SDK, and the edge-added analytics beacon (pre-QA finding 3: the policy refused it, so no visit was counted).
  expect(csp).toContain("script-src 'self' https://connect.facebook.net https://static.cloudflareinsights.com;");
  expect(csp).toContain('frame-src https://*.facebook.com');
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("connect-src 'self' https://accounts.ebda.app https://*.facebook.com;"); // the beacon reports same-origin: no analytics host here
  expect(csp).not.toContain('unsafe-eval');
  expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  expect(headers).toMatch(/Strict-Transport-Security: max-age=\d{8,}/);
  expect(headers).toContain('X-Content-Type-Options: nosniff');
  expect(headers).toContain('Referrer-Policy: strict-origin-when-cross-origin');
});

it('a shared link to the suite page has a preview: description, canonical, Open Graph image and structured data, all from the brand (pre-QA finding 3)', async () => {
  const { shareHead } = await import('../web/brands/share-head');
  const { BRAND } = await import('../web/brands/ebda/brand');
  const head = shareHead(BRAND);
  const content = (key: string) => new RegExp(`<meta (?:name|property)="${key}" content="([^"]*)" />`).exec(head)?.[1];
  expect(content('description')).toBe(BRAND.share?.description);
  expect((content('description') ?? '').length).toBeGreaterThanOrEqual(70);
  expect((content('description') ?? '').length).toBeLessThanOrEqual(200);
  expect(head).toContain('<link rel="canonical" href="https://wa.ebda.app/" />');
  expect(content('og:url')).toBe('https://wa.ebda.app/');
  expect(content('og:title')).toBe('ابدأ شات | Ebda Chat');
  expect(content('og:site_name')).toBe('Ebda Chat');
  expect(content('og:locale')).toBe('ar_EG');
  expect(content('twitter:card')).toBe('summary_large_image');
  // The image is an absolute address on the page's own origin, and the file is there at the size the tags declare.
  const image = content('og:image') ?? '';
  expect(image).toBe('https://wa.ebda.app/brand/og-chat.png');
  expect(content('twitter:image')).toBe(image);
  const png = readFileSync(join(import.meta.dirname, '..', 'web', 'brands', 'ebda', 'public', new URL(image).pathname));
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  expect([content('og:image:width'), content('og:image:height')]).toEqual(['1200', '630']);
  expect(content('og:image:alt')).toBeTruthy();
  // One JSON-LD block that parses: the product by its name, the studio by its public name, never the registered legal name.
  const ld = JSON.parse(/<script type="application\/ld\+json">(.+?)<\/script>/.exec(head)?.[1] ?? 'null');
  expect(ld).toMatchObject({ '@type': 'WebApplication', name: 'Ebda Chat', alternateName: 'ابدأ شات', url: 'https://wa.ebda.app/', publisher: { '@type': 'Organization', name: 'Ebda AI Studio' } });
  // The registered names come from the vendored studio brand, so this fails the day either of them reaches the share tags.
  const { BRAND: STUDIO } = await import('../vendor/studio/brand/index');
  expect(STUDIO.company.legalNameAr).toBeTruthy();
  for (const legal of [STUDIO.company.legalNameAr, STUDIO.company.legalNameEn]) expect(head).not.toContain(legal);
  expect(ld.publisher.name).toBe(STUDIO.company.shortNameEn);
  // Copy rule: no supplier is named (the old product names are refused repo-wide by test/guards.test.ts).
  expect(JSON.stringify(BRAND.share)).not.toMatch(/cloudflare|gemini|openai|anthropic|\bmeta\b|facebook|ميتا|فيسبوك/i);
});

it('the share tags are written into the built page from one placeholder, and a brand with no share config gets none of them', async () => {
  const { shareHead } = await import('../web/brands/share-head');
  const html = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
  expect(html.split('%SHARE_HEAD%').length).toBe(2);
  expect(html.indexOf('%SHARE_HEAD%')).toBeLessThan(html.indexOf('</head>'));
  // Behaviour, not source text: run the build's own HTML step on the real page and read what it writes.
  const { default: viteConfig } = await import('../web/vite.config');
  const step = (viteConfig as { plugins: { name?: string; transformIndexHtml?: (h: string) => Promise<string> }[] }).plugins.flat().find((p) => p?.name === 'brand-html');
  const { BRAND } = await import('../web/brands/ebda/brand');
  const built = await step!.transformIndexHtml!(html);
  expect(built).not.toContain('%SHARE_HEAD%');
  expect(built.split(shareHead(BRAND)).length).toBe(2);
  expect(built.indexOf(shareHead(BRAND))).toBeLessThan(built.indexOf('</head>'));
  const { BRAND: demo } = await import('../web/brands/demo/brand');
  expect(demo.share).toBeUndefined();
  expect(shareHead(demo)).toBe('');
});

it('share copy cannot break out of its attribute or the structured-data block', async () => {
  const { shareHead } = await import('../web/brands/share-head');
  const hostile = '"><script>alert(1)</script> & \'x\' $& </script>';
  const head = shareHead({ share: { url: 'https://inbox.client.example/', name: hostile, title: hostile, description: hostile, locale: 'en_US', languages: ['en'], image: { path: '/brand/og.png', width: 1200, height: 630, alt: hostile }, publisher: { name: hostile, url: 'https://client.example' } } });
  expect(head).not.toContain('<script>alert');
  expect(head.match(/<\/script>/g)?.length).toBe(1);
  expect(head).toContain('&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt; &amp; &#39;x&#39; $&amp; &lt;/script&gt;');
  expect(head.match(/<script/g)?.length).toBe(1);
  const ld = JSON.parse(/<script type="application\/ld\+json">(.+?)<\/script>/.exec(head)?.[1] ?? 'null');
  expect(ld.name).toBe(hostile);
  expect(head).not.toMatch(/og:locale:alternate|alternateName/);
});

it('every brand ships its own _headers with the same base policy, and only the suite brand names its accounts host', () => {
  const brands = readdirSync(join(import.meta.dirname, '..', 'web', 'brands'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  expect(brands).toEqual(expect.arrayContaining(['ebda', 'demo']));
  for (const b of brands) {
    const h = readFileSync(join(import.meta.dirname, '..', 'web', 'brands', b, 'public', '_headers'), 'utf8');
    const csp = /Content-Security-Policy: (.+)$/m.exec(h)?.[1] ?? '';
    for (const part of ["default-src 'self'", "frame-ancestors 'none'", "object-src 'none'"]) expect(csp, b).toContain(part);
    expect(h, b).toMatch(/Strict-Transport-Security: max-age=\d{8,}/);
    if (b !== 'ebda') expect(h, b).not.toMatch(/ebda/i);
  }
});

it('every guide the inbox links to exists in docs/help in both languages (the help site publishes <host>/<lang>/<slug>)', () => {
  const src = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'components', 'NumbersScreen.tsx'), 'utf8');
  const slugs = [...src.matchAll(/guide: '([a-z0-9-]+)'/g)].map((m) => m[1]);
  expect(slugs.length).toBeGreaterThan(0);
  for (const lang of ['ar', 'en']) {
    const files = readdirSync(join(import.meta.dirname, '..', 'docs', 'help', lang)).map((f) => f.replace(/^\d+-/, '').replace(/\.md$/, ''));
    for (const slug of slugs) expect(files, `${lang}: ${slug}`).toContain(slug);
  }
});

it('the toast is placed with logical properties, so it is centred and padded right in both directions', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'web', 'src', 'styles.css'), 'utf8');
  const rules = css.split('\n').filter((l) => /(^|[\s,])\.toast\s*[{,]|\.toast\s*\{/.test(l) && !/\.toast \.btn/.test(l)).join('\n');
  expect(rules).toContain('.toast');
  expect(rules).not.toMatch(/\b(left|right)\s*:|translateX|padding\s*:\s*[^;]*\d+px\s+\d+px\s+\d+px\s+\d+px|\[dir=/);
  expect(rules).toMatch(/inset-inline/);
});

it('the production Worker answers on wa.ebda.app as a custom domain plus an explicit zone route (WA-ROUTE-1), and its public origin is that host', () => {
  // The zone route keeps the Store's `*.ebda.app/*` and `*/*` wildcard routes from shadowing the custom domain.
  expect(cfg.routes).toEqual([{ pattern: 'wa.ebda.app', custom_domain: true }, { pattern: 'wa.ebda.app/*', zone_name: 'ebda.app' }]);
  expect(cfg.vars.PUBLIC_BASE_URL).toBe('https://wa.ebda.app');
});

it('a brand with its own OIDC provider lists that issuer origin, exactly, in connect-src and form-action and adds no other host', async () => {
  const brandsDir = join(import.meta.dirname, '..', 'web', 'brands');
  const brands = readdirSync(brandsDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  const withOidc: string[] = [];
  for (const b of brands) {
    const { BRAND } = (await import(`../web/brands/${b}/brand.ts`)) as { BRAND: { accountsUrl: string | null; oidc?: { issuer: string; clientId: string } | null } };
    const csp = /Content-Security-Policy: (.+)$/m.exec(readFileSync(join(brandsDir, b, 'public', '_headers'), 'utf8'))?.[1] ?? '';
    const directive = (name: string) => (csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '').split(/\s+/).slice(1);
    const hosts = (list: string[]) => list.filter((t) => t.startsWith('https://') && !t.includes('facebook.') && !t.includes('fbcdn.'));
    if (!BRAND.oidc) {
      expect(directive('form-action'), b).toEqual(["'self'"]);
      continue;
    }
    withOidc.push(b);
    const origin = new URL(BRAND.oidc.issuer).origin;
    expect(origin.startsWith('https://'), b).toBe(true);
    expect(hosts(directive('connect-src')), b).toEqual([origin]);
    expect(directive('form-action'), b).toEqual(["'self'", origin]);
    expect(BRAND.accountsUrl, `${b}: one sign-in path per brand`).toBeNull();
    for (const d of ['script-src', 'img-src', 'frame-src', 'default-src']) expect(directive(d).join(' '), `${b} ${d}`).not.toContain(origin);
  }
  expect(withOidc).toContain('demo'); // the demo brand proves the seam
});

it('production lists the secrets /health must find well-formed (the first deploy\'s section B keys)', () => {
  expect(String(cfg.vars?.REQUIRED_SECRETS ?? '').split(',').sort()).toEqual(['AGENT_SECRETS_KEY', 'BACKUP_HMAC_KEY', 'ERASURE_HMAC_KEY', 'PROOF_URL_SECRET', 'SUITE_BUYER_KEY_SECRET', 'TOKEN_ENC_KEY']);
});

it('has the Store link on (WA-LINK-ON-1): bridge to ebda-api, one events consumer with its DLQ, the store-events producer', () => {
  expect(cfg.services).toContainEqual({ binding: 'STORE_BRIDGE', service: 'ebda-api', entrypoint: 'WhatsAppBridge' });
  expect(cfg.queues.producers).toContainEqual({ binding: 'STORE_EVENTS', queue: 'ebda-store-events' });
  const events = cfg.queues.consumers.filter((c: { queue: string }) => c.queue === 'ebda-wa-events');
  expect(events).toEqual([{ queue: 'ebda-wa-events', max_batch_size: 10, max_retries: 5, dead_letter_queue: 'ebda-wa-events-dlq' }]);
  // The DLQ of the events queue is not consumed here (no handler would ack it); the send DLQ is.
  expect(cfg.queues.consumers.some((c: { queue: string }) => c.queue === 'ebda-wa-events-dlq')).toBe(false);
});

it('the Worker serves the shell for exactly the screens the web router knows (SHELL_PATHS in src/index.ts = VIEW_PATHS in web/src/lib/route.ts)', () => {
  const read = (f: string) => readFileSync(join(import.meta.dirname, '..', f), 'utf8');
  const view = [...(/VIEW_PATHS[^=]*= \{([^}]*)\}/.exec(read('web/src/lib/route.ts'))?.[1] ?? '').matchAll(/'(\/[a-z]+)'/g)].map((m) => m[1]).sort();
  const shell = [...(/SHELL_PATHS = \[([^\]]*)\]/.exec(read('src/index.ts'))?.[1] ?? '').matchAll(/'(\/[a-z]+)'/g)].map((m) => m[1]).sort();
  expect(view.length).toBeGreaterThan(5);
  expect(shell).toEqual(view); // '/' (inbox) is the asset index itself; '/chat/:id' is checked by the Worker test
});
