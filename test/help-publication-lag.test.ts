import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script
import { LAG_MS, checkLag, contentHash, fetchManifest, readSources, stripFrontMatter } from '../scripts/help-publication-lag.mjs';

const NOW = 1_800_000_000_000;
const src = (hash: string, ageMs: number) => [{ slug: 'whatsapp/ai-agent', lang: 'en', hash, changedAt: NOW - ageMs }];
const manifest = (h: string) => ({ articles: [{ slug: 'whatsapp/ai-agent', lang: 'en', contentHash: h }] });

describe('help publication lag', () => {
  it('same hash is ok', () => {
    expect(checkLag({ sources: src('a', LAG_MS * 5), manifest: manifest('a'), now: NOW })).toEqual({ failures: [], warnings: [] });
  });
  it('a differing hash within 48 hours is a warning', () => {
    const r = checkLag({ sources: src('a', 3600_000), manifest: manifest('b'), now: NOW });
    expect(r.failures).toEqual([]);
    expect(r.warnings[0]).toContain('whatsapp/ai-agent');
  });
  it('a differing hash beyond 48 hours fails and names the slug', () => {
    const r = checkLag({ sources: src('a', LAG_MS + 1), manifest: manifest('b'), now: NOW });
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('whatsapp/ai-agent (en)');
  });
  it('a guide missing from the manifest beyond 48 hours fails as not published', () => {
    expect(checkLag({ sources: src('a', LAG_MS + 1), manifest: { articles: [] }, now: NOW }).failures[0]).toContain('not published');
  });
  it('an unreachable manifest fails after 3 attempts (never fails open)', async () => {
    let calls = 0;
    await expect(fetchManifest('x', { fetchImpl: async () => { calls++; throw new Error('down'); }, sleep: async () => undefined })).rejects.toThrow(/after 3 attempts/);
    expect(calls).toBe(3);
  });
  it('a 503 and a body without articles also count as unreachable', async () => {
    await expect(fetchManifest('x', { fetchImpl: async () => new Response('no', { status: 503 }), sleep: async () => undefined })).rejects.toThrow(/HTTP 503/);
    await expect(fetchManifest('x', { fetchImpl: async () => new Response('{}'), sleep: async () => undefined })).rejects.toThrow(/no articles/);
  });
  it('recovers when a later attempt succeeds', async () => {
    let n = 0;
    const m = await fetchManifest('x', { fetchImpl: async () => (++n < 3 ? new Response('x', { status: 500 }) : new Response(JSON.stringify(manifest('a')))), sleep: async () => undefined });
    expect(m.articles).toHaveLength(1);
  });
  it('contentHash is pinned to the Store algorithm (apps/help/scripts/help-manifest.mjs)', () => {
    expect(contentHash('hello\r\nworld\n')).toBe('26c60a61d01db5836ca70fefd44a6a016620413c8ef5f259a6c5612d4f79d3b8');
    expect(contentHash('  x  ')).toBe(contentHash('x'));
    expect(contentHash(stripFrontMatter('---\ncapabilities:\n  - a.b@1\n---\n\n# T\n'))).toBe(contentHash('# T'));
  });
  it('reads the 15 guides in both languages with front matter stripped', () => {
    const s = readSources(undefined, () => NOW);
    expect(s).toHaveLength(30);
    expect(s.every((x: { hash: string }) => /^[0-9a-f]{64}$/.test(x.hash))).toBe(true);
  });
});
