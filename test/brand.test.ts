import { describe, expect, it } from 'vitest';
import { EBDA_PACK } from '../src/addons/ebda/pack';
import { DEMO_PACK } from '../src/addons/demo/pack';
import { brandPack } from '../src/brand';

describe('brand packs', () => {
  it('selects the pack named by BRAND; unset means the suite brand', () => {
    expect(brandPack(undefined)).toBe(EBDA_PACK);
    expect(brandPack('ebda')).toBe(EBDA_PACK);
    expect(brandPack('demo')).toBe(DEMO_PACK);
  });
  it('an unknown brand stops the Worker instead of silently showing another brand', () => {
    expect(() => brandPack('acme')).toThrow(/BRAND/);
  });
  it('a white-label pack carries none of the suite brand and needs no Store link', () => {
    const text = JSON.stringify(DEMO_PACK, (_k, v) => (typeof v === 'function' ? v.toString() : v instanceof RegExp ? v.source : v));
    expect(text).not.toMatch(/ebda|إبدا|ابدأ/i);
    expect(DEMO_PACK.storeLink).toBeUndefined();
    expect(DEMO_PACK.agentCopy.systemPrompt({ persona: 'p', language: 'en', storeName: 'Shop', knowledge: [], tools: [] })).toContain('Shop');
  });
  it('every pack is complete: agent copy, auto reply, opt-in words, templates', () => {
    for (const p of [EBDA_PACK, DEMO_PACK]) {
      expect(p.agentCopy.t.handoffAck.ar.length).toBeGreaterThan(0);
      expect(p.agentCopy.t.handoffAck.en.length).toBeGreaterThan(0);
      expect(p.autoReply.length).toBeGreaterThan(0);
      expect(p.optInKeywords.length).toBeGreaterThan(0);
      expect(p.templates.length).toBeGreaterThan(0);
    }
  });
});
