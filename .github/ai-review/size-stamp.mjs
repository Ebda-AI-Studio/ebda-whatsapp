#!/usr/bin/env node
// Ruling AI-REVIEW-SIZE-1: a diff over 400 KB is never reviewed by the bot, but a controller's independent review stamp
// (commit status `controller/money-review` or `controller/review` on the PR head SHA, created by an allowed account) may stand in for it.
// Decision only: reads commit statuses (data fetched by the base-branch workflow with its GITHUB_TOKEN); executes nothing from the PR.
// Fail closed: no stamp, a stamp by anyone else, or a newer non-success stamp = refuse.
import { pathToFileURL } from 'node:url';

export const STAMP_CONTEXTS = ['controller/money-review', 'controller/review'];
export const DEFAULT_ALLOWED = ['voidengineer-911'];

/** statuses: array from GET /repos/{r}/commits/{sha}/statuses. Returns { pass, reason } */
export function decide(statuses, allowed = DEFAULT_ALLOWED) {
  const allow = new Set(allowed.map((s) => s.toLowerCase()));
  const stamps = (Array.isArray(statuses) ? statuses : [])
    .filter((s) => s && STAMP_CONTEXTS.includes(s.context) && allow.has(String(s.creator?.login ?? '').toLowerCase()))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || Number(b.id ?? 0) - Number(a.id ?? 0));
  // newest per context decides that context; any allowed-creator stamp whose newest state is success passes only if
  // no allowed-creator stamp (any context) is newer and non-success
  const newest = stamps[0];
  if (!newest) return { pass: false, reason: 'no controller review stamp by an allowed account on this head' };
  if (newest.state !== 'success') return { pass: false, reason: `newest controller stamp ${newest.context} is ${newest.state}` };
  return { pass: true, reason: `size-refused; reviewed by controller stamp ${newest.context} @${newest.created_at}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  let statuses = [];
  try { statuses = JSON.parse(Buffer.concat(chunks).toString() || '[]'); } catch { /* fail closed below */ }
  const allowed = (process.env.AI_REVIEW_STAMP_CREATORS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const r = decide(statuses, allowed.length ? allowed : DEFAULT_ALLOWED);
  console.log(r.reason);
  process.exit(r.pass ? 0 : 1);
}
