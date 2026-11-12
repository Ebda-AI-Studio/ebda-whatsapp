/**
 * Voice notes for the AI agent. An inbound `audio` message is read from R2 (the media task already stored it), transcribed once with Workers AI
 * speech-to-text, and the transcript is kept as the message's own text (same search, retention, erasure and backup path as typed text).
 *
 * Fail-closed: every path that cannot produce a transcript marks the message `voice_state = 'failed'` (the inbox says "not transcribed") and tells the
 * caller, which asks the customer to type. Nothing here logs a token, the audio or the transcript; an alert carries an error class only.
 * Idempotent: `voice_state` is the once-marker, so a webhook retry or a replayed task never calls the model again for the same message.
 */
import type { Env } from '../../env';
import { alert, errClass } from '../observability';
import type { BotInput } from '../ordering/bot';
import type { LinkHost } from '../store-link/host';
import { agentConfig } from './config';

/** Cloudflare Workers AI (verified 2026-11-12, developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo): input `audio` base64, optional `language`, output `{ text }`. */
export const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';
export const VOICE_MAX_MS = 120_000;
export const VOICE_MAX_BYTES = 5 * 1024 * 1024;
export const VOICE_DEFAULT_DAILY_CAP = 60;
/** The transcript stays inline (never an R2 body), so it is cut at the inline limit (1 KB). */
const TRANSCRIPT_MAX_BYTES = 1024;
/** Audio whose length cannot be read (not Ogg/Opus) is judged at 16 KB/s, 128 kbps: generous for speech, so only long files are refused. */
const UNKNOWN_BYTES_PER_MS = 16;

export type Transcriber = (audio: Uint8Array, opts: { language?: 'ar' | 'en' }) => Promise<string>;

/** Workers AI whisper through the AI binding; null when the binding is absent (then every voice note fails closed). */
export function workersAiTranscriber(env: Pick<Env, 'AI'>): Transcriber | null {
  const ai = env.AI;
  if (!ai) return null;
  return async (audio, opts) => {
    const out = (await ai.run(STT_MODEL, { audio: toBase64(audio), ...(opts.language ? { language: opts.language } : {}) })) as { text?: unknown };
    if (typeof out?.text !== 'string') throw new Error('transcription answer malformed');
    return out.text;
  };
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Exact length of an Ogg/Opus file (WhatsApp voice notes) from the last page's granule position (48 kHz samples); null when it is not readable that way. */
export function oggOpusDurationMs(b: Uint8Array): number | null {
  const at = (i: number) => b[i] === 0x4f && b[i + 1] === 0x67 && b[i + 2] === 0x67 && b[i + 3] === 0x53; // "OggS"
  if (b.length < 27 || !at(0)) return null;
  for (let i = b.length - 27; i > 0; i--) {
    if (!at(i)) continue;
    let g = 0n;
    for (let k = 7; k >= 0; k--) g = (g << 8n) | BigInt(b[i + 6 + k]!);
    if (g === 0xffffffffffffffffn) return null;
    return Number(g / 48n);
  }
  return null;
}

export const audioDurationMs = (b: Uint8Array): number => oggOpusDurationMs(b) ?? Math.round(b.length / UNKNOWN_BYTES_PER_MS);

/** The transcript cut to the inline limit on a character boundary. */
export function fitTranscript(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  const enc = new TextEncoder();
  if (enc.encode(t).byteLength <= TRANSCRIPT_MAX_BYTES) return t;
  let out = '';
  let n = 0;
  for (const ch of t) {
    n += enc.encode(ch).byteLength;
    if (n > TRANSCRIPT_MAX_BYTES) break;
    out += ch;
  }
  return out.trimEnd();
}

export type VoiceResult =
  | { kind: 'text'; text: string; audioMs: number }
  | { kind: 'declined'; why: 'too_long' | 'too_big' | 'daily_cap' }
  | { kind: 'failed' }
  | { kind: 'gone' };

const dailyCap = (env: Pick<Env, 'VOICE_DAILY_CAP'>): number => {
  const n = Number(env.VOICE_DAILY_CAP);
  return Number.isInteger(n) && n > 0 ? n : VOICE_DEFAULT_DAILY_CAP;
};

type VoiceRow = { media_r2_key: string | null; media_size: number | null; voice_state: string | null; body: string | null; preview: string | null };

/** Counts one transcription against today's (UTC) cap for the workspace. False = the cap is reached. Synchronous, so concurrent turns cannot overshoot. */
function takeDailySlot(host: LinkHost, now: number): boolean {
  const day = new Date(now).toISOString().slice(0, 10);
  const get = (k: string) => host.sql.exec<{ value: string }>('SELECT value FROM store_state WHERE key = ?', k).toArray()[0]?.value;
  const used = get('voice.day') === day ? Number(get('voice.count') ?? 0) : 0;
  if (used >= dailyCap(host.env)) return false;
  const put = (k: string, v: string) => host.sql.exec('INSERT INTO store_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, v);
  put('voice.day', day);
  put('voice.count', String(used + 1));
  return true;
}

/**
 * The transcript of one inbound voice note, calling the model at most once per message. Throws when the file is not in R2 yet (the media task is still
 * running; the scheduler retries the turn). `language` is the agent's configured language ('auto' sends no hint: the model detects it).
 */
export async function transcribeVoiceNote(host: LinkHost, input: BotInput, language: 'ar' | 'en' | 'auto'): Promise<VoiceResult> {
  const row = host.sql.exec<VoiceRow>('SELECT media_r2_key, media_size, voice_state, body, preview FROM messages WHERE id = ?', input.messageId).toArray()[0];
  if (!row) return { kind: 'gone' };
  if (row.voice_state === 'ok' && (row.body ?? row.preview)) return { kind: 'text', text: (row.body ?? row.preview)!, audioMs: 0 };
  if (row.voice_state === 'failed') return { kind: 'failed' };
  if (!row.media_r2_key) throw new Error('voice note is not stored yet');
  const fail = (result: VoiceResult): VoiceResult => { host.recordVoice(input.messageId, null); return result; };
  if ((row.media_size ?? 0) > VOICE_MAX_BYTES) return fail({ kind: 'declined', why: 'too_big' });
  const transcriber = agentConfig().transcriber(host.env);
  if (!transcriber) {
    alert('voice_transcribe_failed', { workspace: host.workspaceId, error: 'no_binding' });
    return fail({ kind: 'failed' });
  }
  const obj = await host.env.MEDIA.get(row.media_r2_key);
  if (!obj) return fail({ kind: 'failed' });
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (bytes.length > VOICE_MAX_BYTES) return fail({ kind: 'declined', why: 'too_big' });
  const audioMs = audioDurationMs(bytes);
  if (audioMs > VOICE_MAX_MS) return fail({ kind: 'declined', why: 'too_long' });
  if (!takeDailySlot(host, Date.now())) return fail({ kind: 'declined', why: 'daily_cap' });
  let text: string;
  try {
    text = fitTranscript(await transcriber(bytes, language === 'auto' ? {} : { language }));
  } catch (err) {
    alert('voice_transcribe_failed', { workspace: host.workspaceId, error: errClass(err) });
    return fail({ kind: 'failed' });
  }
  if (!text) return fail({ kind: 'failed' }); // silence or noise: nothing to answer
  return host.recordVoice(input.messageId, text) ? { kind: 'text', text, audioMs } : { kind: 'gone' };
}
