/**
 * InstaPay auto-confirm, step 1 (C2): read a payment proof into the shared typed extract on Workers AI.
 *
 * The model ONLY fills a typed object (amount, recipient handle, date, time, reference, looksEdited, confidence); the foundation validator decides what is
 * usable and plain code (instapay-auto.ts) decides everything else. Text inside the picture is never an instruction: the prompt says so, the schema
 * allows no other key, and `parseReceiptExtraction` drops extra keys and nulls the extract if a field looks like an instruction.
 * Every failure (no binding, a PDF, timeout, bad JSON) is `null`: the request waits for a person, exactly as before this feature.
 */
import { INSTAPAY_EXTRACT_JSON_SCHEMA, INSTAPAY_EXTRACT_PROMPT, parseReceiptExtraction, type ParsedExtraction } from '../../../foundation/instapay-extract';
import type { Env } from '../../env';

export const READ_TIMEOUT_MS = 25_000;
/** A vision-capable Workers AI model with JSON output (the same default the Store uses for its receipts); `INSTAPAY_RECEIPT_AI_MODEL` overrides it per deployment. */
export const READER_MODEL_DEFAULT = '@cf/mistralai/mistral-small-3.1-24b-instruct';

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** What Workers AI answered, as the JSON value (`{response}`, a chat completion, or the object itself). Throws on anything that is not JSON. */
export function unwrapAnswer(out: unknown): unknown {
  const pick = (v: unknown): unknown => {
    if (typeof v !== 'string') return v;
    const m = /\{[\s\S]*\}/.exec(v);
    if (!m) throw new Error('no json');
    return JSON.parse(m[0]);
  };
  const o = out as Record<string, unknown> | null;
  if (o && typeof o === 'object') {
    if ('response' in o) return pick(o.response);
    const choices = o.choices as Array<{ message?: { content?: unknown } }> | undefined;
    if (Array.isArray(choices) && choices[0]?.message) return pick(choices[0].message.content);
  }
  return pick(out);
}

/** Is the vision model reachable at all (the binding exists)? Auto-confirm refuses to run without it. */
export const proofReaderAvailable = (env: Env): boolean => !!env.AI;

/** The typed extract of a proof image, or null when it cannot be read (the caller treats null as "needs a person"). */
export async function readProofForAutoConfirm(env: Env, bytes: ArrayBuffer, mime: string): Promise<ParsedExtraction | null> {
  if (!env.AI || !/^image\/(jpeg|png|webp)$/.test(mime) || bytes.byteLength === 0) return null; // a PDF cannot go to the vision model
  const model = (env.INSTAPAY_RECEIPT_AI_MODEL ?? '').trim() || READER_MODEL_DEFAULT;
  try {
    const out = await Promise.race([
      env.AI.run(model as never, {
        messages: [{ role: 'user', content: [{ type: 'text', text: INSTAPAY_EXTRACT_PROMPT }, { type: 'image_url', image_url: { url: `data:${mime};base64,${toBase64(new Uint8Array(bytes))}` } }] }],
        guided_json: INSTAPAY_EXTRACT_JSON_SCHEMA,
        max_tokens: 300,
        temperature: 0,
      } as never),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), READ_TIMEOUT_MS)),
    ]);
    return parseReceiptExtraction(unwrapAnswer(out));
  } catch {
    return null;
  }
}
