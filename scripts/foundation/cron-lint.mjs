#!/usr/bin/env node
// Lints the Cloudflare cron schedules in wrangler config files (wrangler.jsonc / wrangler.json / wrangler.toml):
//   node cron-lint.mjs [file-or-dir ...]     (default: the current directory; node_modules, .git and worktree dirs are skipped)
// WHY. Cloudflare's day-of-week field is NOT Unix: 1 = SUNDAY ... 7 = SATURDAY, and 0 is REJECTED. One invalid cron makes the whole schedules PUT fail:
// the code deploys, /health shows the new commit, and no schedule registers (Ebda 2026-10-26: 28 job crons, ~20 h of dead crons behind a red deploy).
// A numeric weekday is therefore a trap either way (0 is invalid, 1 means Sunday not Monday), so weekdays are always NAMES (SUN..SAT, ranges, lists) or `*`.
// Rules: exactly 5 fields; the day-of-week field is `*` or names, never a digit; the other fields only digits / * / , / - / / and in range.
// Exit 0 = clean, 1 = a problem (printed as file: "expr": why), 2 = bad usage. Plain Node >= 20, no dependencies.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIELDS = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['day of month', 1, 31],
  ['month', 1, 12],
];
const DAY = '(?:SUN|MON|TUE|WED|THU|FRI|SAT)';
const DOW = new RegExp(`^(?:\\*|${DAY}(?:-${DAY})?(?:,${DAY}(?:-${DAY})?)*)$`);

/** Problems with one cron expression, as readable strings (empty = fine). */
export function lintCron(expr) {
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return [`needs exactly 5 fields, found ${parts.length}`];
  const problems = [];
  parts.slice(0, 4).forEach((f, i) => {
    const [name, lo, hi] = FIELDS[i];
    if (/[A-Za-z]/.test(f)) {
      problems.push(`${name} "${f}": names are not accepted, use numbers`);
      return;
    }
    if (!/^[0-9*,/-]+$/.test(f)) {
      problems.push(`${name} "${f}": only digits and * , - / are allowed`);
      return;
    }
    for (const n of f.match(/\d+/g) ?? []) {
      if (Number(n) < lo || Number(n) > hi) problems.push(`${name} ${n} is outside ${lo}-${hi}`);
    }
  });
  const dow = parts[4];
  if (!DOW.test(dow)) {
    problems.push(/\d/.test(dow) ? `day of week "${dow}": write weekday names (SUN MON TUE WED THU FRI SAT, ranges MON-FRI, lists MON,WED); a digit is a trap: 0 is rejected by Cloudflare and 1 means Sunday, not Monday` : `day of week "${dow}": only * or the names SUN MON TUE WED THU FRI SAT (ranges MON-FRI, lists MON,WED) are accepted`);
  }
  return [...new Set(problems)];
}

/** Strip // and block comments (outside strings) and trailing commas from JSONC. */
export function parseJsonc(src) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === '\\') out += src[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

/** The cron expressions a wrangler file declares (top level and every `env.*` block). */
export function cronsFromWrangler(text, file = 'wrangler.jsonc') {
  if (file.endsWith('.toml')) {
    return [...text.matchAll(/^\s*crons\s*=\s*\[([^\]]*)\]/gm)].flatMap((m) => [...m[1].matchAll(/["']([^"']*)["']/g)].map((x) => x[1]));
  }
  const cfg = parseJsonc(text);
  const own = (c) => c?.triggers?.crons ?? [];
  return [...own(cfg), ...Object.values(cfg.env ?? {}).flatMap(own)];
}

/** `file: "expr": problem` lines for one wrangler file's text. */
export function lintWrangler(text, file) {
  return cronsFromWrangler(text, file).flatMap((c) => lintCron(c).map((p) => `${file}: "${c}": ${p}`));
}

const SKIP = new Set(['node_modules', '.git', '.wt-fix', '.next', 'dist']);
const WRANGLER = /^wrangler(\.[\w-]+)?\.(jsonc|json|toml)$/;
export function findWranglerFiles(path) {
  const st = statSync(path);
  if (st.isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).flatMap((e) => {
    const p = join(path, e.name);
    if (e.isDirectory()) return SKIP.has(e.name) ? [] : findWranglerFiles(p);
    return WRANGLER.test(e.name) ? [p] : [];
  });
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  const targets = process.argv.slice(2).length ? process.argv.slice(2) : ['.'];
  const missing = targets.filter((t) => !existsSync(t));
  if (missing.length) {
    console.error(`cron-lint: no such path: ${missing.join(', ')}`);
    process.exit(2);
  }
  const files = targets.flatMap(findWranglerFiles);
  const problems = files.flatMap((f) => lintWrangler(readFileSync(f, 'utf8'), f));
  if (problems.length) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log(`cron-lint: ${files.length} wrangler file(s) checked, schedules clean`);
}
