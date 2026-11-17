#!/usr/bin/env node
// Builds the two bundled assets of the assistant (the Worker cannot read the file system):
//   assistant/registry.generated.json   the capability registry as the engine's RegistryCap list (via the engine's own toRegistryView)
//   assistant/help-corpus.generated.json  docs/help/{ar,en}/NN-<slug>.md as heading-aware chunks + a content hash (skip-if-unchanged index)
//   assistant/explain.generated.json      per live, non-forbidden BEHAVIOUR capability (no merchant route of its own, or reads only): title (ar/en), steps, edge cases, guide: what the explain tools answer from; the registry view keeps none of it
// `node scripts/build-help-corpus.mjs` writes them; `--check` exits 1 when they are stale (test/smart-layer/assets.test.ts runs the same builder).
import { build } from 'esbuild';
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'assistant');

async function load() {
  const entry = `
    export { toRegistryView } from ${JSON.stringify(join(ROOT, 'foundation/smart-layer/registry-view.ts'))};
    export { helpDoc, chunkHelp, corpusHash } from ${JSON.stringify(join(ROOT, 'foundation/smart-layer/help.ts'))};
    export { capabilitySchema } from ${JSON.stringify(join(ROOT, 'foundation/capability.ts'))};`;
  const r = await build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'ts' }, bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
  return import(`data:text/javascript;base64,${Buffer.from(r.outputFiles[0].text).toString('base64')}`);
}

export async function buildAssets() {
  const { toRegistryView, helpDoc, chunkHelp, corpusHash, capabilitySchema } = await load();
  const dir = join(ROOT, 'capabilities');
  const entries = readdirSync(dir).filter((f) => f.endsWith('.capability.json')).sort()
    .map((f) => capabilitySchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
  // uiLabels are derived from the titles when the registry is read (registry.ts), so they are not stored twice.
  const registry = [...toRegistryView(entries).caps.values()].map(({ uiLabels: _derived, ...cap }) => cap);

  const docs = [];
  for (const lang of ['ar', 'en']) {
    const hd = join(ROOT, 'docs/help', lang);
    if (!existsSync(hd)) continue;
    for (const f of readdirSync(hd).filter((x) => /^\d\d-.+\.md$/.test(x)).sort()) {
      docs.push(helpDoc(`whatsapp/${f.replace(/^\d\d-/, '').replace(/\.md$/, '')}`, lang, readFileSync(join(hd, f), 'utf8')));
    }
  }
  const corpus = {
    hash: await corpusHash(docs),
    docs: docs.map((d) => ({ articleId: d.articleId, locale: d.locale, title: d.title, url: d.url, appPath: d.appPath, capabilityIds: d.capabilityIds, chunks: chunkHelp(d) })),
  };
  const explain = Object.fromEntries(entries.filter((e) => e.status === 'live' && e.policy !== 'forbidden' && e.api.every((a) => !a.includes('/stores/:storeId') || a.startsWith('GET '))).map((e) => [e.id, { titleAr: e.titleAr, titleEn: e.titleEn, steps: e.steps, edgeCases: e.edgeCases, helpArticle: e.helpArticle }]));
  return { registry: JSON.stringify(registry) + '\n', corpus: JSON.stringify(corpus) + '\n', explain: JSON.stringify(explain) + '\n' };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { registry, corpus, explain } = await buildAssets();
  const files = [['registry.generated.json', registry], ['help-corpus.generated.json', corpus], ['explain.generated.json', explain]];
  if (process.argv.includes('--check')) {
    const stale = files.filter(([n, c]) => !existsSync(join(OUT, n)) || readFileSync(join(OUT, n), 'utf8') !== c).map(([n]) => n);
    if (stale.length) { console.error(`stale: ${stale.join(', ')} (run node scripts/build-help-corpus.mjs)`); process.exit(1); }
  } else for (const [n, c] of files) writeFileSync(join(OUT, n), c);
}
