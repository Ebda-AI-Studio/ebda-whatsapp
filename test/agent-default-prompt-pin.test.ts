import { expect, it } from 'vitest';
import { EBDA_AGENT_COPY, STRICT_STYLE } from '../src/addons/ebda/agent-copy';

// The shared rules of the DEFAULT agent prompt (what llama-3.3-70b, the model customers get today, reads on every turn) are pinned by sha256, so a change to them is deliberate: it
// shows up in this diff, must be measured by the live golden eval on BOTH models (CHAT-EVAL-BAR-1) and re-pinned here. Ruling GIFT-BUDGET-TOOL-1 added the explicit-ask fallback
// sentence to the shared rules on purpose. The flagged strict block (WA-MODEL-FLAG-1) is outside this pin: it never appears in the default prompt, which a second assertion proves.
const PINNED_SHA256 = 'b1ff74cc38984f277270f8c57d7f7b03712627d7deec59c2a5a745b6d1890468';

const render = (strict: boolean) =>
  EBDA_AGENT_COPY.systemPrompt({
    persona: 'PERSONA', language: 'auto', tone: 'warm', storeName: 'Dar Mona', knowledge: [], tools: ['search_catalog', 'show_products', 'recommend_products', 'handoff_to_human'],
    facts: null, customer: null, faq: null, strict,
  });

const sha256 = async (s: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');

it('the default prompt\'s shared rules are pinned (re-pin deliberately: run the live eval on llama AND gpt-oss first)', async () => {
  expect(await sha256(render(false))).toBe(PINNED_SHA256);
});
it('the strict block is only in the flagged prompt', () => {
  expect(render(false)).not.toContain(STRICT_STYLE);
  expect(render(true)).toContain(STRICT_STYLE);
});
