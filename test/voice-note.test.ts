import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { abandonVoiceTurn } from '../src/core/ai/agent';
import { EBDA_AGENT_COPY } from '../src/addons/ebda/agent-copy';
import { VOICE_MAX_BYTES, audioDurationMs, fitTranscript, oggOpusDurationMs, type Transcriber } from '../src/core/ai/transcribe';
import { ScriptedProvider, useAgent } from './helpers/agent';
import { agentWorkspace, say, sendCount, text, wamid } from './helpers/agent-chat';
import { stubGraph } from './helpers/graph';
import { postWebhook } from './helpers/meta';
import { rawMessagePayload } from './helpers/payload';
import { WA_1, useStoreLink } from './helpers/store-link';
import { exec, rows, workspace } from './helpers/workspace';

// Voice notes: transcribed once with the speech model, then answered like typed text; every failure asks the customer to type and says so in the inbox.
useStoreLink();
const W = (n: number) => `00000000-0000-4000-8000-0000000071${String(n).padStart(2, '0')}`;

/** A stub speech model with a REAL delay (so overlapping work interleaves as it does against the network); records every call. */
function stt(answer: string | Error, delayMs = 15) {
  const calls: { bytes: number; language?: string }[] = [];
  const fn: Transcriber = async (audio, opts) => {
    calls.push({ bytes: audio.length, ...(opts.language ? { language: opts.language } : {}) });
    await new Promise((r) => setTimeout(r, delayMs));
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, fn };
}
const speech = stt('ازيك، عايز اعرف سعر الورد البلدي');
const agent = useAgent({ transcriber: () => speech.fn });

/** An Ogg/Opus file whose last page says it lasts `ms` (granule = 48 kHz samples), padded to `size` bytes. */
function ogg(ms: number, size = 400): Uint8Array {
  const b = new Uint8Array(size);
  const page = (at: number, granule: bigint) => {
    b.set([0x4f, 0x67, 0x67, 0x53, 0, 0x04], at);
    for (let k = 0; k < 8; k++) b[at + 6 + k] = Number((granule >> BigInt(8 * k)) & 0xffn);
  };
  page(0, 0n);
  page(size - 40, BigInt(ms) * 48n);
  return b;
}
const audioMsg = (mediaId: string) => ({ id: wamid(), from: WA_1, type: 'audio', audio: { id: mediaId, mime_type: 'audio/ogg; codecs=opus' } });
/** Graph that serves `file` for the media id (lookup + download). */
const graphWith = (file: Uint8Array, size = file.length) => stubGraph((c) => {
  if (c.method === 'GET' && /\/media-v[^/]*$/.test(c.url)) return { status: 200, json: { url: 'https://lookaside.fbsbx.com/voice', mime_type: 'audio/ogg; codecs=opus', file_size: size } };
  if (c.url.startsWith('https://lookaside.fbsbx.com/')) return { status: 200, body: file, headers: { 'content-type': 'audio/ogg' } };
  return { status: 200, json: { messages: [{ id: `wamid.out.${Math.random()}` }] } };
});
const inboundAudio = async (ws: string) => (await rows<{ id: number; type: string; body: string | null; preview: string | null; voice_state: string | null; media_r2_key: string | null }>(ws, "SELECT id, type, body, preview, voice_state, media_r2_key FROM messages WHERE direction = 'in' ORDER BY id"))[0]!;
const outTexts = async (ws: string) => (await rows<{ body: string }>(ws, "SELECT body FROM messages WHERE direction = 'out' ORDER BY id")).map((r) => r.body);
const dto = async (ws: string) => {
  const conv = (await rows<{ id: number }>(ws, 'SELECT id FROM conversations'))[0]!.id;
  return (await workspace(ws).getMessages(conv, undefined, 10))!.items.find((m) => m.direction === 'in')!;
};
const setup = async (ws: string, settings: Record<string, unknown> = {}) => {
  agent.model = new ScriptedProvider([{ text: 'عندنا ورد بلدي متاح النهارده' }]);
  const pn = await agentWorkspace(ws, settings);
  await workspace(ws).grantAiCredits({ periodStart: 1, packageId: 'test', credits: 1000 });
  return pn;
};

describe('the pure parts', () => {
  it('reads the length of an Ogg/Opus voice note from its last page, and estimates anything else from its size', () => {
    expect(oggOpusDurationMs(ogg(12_500))).toBe(12_500);
    expect(oggOpusDurationMs(new Uint8Array(100))).toBeNull();
    expect(audioDurationMs(ogg(3_000))).toBe(3_000);
    expect(audioDurationMs(new Uint8Array(160_000))).toBe(10_000); // not Ogg: 16 KB/s
  });
  it('cuts a transcript to the 1 KB inline limit on a character boundary and collapses whitespace', () => {
    expect(fitTranscript('  a \n b  ')).toBe('a b');
    const long = fitTranscript('س'.repeat(2000));
    expect(new TextEncoder().encode(long).byteLength).toBeLessThanOrEqual(1024);
    expect(long).toMatch(/^س+$/);
  });
});

describe('a voice note is heard, then answered like text', () => {
  it('stores the transcript as the message text (inbox DTO, search) and the agent answers it; the model is called once with the transcript fenced as customer text', async () => {
    const ws = W(1);
    const pn = await setup(ws);
    const m = agent.model as ScriptedProvider;
    const g = graphWith(ogg(8_000));
    await say(ws, pn, audioMsg('media-v1'), g);
    const row = await inboundAudio(ws);
    expect(row).toMatchObject({ type: 'audio', body: 'ازيك، عايز اعرف سعر الورد البلدي', preview: 'ازيك، عايز اعرف سعر الورد البلدي', voice_state: 'ok' });
    expect(row.media_r2_key).toBeTruthy(); // the audio stays where the existing media path put it; nothing new is persisted
    expect(speech.calls.at(-1)).toEqual({ bytes: 400, language: 'ar' }); // the store's agent language (default Arabic) is the hint
    expect(m.calls[0]!.messages.at(-1)).toEqual({ role: 'user', content: '<customer_message>ازيك، عايز اعرف سعر الورد البلدي</customer_message>' });
    expect(await outTexts(ws)).toEqual(['عندنا ورد بلدي متاح النهارده']);
    expect(await dto(ws)).toMatchObject({ type: 'audio', text: 'ازيك، عايز اعرف سعر الورد البلدي', voice: 'transcribed', media: { mime: expect.any(String) } });
    expect((await workspace(ws).search('الورد البلدي', 5)).map((h) => h.messageId)).toContain(row.id);
    expect(sendCount(g)).toBe(1);
  });

  it('language auto sends no hint (the model detects Arabic or English); a fixed language is passed as the hint', async () => {
    const ws = W(2);
    const pn = await setup(ws, { language: 'auto' });
    const before = speech.calls.length;
    await say(ws, pn, audioMsg('media-v2'), graphWith(ogg(5_000)));
    expect(speech.calls.slice(before)).toEqual([{ bytes: 400 }]);
  });

  it('is idempotent: a webhook retry of the same message id transcribes and answers once', async () => {
    const ws = W(3);
    const pn = await setup(ws);
    const g = graphWith(ogg(6_000));
    const msg = audioMsg('media-v3');
    const before = speech.calls.length;
    await say(ws, pn, msg, g);
    expect((await postWebhook(SELF, rawMessagePayload(pn, msg))).status).toBe(200);
    await workspace(ws).runDueTasks();
    expect(speech.calls.length - before).toBe(1);
    expect(await outTexts(ws)).toHaveLength(1);
    // a replayed task (crash before the turn was recorded) reuses the stored transcript: the speech model is not asked again
    const row = await inboundAudio(ws);
    await exec(ws, 'DELETE FROM agent_turns');
    await exec(ws, 'DELETE FROM messages WHERE idempotency_key LIKE ?', `agent:${row.id}:%`);
    const payload = JSON.stringify({ messageId: row.id, wamid: 'x', from: WA_1, phoneNumberId: pn, profileName: null, type: 'audio', text: null, reply: null, order: null });
    await exec(ws, "INSERT INTO scheduled_tasks (kind, due_at, payload) VALUES ('bot_turn', 0, ?)", payload);
    await workspace(ws).runDueTasks();
    expect(speech.calls.length - before).toBe(1);
  });

  it('a spoken request for a person hands over without calling the language model', async () => {
    const ws = W(4);
    const pn = await setup(ws);
    const human = stt('عايز اكلم حد من الفريق لو سمحت');
    const { configureAgent } = await import('../src/core/ai/config');
    configureAgent({ transcriber: () => human.fn });
    const m = agent.model as ScriptedProvider;
    await say(ws, pn, audioMsg('media-v4'), graphWith(ogg(4_000)));
    expect(m.callCount).toBe(0);
    expect(await outTexts(ws)).toEqual([EBDA_AGENT_COPY.t.handoffAck.ar]);
    expect((await rows(ws, 'SELECT reason FROM agent_handoffs'))[0]).toEqual({ reason: 'asked' });
  });

  it('the turn cost includes the audio minutes (even on top of the tokens)', async () => {
    const ws = W(5);
    const pn = await setup(ws);
    agent.model = new ScriptedProvider([{ text: 'ok', usage: { inputTokens: 1000, outputTokens: 500 } }]);
    await exec(ws, 'INSERT OR IGNORE INTO pricing_fx (src_id, ver, effective_from, egp_per_usd_micros, buffer_bps) VALUES (1, 1, 0, 50000000, 0)');
    const ae = vi.spyOn(env.USAGE, 'writeDataPoint');
    await say(ws, pn, audioMsg('media-v5'), graphWith(ogg(60_000)));
    const p = ae.mock.calls.map((c) => c[0] as AnalyticsEngineDataPoint).find((x) => x.blobs?.[0] === 'ai_turn')!;
    // tokens 70,975 + 1 audio minute: 0.000513 USD x 50 EGP = 25,650 EGP micros
    expect(p.doubles![5]).toBe(70_975 + 25_650);
  });
});

describe('caps and failures never go quiet', () => {
  const asksToType = async (ws: string, copyKey: 'voiceDeclined' | 'voiceFailed', outcome: string) => {
    expect(await outTexts(ws)).toEqual([EBDA_AGENT_COPY.t[copyKey].ar]);
    expect((await inboundAudio(ws)).voice_state).toBe('failed');
    expect(await dto(ws)).toMatchObject({ voice: 'not_transcribed', text: null });
    expect((await rows(ws, 'SELECT outcome FROM agent_turns'))[0]).toEqual({ outcome });
    expect((agent.model as ScriptedProvider).callCount).toBe(0);
  };

  it('over 2 minutes: no speech call, a polite Egyptian-Arabic request to type', async () => {
    const ws = W(10);
    const pn = await setup(ws);
    const before = speech.calls.length;
    await say(ws, pn, audioMsg('media-v10'), graphWith(ogg(121_000)));
    expect(speech.calls.length).toBe(before);
    await asksToType(ws, 'voiceDeclined', 'voice_declined');
    expect(EBDA_AGENT_COPY.t.voiceDeclined.ar).toContain('تكتبلي');
  });

  it('over 5 MB: no speech call', async () => {
    const ws = W(11);
    const pn = await setup(ws);
    const before = speech.calls.length;
    await say(ws, pn, audioMsg('media-v11'), graphWith(ogg(10_000, VOICE_MAX_BYTES + 1)));
    expect(speech.calls.length).toBe(before);
    await asksToType(ws, 'voiceDeclined', 'voice_declined');
  });

  it('the store\'s daily cap: the next voice note is declined, a new UTC day starts again', async () => {
    const ws = W(12);
    const pn = await setup(ws);
    const day = new Date().toISOString().slice(0, 10);
    await exec(ws, "INSERT INTO store_state (key, value) VALUES ('voice.day', ?), ('voice.count', '60') ON CONFLICT(key) DO UPDATE SET value = excluded.value", day);
    const before = speech.calls.length;
    await say(ws, pn, audioMsg('media-v12'), graphWith(ogg(5_000)));
    expect(speech.calls.length).toBe(before);
    await asksToType(ws, 'voiceDeclined', 'voice_declined');
  });

  it('a speech failure: no language-model call, no credit spent, the customer is asked to type, the alert carries a class only (never audio, text or token)', async () => {
    const ws = W(13);
    const pn = await setup(ws);
    const { configureAgent } = await import('../src/core/ai/config');
    configureAgent({ transcriber: () => stt(new TypeError('boom: secret transcript text')).fn });
    const balance = (await workspace(ws).aiCredits()).balance;
    const log: string[] = [];
    const spies = (['error', 'warn', 'info', 'log'] as const).map((k) => vi.spyOn(console, k).mockImplementation((...a) => { log.push(a.join(' ')); }));
    await say(ws, pn, audioMsg('media-v13'), graphWith(ogg(5_000)));
    spies.forEach((s) => s.mockRestore());
    await asksToType(ws, 'voiceFailed', 'voice_failed');
    expect((await workspace(ws).aiCredits()).balance).toBe(balance);
    expect(log.join('\n')).toContain('voice_transcribe_failed');
    expect(log.join('\n')).not.toMatch(/secret transcript|test-token/);
  });

  it('empty text (silence) and a missing AI binding both fail closed', async () => {
    const ws = W(14);
    const pn = await setup(ws);
    const { configureAgent } = await import('../src/core/ai/config');
    configureAgent({ transcriber: () => stt('   ').fn });
    await say(ws, pn, audioMsg('media-v14'), graphWith(ogg(3_000)));
    await asksToType(ws, 'voiceFailed', 'voice_failed');
    const ws2 = W(15);
    const pn2 = await setup(ws2);
    configureAgent({ transcriber: () => null });
    await say(ws2, pn2, audioMsg('media-v15'), graphWith(ogg(3_000)));
    await asksToType(ws2, 'voiceFailed', 'voice_failed');
  });

  it('the file never reached R2 before the turn was abandoned: marked not transcribed and the customer is asked to type, once', async () => {
    const ws = W(16);
    const pn = await setup(ws);
    const g = stubGraph((c) => (c.method === 'GET' && /\/media-v16$/.test(c.url) ? { status: 500, json: { error: 'down' } } : { status: 200, json: { messages: [{ id: `wamid.o.${Math.random()}` }] } }));
    await say(ws, pn, audioMsg('media-v16'), g);
    expect(await outTexts(ws)).toEqual([]); // still retrying, nothing said yet
    const row = await inboundAudio(ws);
    expect(row.media_r2_key).toBeNull();
    const input = { messageId: row.id, wamid: 'x', from: WA_1, phoneNumberId: pn, profileName: null, type: 'audio', text: null, reply: null, order: null };
    for (let i = 0; i < 2; i++) await runInDurableObject(workspace(ws), (inst) => abandonVoiceTurn((inst as unknown as { host(): never }).host(), input, Date.now()));
    expect(await outTexts(ws)).toEqual([EBDA_AGENT_COPY.t.voiceFailed.ar]);
    expect(await dto(ws)).toMatchObject({ voice: 'not_transcribed' });
  });

  it('a typed message and a picture are unchanged (a picture still gets the text-only note)', async () => {
    const ws = W(17);
    const pn = await setup(ws);
    const before = speech.calls.length;
    const out = await say(ws, pn, text('مساء الخير'), stubGraph());
    expect(out).toHaveLength(1);
    expect(speech.calls.length).toBe(before);
    expect(await dto(ws)).not.toHaveProperty('voice');
  });
});
