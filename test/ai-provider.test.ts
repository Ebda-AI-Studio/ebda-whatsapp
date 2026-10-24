import { describe, expect, it, vi } from 'vitest';
import { LlmError, OpenAiCompatibleProvider, WorkersAiProvider, readChatResult, stripThinking, validBaseUrl, type LlmRequest } from '../src/core/ai/provider';
import { decryptSecret, encryptSecret } from '../src/core/ai/secrets';
import { TEST_SECRETS_KEY } from './helpers/agent';

const req: LlmRequest = {
  system: 'sys',
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'search_catalog', arguments: { query: 'x' } }] },
    { role: 'tool', toolCallId: 'c1', name: 'search_catalog', content: '[]' },
  ],
  tools: [{ name: 'search_catalog', description: 'd', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }],
  maxTokens: 300,
};

describe('wire format', () => {
  it('reads an OpenAI-shaped answer with a tool call (arguments are a JSON string)', () => {
    const r = readChatResult({ choices: [{ message: { content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'order_status', arguments: '{"orderNumber":"1001"}' } }] } }], usage: { prompt_tokens: 12, completion_tokens: 3 } });
    expect(r).toEqual({ toolCalls: [{ id: 'a', name: 'order_status', arguments: { orderNumber: '1001' } }], usage: { inputTokens: 12, outputTokens: 3 } });
  });
  it('reads the older Workers AI shape ({ response, tool_calls } with object arguments)', () => {
    expect(readChatResult({ response: 'أهلاً', usage: { prompt_tokens: 1, completion_tokens: 2 } })).toEqual({ text: 'أهلاً', usage: { inputTokens: 1, outputTokens: 2 } });
    const r = readChatResult({ response: null, tool_calls: [{ name: 'handoff_to_human', arguments: { reason: 'r' } }] });
    expect(r.toolCalls).toEqual([{ id: 'call_0', name: 'handoff_to_human', arguments: { reason: 'r' } }]);
  });
  it('marks unparseable tool arguments instead of throwing, strips <think> blocks, rejects garbage', () => {
    expect(readChatResult({ choices: [{ message: { content: '<think>secret plan</think>مرحبا', tool_calls: [{ function: { name: 'x', arguments: '{oops' } }] } }] })).toMatchObject({ text: 'مرحبا', toolCalls: [{ arguments: { __unparseable: true } }] });
    expect(stripThinking('<think>a\nb</think> hi')).toBe('hi');
    expect(() => readChatResult({ nope: 1 })).toThrow(LlmError);
  });
});

describe('WorkersAiProvider', () => {
  it('sends the model id, OpenAI-style messages (tool turns included) and the tools to env.AI', async () => {
    const run = vi.fn().mockResolvedValue({ response: 'تمام', usage: { prompt_tokens: 5, completion_tokens: 1 } });
    const out = await new WorkersAiProvider({ run }, '@cf/test/model').complete(req);
    expect(out.text).toBe('تمام');
    const [model, inputs] = run.mock.calls[0]! as [string, Record<string, any>];
    expect(model).toBe('@cf/test/model');
    expect(inputs.max_tokens).toBe(300);
    expect(inputs.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(inputs.messages[2].tool_calls[0]).toEqual({ id: 'c1', type: 'function', function: { name: 'search_catalog', arguments: '{"query":"x"}' } });
    expect(inputs.messages[3]).toMatchObject({ tool_call_id: 'c1', content: '[]' });
    expect(inputs.tools[0].function.name).toBe('search_catalog');
  });
  it('sends no tools key when there are none', async () => {
    const run = vi.fn().mockResolvedValue({ response: 'x' });
    await new WorkersAiProvider({ run }, 'm').complete({ ...req, tools: [] });
    expect('tools' in (run.mock.calls[0]![1] as object)).toBe(false);
  });
  it('turns a platform failure into a classified LlmError that carries none of its text', async () => {
    const boom = new WorkersAiProvider({ run: async () => { throw new Error('3040: Capacity temporarily exceeded for +201001234567'); } }, 'm');
    const e = (await boom.complete(req).catch((x: unknown) => x)) as LlmError;
    expect(e).toBeInstanceOf(LlmError);
    expect(e).toMatchObject({ kind: 'rate_limited', retryable: true });
    expect(String(e.message)).not.toMatch(/\d{6}/);
  });
});

describe('OpenAiCompatibleProvider', () => {
  const ok = (body: unknown) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
  it('posts to {base}/chat/completions with the bearer key, never follows redirects, and is byoKey', async () => {
    const fetcher = ok({ choices: [{ message: { content: 'hello' } }] });
    const p = new OpenAiCompatibleProvider({ baseUrl: 'https://llm.example-provider.com/v1/', apiKey: 'sk-test-123456', model: 'gpt-x', fetcher });
    expect(p.byoKey).toBe(true);
    expect((await p.complete(req)).text).toBe('hello');
    const [url, init] = fetcher.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://llm.example-provider.com/v1/chat/completions');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test-123456');
    expect(init.redirect).toBe('manual');
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'gpt-x', max_tokens: 300 });
  });
  it('classifies 429 / 5xx / 4xx / bad json / network, and never echoes the body or the key', async () => {
    const mk = async (f: typeof fetch) => (await new OpenAiCompatibleProvider({ baseUrl: 'https://a.b.com', apiKey: 'sk-secret-key-1', model: 'm', fetcher: f }).complete(req).catch((e: unknown) => e)) as LlmError;
    expect(await mk(async () => new Response('slow down sk-secret-key-1', { status: 429 }))).toMatchObject({ kind: 'rate_limited', retryable: true });
    expect(await mk(async () => new Response('x', { status: 503 }))).toMatchObject({ kind: 'http', retryable: true, status: 503 });
    const four = await mk(async () => new Response('sk-secret-key-1 invalid', { status: 401 }));
    expect(four).toMatchObject({ kind: 'http', retryable: false, status: 401 });
    expect(four.message).not.toContain('sk-secret');
    expect(await mk(async () => new Response('not json', { status: 200 }))).toMatchObject({ kind: 'bad_response', retryable: false });
    expect(await mk(async () => { throw new TypeError('fetch failed'); })).toMatchObject({ kind: 'network', retryable: true });
  });
});

describe('validBaseUrl', () => {
  it('accepts a public https host and trims the trailing slash', () => {
    expect(validBaseUrl('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1');
    expect(validBaseUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1');
  });
  it.each([
    'http://api.openai.com/v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1', 'https://10.0.0.5/v1', 'https://user:pw@api.x.com/v1',
    'https://api.x.com:8443/v1', 'https://intranet/v1', 'https://svc.internal/v1', 'https://x.local/v1', 'https://api.x.com/v1?key=1', 'ftp://x.com', 'not a url', 'https://2130706433/v1',
  ])('refuses %s', (u) => expect(validBaseUrl(u)).toBeNull());
});

describe('secrets', () => {
  it('round-trips, is bound to the workspace, and is not deterministic', async () => {
    const a = await encryptSecret('sk-live-abcdef', TEST_SECRETS_KEY, 'ws-1');
    expect(a).toMatch(/^v1\./);
    expect(a).not.toContain('sk-live');
    expect(await decryptSecret(a, TEST_SECRETS_KEY, 'ws-1')).toBe('sk-live-abcdef');
    expect(await decryptSecret(a, TEST_SECRETS_KEY, 'ws-2')).toBeNull();
    expect(await encryptSecret('sk-live-abcdef', TEST_SECRETS_KEY, 'ws-1')).not.toBe(a);
  });
  it('refuses tampering, another key, junk and a short master key', async () => {
    const a = await encryptSecret('sk-live-abcdef', TEST_SECRETS_KEY, 'ws-1');
    const flipped = `${a.slice(0, -2)}${a.endsWith('A') ? 'B' : 'A'}${a.slice(-1)}`;
    expect(await decryptSecret(flipped, TEST_SECRETS_KEY, 'ws-1')).toBeNull();
    expect(await decryptSecret(a, btoa('x'.repeat(32)), 'ws-1')).toBeNull();
    expect(await decryptSecret('garbage', TEST_SECRETS_KEY, 'ws-1')).toBeNull();
    await expect(encryptSecret('k', btoa('short'), 'ws')).rejects.toThrow();
  });
});
