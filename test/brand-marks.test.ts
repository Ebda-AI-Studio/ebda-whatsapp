import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The official third-party marks shipped with each web brand (web/brands/<brand>/public/brand/SOURCES.md lists the source + rules).
describe('third-party brand marks', () => {
  it.each(['ebda', 'demo'])('the %s brand ships a real, inert, small SVG for the Odoo logo', (brand) => {
    const svg = readFileSync(join(import.meta.dirname, '..', 'web', 'brands', brand, 'public', 'brand', 'odoo-logo.svg'), 'utf8');
    expect(svg).toMatch(/^<svg[\s>]/);
    expect(svg).not.toMatch(/<script|\son[a-z]+=|href=|data:/i);
    expect(svg.length).toBeLessThan(10_000);
  });
});
