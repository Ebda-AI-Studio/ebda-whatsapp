// Node project (uses fs + esbuild): the bundled assistant assets must match what the builder produces from capabilities/ and docs/help/.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs script
import { buildAssets } from '../../scripts/build-help-corpus.mjs';

const ROOT = join(import.meta.dirname, '..', '..');

describe('assistant assets', () => {
  it('registry, help-corpus and explain .generated.json are current (run node scripts/build-help-corpus.mjs)', async () => {
    const { registry, corpus, explain } = (await buildAssets()) as { registry: string; corpus: string; explain: string };
    expect(readFileSync(join(ROOT, 'assistant/registry.generated.json'), 'utf8') === registry).toBe(true);
    expect(readFileSync(join(ROOT, 'assistant/help-corpus.generated.json'), 'utf8') === corpus).toBe(true);
    expect(readFileSync(join(ROOT, 'assistant/explain.generated.json'), 'utf8') === explain).toBe(true);
  });
  it('every help chunk fits the engine limit and every guide has an Arabic and an English twin', async () => {
    const { corpus } = (await buildAssets()) as { corpus: string };
    const c = JSON.parse(corpus) as { docs: Array<{ articleId: string; locale: string; chunks: Array<{ text: string }> }> };
    for (const d of c.docs) for (const k of d.chunks) expect(k.text.length).toBeLessThanOrEqual(800);
    const by = new Map<string, Set<string>>();
    for (const d of c.docs) by.set(d.articleId, (by.get(d.articleId) ?? new Set()).add(d.locale));
    for (const [id, l] of by) expect([...l].sort(), id).toEqual(['ar', 'en']);
  });
});
