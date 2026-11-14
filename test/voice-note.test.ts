import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { abandonVoiceTurn } from '../src/core/ai/agent';
import { EBDA_AGENT_COPY } from '../src/addons/ebda/agent-copy';
import { EGYPTIAN_STT_PROMPT, VOICE_MAX_BYTES, VOICE_TIMEOUT, workersAiTranscriber, audioDurationMs, fitTranscript, oggOpusDurationMs, type Transcriber } from '../src/core/ai/transcribe';
import { configureAgent } from '../src/core/ai/config';
import { QuickRetryError, retryDelayMs } from '../src/core/scheduler';
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

describe('Egyptian / code-switch hint for the speech model (D7)', () => {
  it('every call carries the fixed Egyptian prompt next to the language hint, and the Workers AI shape uses initial_prompt', async () => {
    const seen: { language?: string; prompt?: string }[] = [];
    const prev = configureAgent({ transcriber: () => async (_a, o) => { seen.push({ ...(o.language ? { language: o.language } : {}), ...(o.prompt ? { prompt: o.prompt } : {}) }); return 'عايز dress احمر'; } });
    try {
      const ws = W(60);
      const pn = await setup(ws);
      await say(ws, pn, audioMsg('media-v60'), graphWith(ogg(4_000)));
      expect(seen).toEqual([{ language: 'ar', prompt: EGYPTIAN_STT_PROMPT }]);
      expect(EGYPTIAN_STT_PROMPT).toMatch(/المصرية/);
      expect(EGYPTIAN_STT_PROMPT).not.toMatch(/\d{5,}|@/); // a fixed phrase: no number, mail or customer data
      const calls: unknown[] = [];
      const t = workersAiTranscriber({ AI: { run: async (_m: string, i: unknown) => { calls.push(i); return { text: 'x' }; } } } as never)!;
      await t(new Uint8Array([1, 2, 3]), { language: 'ar', prompt: 'p' });
      expect(calls[0]).toMatchObject({ language: 'ar', initial_prompt: 'p' });
    } finally {
      configureAgent(prev);
    }
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

// ---- review fixes (PR #74) -----------------------------------------------------------------------------------------------------

const FX = 'INSERT OR IGNORE INTO pricing_fx (src_id, ver, effective_from, egp_per_usd_micros, buffer_bps) VALUES (1, 1, 0, 50000000, 0)';
const aiPoints = (spy: { mock: { calls: unknown[][] } }, outcome: string) => spy.mock.calls.map((c) => c[0] as AnalyticsEngineDataPoint).filter((x) => x.blobs?.[0] === 'ai_turn' && x.blobs?.[2] === outcome);
const stateOf = async (ws: string, key: string) => (await rows<{ value: string }>(ws, 'SELECT value FROM store_state WHERE key = ?', key))[0]?.value;
const voiceInput = (row: { id: number }, pn: string) => ({ messageId: row.id, wamid: 'x', from: WA_1, phoneNumberId: pn, profileName: null, type: 'audio', text: null, reply: null, order: null });
const abandon = (ws: string, input: ReturnType<typeof voiceInput>) => runInDurableObject(workspace(ws), (inst) => abandonVoiceTurn((inst as unknown as { host(): never }).host(), input, Date.now()));
/** A voice note whose media never reaches R2 (the Graph download fails): the turn keeps retrying and nothing is said yet. */
const stuckVoice = async (ws: string, mediaId: string) => {
  const pn = await setup(ws);
  const g = stubGraph((c) => (c.method === 'GET' && c.url.endsWith(`/${mediaId}`) ? { status: 500, json: { error: 'down' } } : { status: 200, json: { messages: [{ id: `wamid.o.${Math.random()}` }] } }));
  await say(ws, pn, audioMsg(mediaId), g);
  return { pn, row: await inboundAudio(ws) };
};

describe('review fix 1: the length is not the customer\'s claim', () => {
  it('a forged trailing page cannot make a big file look short: the size sets a floor on the length (cap and billing)', async () => {
    expect(audioDurationMs(ogg(1_000, 3_000_000))).toBe(Math.ceil(3_000_000 / 64)); // claims 1 s, a 3 MB Opus file is at least 46.9 s
    expect(audioDurationMs(ogg(12_500))).toBe(12_500); // an honest file keeps its own length
    const ws = W(30);
    const pn = await setup(ws);
    agent.model = new ScriptedProvider([{ text: 'ok', usage: { inputTokens: 1000, outputTokens: 500 } }]);
    await exec(ws, FX);
    const ae = vi.spyOn(env.USAGE, 'writeDataPoint');
    await say(ws, pn, audioMsg('media-v30'), graphWith(ogg(1_000, 3_000_000)));
    const p = aiPoints(ae, 'reply')[0]!;
    expect(p.doubles![5]).toBe(70_975 + Math.round((46_875 / 60_000) * 25_650)); // billed by 46.9 s, not by the forged 1 s (which is 428)
  });
});

describe('review fix 2: one customer cannot burn the store\'s daily voice cap', () => {
  it('noise notes count as that customer\'s AI turns, so they stop at turnsPerDay and the store cap keeps its room', async () => {
    const ws = W(31);
    const pn = await setup(ws);
    configureAgent({ turnsPerDay: 3, transcriber: () => stt('   ').fn });
    const before = speech.calls.length;
    for (let i = 0; i < 5; i++) await say(ws, pn, audioMsg(`media-v31-${i}`), graphWith(ogg(3_000)));
    expect(await stateOf(ws, 'voice.count')).toBe('3'); // the 4th and 5th notes never reached the speech model
    expect((await rows<{ n: number }>(ws, "SELECT count(*) AS n FROM agent_handoffs WHERE reason = 'turn_cap'"))[0]!.n).toBe(1);
    expect(speech.calls.length).toBe(before); // (the swapped-in model is a different stub; the shared one is untouched)
  });
});

describe('review fix 3: an abandoned voice turn obeys the router\'s gates', () => {
  it('a conversation a person has taken over gets no bot message', async () => {
    const ws = W(32);
    const { pn, row } = await stuckVoice(ws, 'media-v32');
    await exec(ws, "INSERT INTO agent_handoffs (wa_id, started_at, until_at, reason) VALUES (?, ?, ?, 'staff')", WA_1, Date.now(), Date.now() + 3_600_000);
    await abandon(ws, voiceInput(row, pn));
    expect(await outTexts(ws)).toEqual([]);
  });
  it('a store with no package gets no bot message', async () => {
    const ws = W(33);
    const { pn, row } = await stuckVoice(ws, 'media-v33');
    await exec(ws, 'DELETE FROM entitlements');
    await abandon(ws, voiceInput(row, pn));
    expect(await outTexts(ws)).toEqual([]);
  });
  it('closed shop hours that stop the bot get no bot message', async () => {
    const ws = W(34);
    const { pn, row } = await stuckVoice(ws, 'media-v34');
    const away = { ar: 'مقفولين', en: 'closed' };
    expect((await workspace(ws).setStoreLinkSettings({ hours: { enabled: true, timezone: 'Africa/Cairo', week: { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] }, awayMessage: away, ordersWhileClosed: false } } as never)).ok).toBe(true);
    await abandon(ws, voiceInput(row, pn));
    expect(await outTexts(ws)).toEqual([]);
  });
});

describe('review fix 4: the audio is billed on every path after a model call', () => {
  const run = async (n: number, answer: Transcriber, outcome: string, model?: ScriptedProvider) => {
    const ws = W(n);
    const pn = await setup(ws);
    configureAgent({ transcriber: () => answer });
    if (model) agent.model = model;
    await exec(ws, FX);
    const ae = vi.spyOn(env.USAGE, 'writeDataPoint');
    await say(ws, pn, audioMsg(`media-v${n}`), graphWith(ogg(60_000)));
    const pts = aiPoints(ae, outcome);
    ae.mockRestore();
    return { ws, pts };
  };
  it('transcriber error', async () => {
    const { pts } = await run(40, async () => { throw new TypeError('boom'); }, 'voice_failed');
    expect(pts).toHaveLength(1);
    expect(pts[0]!.doubles![5]).toBe(25_650);
  });
  it('empty transcript', async () => {
    const { pts } = await run(41, async () => '   ', 'voice_failed');
    expect(pts).toHaveLength(1);
    expect(pts[0]!.doubles![5]).toBe(25_650);
  });
  it('the note is erased while it is being transcribed', async () => {
    const ws = W(42);
    const { pts } = await run(42, async () => { await new Promise((r) => setTimeout(r, 10)); await exec(W(42), "DELETE FROM messages WHERE direction = 'in'"); return 'كلام'; }, 'voice_gone');
    void ws;
    expect(pts).toHaveLength(1);
    expect(pts[0]!.doubles![5]).toBe(25_650);
  });
  it('the customer is erased while the language model answers (aborted turn)', async () => {
    const model = new ScriptedProvider([{ text: 'ok', usage: { inputTokens: 0, outputTokens: 0 } }]);
    const orig = model.complete.bind(model);
    model.complete = async (r) => { const out = await orig(r); await exec(W(43), "DELETE FROM messages WHERE direction = 'in'"); return out; };
    const { pts } = await run(43, async () => 'كلام', 'aborted', model);
    expect(pts).toHaveLength(1);
    expect(pts[0]!.doubles![5]).toBeGreaterThanOrEqual(25_650);
  });
});

describe('review fix 5: "couldn\'t hear you" only when transcription failed', () => {
  it('a transcribed note whose later step failed is not reported as unheard', async () => {
    const ws = W(50);
    const pn = await setup(ws);
    await say(ws, pn, audioMsg('media-v50'), graphWith(ogg(5_000)));
    const row = await inboundAudio(ws);
    expect(row.voice_state).toBe('ok');
    await exec(ws, 'DELETE FROM agent_turns'); // the turn never finished recording
    await abandon(ws, voiceInput(row, pn));
    expect(await outTexts(ws)).toEqual(['عندنا ورد بلدي متاح النهارده']); // only the earlier answer; no voiceFailed
  });
});

describe('review fix 6: the daily slot survives a retry and is given back on a failed call', () => {
  it('a retried message finds its slot already taken (no second slot) after the model ran but the transcript was never stored', async () => {
    const ws = W(51);
    const pn = await setup(ws);
    await say(ws, pn, audioMsg('media-v51'), graphWith(ogg(5_000)));
    const row = await inboundAudio(ws);
    const day = new Date().toISOString().slice(0, 10);
    expect(await stateOf(ws, 'voice.count')).toBe('1');
    // the DO was evicted after the model answered and before the transcript was stored: marker present, no voice_state, no finished turn
    await exec(ws, "UPDATE messages SET voice_state = NULL WHERE id = ?", row.id);
    await exec(ws, 'DELETE FROM agent_turns');
    await exec(ws, 'INSERT INTO store_state (key, value) VALUES (?, ?)', `voice.slot.${row.id}`, day);
    const noise = stt('   ');
    configureAgent({ transcriber: () => noise.fn });
    const { transcribeVoiceNote } = await import('../src/core/ai/transcribe');
    const v = await runInDurableObject(workspace(ws), (inst) => transcribeVoiceNote((inst as unknown as { host(): never }).host(), voiceInput(row, pn) as never, 'ar'));
    expect(v.kind).toBe('failed'); // (silence keeps the test off the search index, which the first run already filled)
    expect(noise.calls).toHaveLength(1); // the model ran again (its first answer was lost with the eviction), but under the slot already taken
    expect(await stateOf(ws, 'voice.count')).toBe('1'); // not 2
    expect(await stateOf(ws, `voice.slot.${row.id}`)).toBeUndefined();
  });
  it('a call that threw gives its slot back', async () => {
    const ws = W(52);
    const pn = await setup(ws);
    configureAgent({ transcriber: () => stt(new Error('down')).fn });
    await say(ws, pn, audioMsg('media-v52'), graphWith(ogg(5_000)));
    expect(await stateOf(ws, 'voice.count')).toBe('0');
    expect((await rows(ws, "SELECT key FROM store_state WHERE key LIKE 'voice.slot.%'"))).toEqual([]);
  });
});

describe('review fix 7: the speech call has a time limit', () => {
  it('a model that never answers is cut off: the customer is asked to type and the turn lock is free for the next message', async () => {
    const ws = W(53);
    const pn = await setup(ws);
    configureAgent({ transcriber: () => stt('نص متأخر', 400).fn });
    const was = VOICE_TIMEOUT.ms;
    VOICE_TIMEOUT.ms = 30;
    try {
      await say(ws, pn, audioMsg('media-v53'), graphWith(ogg(5_000)));
    } finally {
      VOICE_TIMEOUT.ms = was;
    }
    expect((await inboundAudio(ws)).voice_state).toBe('failed');
    expect(await outTexts(ws)).toEqual([EBDA_AGENT_COPY.t.voiceFailed.ar]);
    expect(await stateOf(ws, 'voice.count')).toBe('0'); // timed out: slot given back
    agent.model = new ScriptedProvider([{ text: 'تمام' }]);
    expect((await say(ws, pn, text('عايز ورد'), stubGraph()))).toHaveLength(1); // the lock was released
  });
});

describe('review fix 8: a voice note whose media is not stored yet is retried quickly, once', () => {
  it('the retry ladder: quick first retry only for that case', () => {
    expect(retryDelayMs(new QuickRetryError('x', 5_000), 1)).toBe(5_000);
    expect(retryDelayMs(new QuickRetryError('x', 5_000), 2)).toBe(60_000);
    expect(retryDelayMs(new Error('x'), 1)).toBe(30_000);
    expect(retryDelayMs(new Error('x'), 3)).toBe(120_000);
  });
  it('the first bot_turn retry is due within seconds, not 30 s', async () => {
    const ws = W(54);
    await stuckVoice(ws, 'media-v54');
    const t = (await rows<{ attempts: number; due_at: number }>(ws, "SELECT attempts, due_at FROM scheduled_tasks WHERE kind = 'bot_turn'"))[0]!;
    expect(t.attempts).toBe(1);
    expect(t.due_at - Date.now()).toBeLessThanOrEqual(6_000);
  });
});
