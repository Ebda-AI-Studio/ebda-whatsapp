import { describe, it, expect } from 'vitest';
// @ts-expect-error plain .mjs without types
import { decide } from '../.github/ai-review/size-stamp.mjs';

const st = (context: string, state: string, login: string, t: string, id = 1) => ({ context, state, id, created_at: t, creator: { login } });
const OWNER = 'voidengineer-911';

describe('AI review size refusal - controller stamp (Ruling AI-REVIEW-SIZE-1)', () => {
  it('passes on a success stamp by the allowed account', () => {
    expect(decide([st('controller/money-review', 'success', OWNER, '2026-11-23T06:20:20Z')]).pass).toBe(true);
    expect(decide([st('controller/review', 'success', OWNER, '2026-11-23T06:20:20Z')]).pass).toBe(true);
  });
  it('fails with no stamp', () => {
    expect(decide([]).pass).toBe(false);
    expect(decide([st('ci/other', 'success', OWNER, '2026-11-23T06:20:20Z')]).pass).toBe(false);
    expect(decide(undefined).pass).toBe(false);
  });
  it('fails on a stamp by another creator', () => {
    expect(decide([st('controller/review', 'success', 'someone-else', '2026-11-23T06:20:20Z')]).pass).toBe(false);
  });
  it('honours a custom allow-list', () => {
    expect(decide([st('controller/review', 'success', 'ops-bot', '2026-11-23T06:20:20Z')], ['ops-bot']).pass).toBe(true);
  });
  it('fails when a failure is newer than the success', () => {
    expect(decide([
      st('controller/review', 'success', OWNER, '2026-11-23T06:00:00Z', 1),
      st('controller/money-review', 'failure', OWNER, '2026-11-23T07:00:00Z', 2),
    ]).pass).toBe(false);
  });
});
