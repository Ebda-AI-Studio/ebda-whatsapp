/** Final-review fixes I1, I2, I8: link trust per exact URL / path prefix, promises by explicit flag only, masking of every connector string and of the embedding query. */
import { describe, expect, it } from 'vitest';
import { guardReply, Trusted, type PromisePolicy } from '../src/core/ai/reply-guard';
import { toolContent } from '../src/core/connectors/registry';
import { MemoryVectors, ScriptedProvider, until, useAgent } from './helpers/agent';
import { agentWorkspace, say, text } from './helpers/agent-chat';
import { stubClient } from './helpers/connectors';
import { useStoreLink } from './helpers/store-link';
import { workspace } from './helpers/workspace';

const t = (...texts: string[]) => Object.assign(new Trusted(), { text: texts });

describe('I1 link trust is per exact URL or path prefix, never per host', () => {
  it('a shared host only vouches for the path the merchant wrote', () => {
    for (const host of ['wa.me', 'instagram.com', 'docs.google.com', 'script.google.com']) {
      const own = `https://${host}/own/page`;
      expect(guardReply(`see ${own}`, t(`our page ${own}`)).ok).toBe(true);
      expect(guardReply(`see ${own}/sub`, t(`our page ${own}`)).ok).toBe(true);
      expect(guardReply(`see https://${host}/attacker`, t(`our page ${own}`))).toEqual({ ok: false, reason: 'url' });
      expect(guardReply(`see https://${host}/own/pageX`, t(`our page ${own}`))).toEqual({ ok: false, reason: 'url' });
    }
  });
  it('a bare shared host mentioned without a path vouches for nothing else on it', () => {
    expect(guardReply('https://wa.me/201000000000', t('تواصل معنا على wa.me')).ok).toBe(false);
  });
  it('the merchant\'s own site (host only) still covers its pages, but not look-alikes or other subdomains', () => {
    expect(guardReply('https://shop.example/p/1?x=1', t('https://shop.example')).ok).toBe(true);
    expect(guardReply('https://evil.shop.example/p/1', t('https://shop.example')).ok).toBe(false);
  });
  it('a downgrade to http of a trusted https link is refused', () => {
    expect(guardReply('http://shop.example/p', t('https://shop.example')).ok).toBe(false);
  });
  it('a connector host is never trusted for a customer-facing link', () => {
    const tr = t('persona');
    expect((tr as unknown as { addHosts?: unknown }).addHosts).toBeUndefined();
    expect(guardReply('https://hooks.acme-client.com/x', tr).ok).toBe(false);
  });
  it('a Store link field vouches for the Store\'s own exact host only', () => {
    const tr = new Trusted();
    tr.addStoreResult(JSON.stringify({ items: [{ link: 'https://store.example/p/3', price: 110 }] }));
    expect(guardReply('https://store.example/p/3', tr).ok).toBe(true);
    expect(guardReply('https://evil.example/p/3', tr).ok).toBe(false);
  });
});

describe('I2 promises are allowed only by explicit policy flags', () => {
  const none: PromisePolicy = { refund: false, discount: false, freeDelivery: false, exchange: false, guarantee: false };
  const on = (k: keyof PromisePolicy): PromisePolicy => ({ ...none, [k]: true });
  const say_ = (reply: string, policy: PromisePolicy, ...merchantText: string[]) => guardReply(reply, Object.assign(t(...merchantText), { policy }));
  it.each([
    ['refund', 'Your full refund is approved', 'no refunds. مفيش استرجاع'],
    ['discount', 'تمام، خصم 20% ليك', 'مفيش خصومات ابدا'],
    ['freeDelivery', 'Yes, free shipping on this order', 'we never offer free shipping'],
    ['exchange', 'We will exchange it for you', 'no exchanges'],
    ['guarantee', 'ضمان سنة كاملة', 'مفيش ضمان'],
  ] as const)('%s: a negated FAQ enables nothing; the flag does', (k, reply, faq) => {
    expect(say_(reply, none, faq)).toEqual({ ok: false, reason: 'promise' });
    expect(say_(reply, on(k), faq).ok).toBe(true);
  });
  it('a flag opens only its own class', () => {
    expect(say_('Your full refund is approved', on('discount')).ok).toBe(false);
  });
});

describe('I8 everything a connector returns, and the embedding query, is masked before a model sees it', () => {
  it('toolContent masks phones and e-mails in success results, nested, keys untouched', () => {
    const out = toolContent({ ok: true, result: { customer: { phone: '+20 100 123 4567', mail: 'a.b@corp.example', note: ['call 01001234567'] }, status: 'ok' } });
    expect(out).not.toMatch(/100 123 4567|1001234567|a\.b@corp/);
    expect(out).toContain('"status":"ok"');
  });
});

const link = useStoreLink();
void link;
const vectors = { v: new MemoryVectors() };
const seen: string[][] = [];
const agent = useAgent({ vectors: () => vectors.v, embedder: () => async (texts) => { seen.push([...texts]); return texts.map(() => new Array<number>(64).fill(0).map((_, i) => (i === 0 ? 1 : 0))); } });
const hook = { kind: 'webhook' as const, enabled: true, config: { url: 'https://hooks.acme-client.com/wa', tools: [{ name: 'check_booking', description: 'x', params: [{ name: 'reference', type: 'string' as const, required: true }] }] }, secret: 'test-secret-0123456789abcdef' };

describe('I8 end to end', () => {
  it('a connector that returns a phone and an e-mail: the model input holds neither', async () => {
    const ws = '00000000-0000-4000-8000-0000000094aa';
    const pn = await agentWorkspace(ws);
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 't', credits: 100 });
    expect((await workspace(ws).putConnector('crm', hook as never, null)).ok).toBe(true);
    const c = stubClient(() => ({ json: { ok: true, result: { who: 'Sara +20 100 765 4321', mail: 'sara.k@corp.example' } } }));
    const m = (agent.model = new ScriptedProvider([{ tools: [{ name: 'crm__check_booking', arguments: { reference: 'A1' } }] }, { text: 'تمام' }])) as ScriptedProvider;
    await say(ws, pn, text('booking A1'), c.graph);
    expect(JSON.stringify(m.calls[1]!.messages)).not.toMatch(/765 4321|7654321|sara\.k@/);
  });
  it('a KB question with a phone number: the embedder never receives it', async () => {
    const ws = '00000000-0000-4000-8000-0000000094ab';
    const pn = await agentWorkspace(ws, { faqText: 'الشحن مجاني لأي طلب فوق 500 جنيه والتوصيل خلال يومين.' });
    await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 't', credits: 100 });
    await workspace(ws).runDueTasks();
    await until(async () => (await workspace(ws).getAgentSettings()).knowledgeReady);
    seen.length = 0;
    agent.model = new ScriptedProvider([{ text: 'تمام' }]);
    await say(ws, pn, text('الشحن كام؟ كلمني على +20 100 111 2222 او mail.me@corp.example'), stubClient(() => ({ json: {} })).graph);
    expect(seen.flat().length).toBeGreaterThan(0);
    expect(JSON.stringify(seen)).not.toMatch(/111 2222|1112222|mail\.me@/);
  });
});
