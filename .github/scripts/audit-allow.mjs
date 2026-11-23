/**
 * The audit allow-list (Ruling AUDIT-SPLIT-1): `.github/audit-allow.json`, one entry per advisory we knowingly carry because NO
 * patched version exists. Every entry names the advisory, the package, why it is acceptable and an EXPIRY date; an expired entry
 * stops waiving (the advisory blocks again) AND fails the gate by itself, so a waiver can never outlive its review.
 * Entries are capped at MAX_DAYS ahead so "expires 2099" is not a way around it.
 */
import { readFileSync } from 'node:fs';

export const MAX_DAYS = 90;
const ID = /^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {unknown} entries parsed JSON (an array)
 * @param {Date} now
 * @returns {{ allow: Map<string,string>, expired: string[], invalid: string[] }}
 */
export function evaluateAllow(entries, now = new Date()) {
  const allow = new Map();
  const expired = [];
  const invalid = [];
  if (!Array.isArray(entries))
    return { allow, expired, invalid: ['the allow-list is not an array'] };
  const today = now.toISOString().slice(0, 10);
  const limit = new Date(now.getTime() + MAX_DAYS * 86_400_000).toISOString().slice(0, 10);
  for (const [i, e] of entries.entries()) {
    const label = `entry ${i + 1}${e && typeof e === 'object' && e.id ? ` (${e.id})` : ''}`;
    if (!e || typeof e !== 'object') {
      invalid.push(`${label}: not an object`);
      continue;
    }
    if (typeof e.id !== 'string' || !ID.test(e.id)) {
      invalid.push(`${label}: id must be a GHSA id`);
      continue;
    }
    if (typeof e.package !== 'string' || !e.package) {
      invalid.push(`${label}: package is required`);
      continue;
    }
    if (typeof e.reason !== 'string' || e.reason.trim().length < 20) {
      invalid.push(`${label}: reason (at least 20 characters) is required`);
      continue;
    }
    if (
      typeof e.expires !== 'string' ||
      !DAY.test(e.expires) ||
      Number.isNaN(Date.parse(e.expires))
    ) {
      invalid.push(`${label}: expires must be YYYY-MM-DD`);
      continue;
    }
    if (e.expires > limit) {
      invalid.push(
        `${label}: expires ${e.expires} is more than ${MAX_DAYS} days ahead (latest allowed ${limit})`
      );
      continue;
    }
    if (e.expires < today) {
      expired.push(`${e.id} (${e.package}) expired ${e.expires}: re-review it or remove it`);
      continue;
    }
    allow.set(e.id, `${e.package}: ${e.reason} (expires ${e.expires})`);
  }
  return { allow, expired, invalid };
}

export function loadAllow(path, now = new Date()) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    return { allow: new Map(), expired: [], invalid: [`cannot read ${path}: ${e.message}`] };
  }
  return evaluateAllow(raw, now);
}
