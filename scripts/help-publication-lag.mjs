#!/usr/bin/env node
// Publication-lag check: every docs/help/{ar,en}/NN-<slug>.md must reach help.ebda.app (Ebda Store's apps/help imports it as whatsapp/<slug>).
// A source whose contentHash differs from the published row of the same slug and language for more than 48 hours since the source last
// changed is a failure naming the slug; within 48 hours it is a warning. An unreachable manifest after 3 attempts is a failure (never fail open).
//   node scripts/help-publication-lag.mjs [--manifest <url>]
// contentHash = sha256 hex of the article body: front matter removed, CRLF normalised, trimmed. Same algorithm as Ebda Store's
// apps/help/scripts/help-manifest.mjs (pinned by test/help-publication-lag.test.ts).
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MANIFEST_URL = 'https://help.ebda.app/help-manifest.json';
export const LAG_MS = 48 * 3600 * 1000;

export const stripFrontMatter = (raw) => raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/^---\n[\s\S]*?\n---(?:\n|$)/, '');
export const contentHash = (body) => createHash('sha256').update(body.replace(/\r\n/g, '\n').trim()).digest('hex');

/** `sources`: [{ slug, lang, hash, changedAt (ms) }]; `manifest`: { articles: [{ slug, lang, contentHash }] }. */
export function checkLag({ sources, manifest, now }) {
  const published = new Map((manifest.articles ?? []).map((a) => [`${a.lang}|${a.slug}`, a.contentHash]));
  const failures = [];
  const warnings = [];
  for (const s of sources) {
    const got = published.get(`${s.lang}|${s.slug}`);
    if (got === s.hash) continue;
    const age = now - s.changedAt;
    const line = `${s.slug} (${s.lang}): ${got === undefined ? 'not published' : 'published copy differs'}, source changed ${Math.round(age / 3600000)} h ago`;
    (age > LAG_MS ? failures : warnings).push(line);
  }
  return { failures, warnings };
}

export async function fetchManifest(url, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = 3 } = {}) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetchImpl(url);
      if (r.ok) {
        const j = await r.json();
        if (j && Array.isArray(j.articles)) return j;
        last = new Error('manifest has no articles array');
      } else last = new Error(`HTTP ${r.status}`);
    } catch (e) {
      last = e;
    }
    if (i < attempts - 1) await sleep(1000 * 2 ** i);
  }
  throw new Error(`help manifest unreachable after ${attempts} attempts: ${last?.message ?? last}`);
}

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
export function readSources(root = ROOT, changedAtOf = (rel) => Number(execFileSync('git', ['-C', root, 'log', '-1', '--format=%ct', '--', rel], { encoding: 'utf8' }).trim() || 0) * 1000) {
  return ['ar', 'en'].flatMap((lang) =>
    readdirSync(join(root, 'docs/help', lang))
      .filter((f) => /^\d\d-.+\.md$/.test(f))
      .map((f) => {
        const rel = `docs/help/${lang}/${f}`;
        return { slug: `whatsapp/${f.replace(/^\d\d-/, '').replace(/\.md$/, '')}`, lang, hash: contentHash(stripFrontMatter(readFileSync(join(root, rel), 'utf8'))), changedAt: changedAtOf(rel) };
      }),
  );
}

async function main() {
  const i = process.argv.indexOf('--manifest');
  const url = i > 0 ? process.argv[i + 1] : MANIFEST_URL;
  let manifest;
  try {
    manifest = await fetchManifest(url);
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
  const { failures, warnings } = checkLag({ sources: readSources(), manifest, now: Date.now() });
  for (const w of warnings) console.log(`::warning::help publication lag: ${w}`);
  for (const f of failures) console.error(`::error::help publication lag over 48 h: ${f}`);
  if (failures.length) process.exit(1);
  console.log(`help-publication-lag: ok (${warnings.length} within the 48 h window)`);
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
